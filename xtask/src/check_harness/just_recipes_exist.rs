//! Every `just <recipe>` the documents name exists, and every recipe a committed
//! `.claude/settings.json`, if one is added, permits exists, so a renamed or removed
//! recipe cannot leave a document pointing at nothing or a permission rule that can never
//! match.
//!
//! Read: every document an agent or a contributor follows —
//! [`super::documents::standing_documents`], plus `README.md`, `CONTRIBUTING.md`, and
//! `.github/PULL_REQUEST_TEMPLATE.md` — except the planning and decision records in
//! [`super::documents::UNCHECKED_DOCUMENTS`], which may name a recipe before it exists.
//! Only code is read — inline code spans (which may wrap across lines, but never across a
//! blank line) and fenced blocks — so English prose ("just to be safe") never counts. An
//! issue form is YAML whose strings GitHub renders as Markdown, so each string value is
//! read that way on its own, at its line — a `|` or `>` block from its source text, since
//! folding would join a fence's lines; a form that does not parse fails the check. A
//! token is `just` not preceded by a name character, then a recipe name (a letter or `_`,
//! then letters, digits, `_`, `-`), so `just --list` and the placeholder `just <recipe>`
//! name nothing. From a committed `.claude/settings.json`, each `permissions` rule of the
//! form `Bash(just <recipe>…)`; a hook's command is not a rule.
//!
//! The recipes are parsed from the justfile's column-0 lines: each recipe header (with or
//! without parameters, `[private]` and `_`-prefixed ones included, since `just` still runs
//! them) and each `alias`. The justfile and `AGENTS.md` are required, so a check run
//! against the wrong root fails instead of passing on nothing; every other file is
//! optional.
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` (no justfile or no `AGENTS.md`),
//! `ERR_CHECK_INPUT_UNREADABLE` (`.claude/settings.json` is not JSON, or an issue form is
//! not YAML), `ERR_CHECK_RECIPE_MISSING` (a document names an undefined recipe),
//! `ERR_CHECK_PERMISSION_RECIPE_MISSING` (a permission names one).

use std::collections::BTreeSet;

use regex::Regex;

use super::documents::standing_documents;
use super::settings_allow_list::line_holding;
use super::yaml::{self, Keys, Node, Yaml};
use super::{Input, finding, has_extension, pattern, read_file};
use crate::fail::FailureDetails;

const NOT_A_RECIPE: [&str; 6] = ["set", "export", "unexport", "import", "mod", "alias"];

fn name_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// The length of the recipe name at the start of `text`, 0 when none starts there.
fn name_len(text: &str) -> usize {
    if !text.starts_with(name_start) {
        return 0;
    }
    text.find(|c: char| !name_char(c)).unwrap_or(text.len())
}

/// The recipe and alias names a justfile defines.
pub(super) fn justfile_recipes(text: &str) -> BTreeSet<String> {
    let mut recipes = BTreeSet::new();
    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix("alias") {
            let trimmed = rest.trim_start();
            let length = name_len(trimmed);
            if trimmed.len() < rest.len()
                && length > 0
                && trimmed[length..].trim_start().starts_with(":=")
            {
                recipes.insert(trimmed[..length].to_owned());
                continue;
            }
        }
        let unexported = line
            .strip_prefix("export")
            .filter(|rest| rest.starts_with(char::is_whitespace))
            .map_or(line, str::trim_start);
        let length = name_len(unexported);
        if length > 0 && unexported[length..].trim_start().starts_with(":=") {
            continue;
        }
        let header = line.strip_prefix('@').unwrap_or(line);
        let length = name_len(header);
        let rest = &header[length..];
        let name = &header[..length];
        if length > 0
            && rest.starts_with(|c: char| c.is_whitespace() || c == ':')
            && rest.contains(':')
            && !NOT_A_RECIPE.contains(&name)
        {
            recipes.insert(name.to_owned());
        }
    }
    recipes
}

/// A `just <recipe>` token: its line and the recipe.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Found {
    line: usize,
    recipe: String,
}

/// Where, in a fenced block, `just` starts a command rather than a sentence: at the start
/// of the line, after a prompt, a comment marker, a quote, a backtick, a shell operator,
/// `--`, an environment assignment, or a command prefix — so a prompt template's "its CI
/// just failed" is prose, while `# just lint` and `mise exec -- just check` are not. Word
/// boundaries and word characters are ASCII, as in the JavaScript original.
fn command_position() -> Result<Regex, FailureDetails> {
    pattern(
        r#"(?:^|[$#>%"'`(;|&{]|--|(?-u:\b)[A-Za-z_][A-Za-z0-9_]*=\S*|(?-u:\b)(?:then|do|else|exec|time|env|xargs))$"#,
    )
}

/// `just <recipe>` tokens in `code`, whose first character is on line `line`. With
/// `commands`, only tokens in a command position count (a fenced block's lines).
fn tokens(code: &str, line: usize, commands: Option<&Regex>) -> Vec<Found> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = code[from..].find("just").map(|at| at + from) {
        from = at + 1;
        if code[..at].ends_with(name_char) {
            continue;
        }
        let after = &code[at + "just".len()..];
        let gap = after.len() - after.trim_start_matches([' ', '\t', '\n']).len();
        let length = name_len(&after[gap..]);
        if gap == 0 || length == 0 {
            continue;
        }
        from = at + "just".len() + gap + length;
        let before = &code[..at];
        if commands.is_some_and(|position| !position.is_match(before.trim_end())) {
            continue;
        }
        found.push(Found {
            line: line + before.matches('\n').count(),
            recipe: after[gap..gap + length].to_owned(),
        });
    }
    found
}

/// Tokens inside the inline code spans of one paragraph (`CommonMark` backtick runs).
fn span_tokens(paragraph: &str, first_line: usize) -> Vec<Found> {
    let mut runs = Vec::new();
    let mut at = 0;
    while let Some(start) = paragraph[at..].find('`').map(|found| found + at) {
        let length = paragraph[start..]
            .find(|c: char| c != '`')
            .unwrap_or(paragraph.len() - start);
        runs.push((start, length));
        at = start + length;
    }
    let mut found = Vec::new();
    let mut i = 0;
    while i < runs.len() {
        let (open, length) = runs[i];
        let Some(close) = (i + 1..runs.len()).find(|j| runs[*j].1 == length) else {
            i += 1;
            continue;
        };
        let start = open + length;
        let line = first_line + paragraph[..start].matches('\n').count();
        found.extend(tokens(&paragraph[start..runs[close].0], line, None));
        i = close + 1;
    }
    found
}

/// Every `just <recipe>` token in a Markdown document's code.
fn markdown_tokens(text: &str, position: &Regex) -> Vec<Found> {
    let mut found = Vec::new();
    let mut fence: Option<String> = None;
    let mut paragraph: Vec<&str> = Vec::new();
    let mut paragraph_start = 0;
    let flush = |paragraph: &mut Vec<&str>, start: usize, found: &mut Vec<Found>| {
        if !paragraph.is_empty() {
            found.extend(span_tokens(&paragraph.join("\n"), start));
        }
        paragraph.clear();
    };
    for (index, line) in text.split('\n').enumerate() {
        let number = index + 1;
        let trimmed = line.trim_start();
        let marker = ['`', '~'].into_iter().find_map(|mark| {
            let length = trimmed.find(|c: char| c != mark).unwrap_or(trimmed.len());
            (length >= 3).then(|| trimmed[..length].to_owned())
        });
        if let Some(open) = &fence {
            let closes = marker
                .as_ref()
                .is_some_and(|marker| marker.starts_with(&open[..1]) && marker.len() >= open.len());
            if closes {
                fence = None;
            } else {
                found.extend(tokens(line, number, Some(position)));
            }
            continue;
        }
        if let Some(marker) = marker {
            flush(&mut paragraph, paragraph_start, &mut found);
            fence = Some(marker);
            continue;
        }
        if line.trim().is_empty() {
            flush(&mut paragraph, paragraph_start, &mut found);
            continue;
        }
        if paragraph.is_empty() {
            paragraph_start = number;
        }
        paragraph.push(line);
    }
    flush(&mut paragraph, paragraph_start, &mut found);
    found
}

/// The source lines of the block scalar (`|` or `>`) whose first content line is
/// `lines[first]`: every line indented at least as deep, blank ones included. A folded
/// value joins its lines, so only its source keeps a fence and each line's number.
fn block_source<'a>(lines: &[&'a str], first: usize) -> Vec<&'a str> {
    let indent = |line: &str| line.len() - line.trim_start_matches(' ').len();
    let block = lines.get(first..).unwrap_or_default();
    let depth = block.first().map_or(0, |line| indent(line));
    block
        .iter()
        .take_while(|line| line.trim().is_empty() || indent(line) >= depth)
        .copied()
        .collect()
}

/// Every token in the string values of a YAML tree, each read as Markdown at its line: a
/// block scalar from its source text, any other string from its value.
fn node_tokens(node: &Node, source: &[&str], position: &Regex, found: &mut Vec<Found>) {
    match &node.value {
        Yaml::Str(text) => {
            let (first, text) = if node.is_block() {
                if text.trim().is_empty() {
                    return;
                }
                (node.line, block_source(source, node.line - 1).join("\n"))
            } else {
                (node.value_start_line(), text.clone())
            };
            found.extend(
                markdown_tokens(&text, position)
                    .into_iter()
                    .map(|token| Found {
                        line: first + token.line - 1,
                        recipe: token.recipe,
                    }),
            );
        }
        Yaml::Seq(items) => {
            for item in items {
                node_tokens(item, source, position, found);
            }
        }
        Yaml::Map(pairs) => {
            for (_, value) in pairs {
                node_tokens(value, source, position, found);
            }
        }
        Yaml::Null | Yaml::Bool(_) | Yaml::Number(_) => {}
    }
}

/// The documents whose recipe references are checked, as root-relative paths.
fn documents(input: &Input<'_>) -> Vec<String> {
    let mut paths = standing_documents(input.root);
    paths.extend(
        [
            "README.md",
            "CONTRIBUTING.md",
            ".github/PULL_REQUEST_TEMPLATE.md",
        ]
        .map(str::to_owned),
    );
    paths
}

fn settings_violations(input: &Input<'_>, recipes: &BTreeSet<String>) -> Vec<FailureDetails> {
    const PATH: &str = ".claude/settings.json";
    let Some(text) = read_file(input.root, PATH) else {
        return Vec::new();
    };
    let settings: serde_json::Value = match serde_json::from_str(&text) {
        Ok(settings) => settings,
        Err(error) => {
            return vec![finding(
                "ERR_CHECK_INPUT_UNREADABLE",
                format!("{PATH} is not JSON"),
                "a JSON object whose `permissions` lists hold the permission rules",
                error.to_string(),
                format!("fix the JSON in {PATH}"),
            )];
        }
    };
    let Some(permissions) = settings
        .get("permissions")
        .and_then(serde_json::Value::as_object)
    else {
        return Vec::new();
    };
    let mut violations = Vec::new();
    for rules in permissions.values().filter_map(serde_json::Value::as_array) {
        for rule in rules.iter().filter_map(serde_json::Value::as_str) {
            let Some(rest) = rule.strip_prefix("Bash(") else {
                continue;
            };
            let Some(after) = rest.trim_start().strip_prefix("just") else {
                continue;
            };
            let trimmed = after.trim_start();
            let length = name_len(trimmed);
            if trimmed.len() == after.len() || length == 0 {
                continue;
            }
            let recipe = &trimmed[..length];
            if recipes.contains(recipe) {
                continue;
            }
            let quoted = yaml::json_string(rule);
            violations.push(finding(
                "ERR_CHECK_PERMISSION_RECIPE_MISSING",
                format!(
                    "{PATH}:{} permits `just {recipe}`, which the justfile does not define",
                    line_holding(&text, &quoted)
                ),
                format!("every `Bash(just <recipe>…)` rule in {PATH} to name a recipe the justfile defines"),
                format!("the rule {quoted}, and no recipe or alias named `{recipe}`"),
                format!("drop or rename the rule in {PATH}, or add the recipe to the justfile (`just --list` shows them)"),
            ));
        }
    }
    violations
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let Some(justfile) = read_file(input.root, "justfile") else {
        return vec![finding(
            "ERR_CHECK_INPUT_MISSING",
            "there is no justfile",
            format!("a justfile at {}/justfile", input.root.display()),
            "no such file",
            "run the check against the repository root (--root DIR)",
        )];
    };
    if read_file(input.root, "AGENTS.md").is_none() {
        return vec![finding(
            "ERR_CHECK_INPUT_MISSING",
            "there is no AGENTS.md",
            format!(
                "the project guide at {}/AGENTS.md, whose recipe references this check reads",
                input.root.display()
            ),
            "no such file",
            "restore AGENTS.md from version control, or run the check against the repository root (--root DIR)",
        )];
    }
    let position = match command_position() {
        Ok(position) => position,
        Err(invalid) => return vec![invalid],
    };
    let recipes = justfile_recipes(&justfile);
    let mut violations = Vec::new();
    for path in documents(input) {
        let Some(text) = read_file(input.root, &path) else {
            continue;
        };
        let found = if has_extension(&path, &["md"]) {
            markdown_tokens(&text, &position)
        } else {
            match yaml::parse(&text, Keys::Unique) {
                Ok(document) => {
                    let mut found = Vec::new();
                    let source: Vec<&str> = text.split('\n').collect();
                    node_tokens(&document.root, &source, &position, &mut found);
                    found
                }
                Err(error) => {
                    violations.push(finding(
                        "ERR_CHECK_INPUT_UNREADABLE",
                        format!("{path} is not YAML"),
                        "an issue form GitHub can parse, whose string values this check reads",
                        format!("line {}: {}", error.line, error.message),
                        format!("fix the YAML in {path}"),
                    ));
                    continue;
                }
            }
        };
        for Found { line, recipe } in found {
            if recipes.contains(&recipe) {
                continue;
            }
            violations.push(finding(
                "ERR_CHECK_RECIPE_MISSING",
                format!("{path}:{line} names `just {recipe}`, which the justfile does not define"),
                "every `just <recipe>` in a document's code spans and blocks to be a recipe or alias in the justfile",
                format!("no recipe or alias named `{recipe}`"),
                format!("rename the reference in {path} to an existing recipe (`just --list`), or add the recipe to the justfile"),
            ));
        }
    }
    violations.extend(settings_violations(input, &recipes));
    violations
}

#[cfg(test)]
mod tests {
    use super::{justfile_recipes, run};
    use crate::check_harness::documents::UNCHECKED_DOCUMENTS;
    use crate::check_harness::test_support::{codes, run_at, summaries};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const JUSTFILE: &str = "set shell := [\"bash\", \"-c\"]
app_name := \"Widget\"
export FOO := \"bar\"
alias b := build

# Build it.
build:
    echo build

[private]
_helper:
    echo helper

test-fast filter:
    echo {{filter}}

release-prep version *flags:
    echo {{version}}

@quiet:
    echo quiet
";

    const AGENTS: &str = "# Guide

Run `just build`, then `just test-fast <filter>`; `just --list` lists them, and
`just <recipe>` is a placeholder. English prose is never read: just bogus-prose.
A code span may wrap: `mise exec -- just
quiet`, and `adjust nothing` is not a token.

```bash
just build        # build it
just release-prep 0.2.0
just b && just _helper
```
";

    const FORM: &str = "# Mentions just bogus-comment, which is YAML, not a code span.
name: Bug Report
body:
  - type: dropdown
    attributes:
      label: How You Got the App
      options:
        - A local build (just bogus-prose)
  - type: textarea
    attributes:
      label: Log Excerpt
      description: >
        The newest log file (`just quiet` prints
        it; `mise exec -- just
        build` makes one).
      placeholder: \"`just b`\"
";

    const SETTINGS: &str = r#"{
  "permissions": {
    "allow": ["Bash(just build)", "Bash(just test-fast:*)", "Bash(git status)", "Bash(just:*)"],
    "deny": ["Bash(just quiet)"]
  },
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "just nothing-here" }] }]
  }
}
"#;

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<FailureDetails> {
        let dir = temp_dir();
        let mut files: Vec<(String, Option<String>)> = [
            ("justfile", JUSTFILE),
            ("AGENTS.md", AGENTS),
            ("README.md", "# Readme\n\n`just quiet`\n"),
            (
                "CONTRIBUTING.md",
                "# Contributing\n\n~~~sh\njust build\n~~~\n",
            ),
            ("docs/guide.md", "Run `just build`.\n"),
            ("docs/design/system.md", "Check it with `just quiet`.\n"),
            ("CLAUDE.md", "# Claude\n\nThe hook runs `just build`.\n"),
            (
                ".claude/rules/docs.md",
                "---\npaths:\n  - docs/**\n---\n\n- Run `just build`.\n",
            ),
            (
                ".claude/agents/executor.md",
                "---\nname: executor\n---\n\nCheck with `just quiet`.\n",
            ),
            (".github/ISSUE_TEMPLATE/bug_report.yml", FORM),
            (
                ".github/ISSUE_TEMPLATE/legacy.md",
                "Attach `just build` output.\n",
            ),
            (
                ".github/ISSUE_TEMPLATE/drafts/old.yml",
                "description: `just bogus-draft`\n",
            ),
            (".github/ISSUE_TEMPLATE/notes.txt", "`just bogus-notes`\n"),
            (
                ".github/PULL_REQUEST_TEMPLATE.md",
                "## Test Plan\n\n- [ ] `just build` passes\n",
            ),
            (
                ".agents/skills/demo/SKILL.md",
                "---\nname: demo\n---\n\nRun `just build`.\n",
            ),
            (
                ".agents/skills/demo/references/more.md",
                "Iterate with `just test-fast x`.\n",
            ),
            (".agents/skills/demo/scripts/run.sh", "just not-markdown\n"),
            (".claude/settings.json", SETTINGS),
        ]
        .into_iter()
        .map(|(path, text)| (path.to_owned(), Some(text.to_owned())))
        .collect();
        for path in UNCHECKED_DOCUMENTS {
            let file = if crate::check_harness::has_extension(path, &["md"]) {
                (*path).to_owned()
            } else {
                format!("{path}/deep/x.md")
            };
            files.push((file, Some("A planned `just not-yet`.\n".to_owned())));
        }
        // Named literally too, so dropping either from UNCHECKED_DOCUMENTS fails here.
        for file in [
            "docs/architecture/roadmap.md",
            "docs/architecture/adr/0001-a-choice.md",
        ] {
            files.push((
                file.to_owned(),
                Some("A planned `just not-yet`.\n".to_owned()),
            ));
        }
        for (path, content) in overrides {
            files.retain(|(existing, _)| existing != path);
            files.push(((*path).to_owned(), content.map(str::to_owned)));
        }
        for (path, content) in files {
            if let Some(content) = content {
                write(dir.path(), &path, content);
            }
        }
        run_at(dir.path(), run)
    }

    fn line_of(text: &str, needle: &str) -> usize {
        text.split('\n')
            .position(|line| line.contains(needle))
            .expect("needle")
            + 1
    }

    fn missing(path: &str, line: usize, recipe: &str) -> String {
        format!("{path}:{line} names `just {recipe}`, which the justfile does not define")
    }

    #[test]
    fn reads_recipes_and_aliases_from_the_justfile() {
        let recipes: Vec<String> = justfile_recipes(JUSTFILE).into_iter().collect();
        assert_eq!(
            recipes,
            [
                "_helper",
                "b",
                "build",
                "quiet",
                "release-prep",
                "test-fast"
            ]
        );
        assert!(justfile_recipes("aliasb := c\nexport  X := 1\nset:\nfoo:= 1\n").is_empty());
    }

    #[test]
    fn passes_when_every_reference_exists_and_with_only_agents_md() {
        assert_eq!(check(&[]), []);
        let none = [
            (".claude/settings.json", None),
            ("README.md", None),
            ("CONTRIBUTING.md", None),
            ("CLAUDE.md", None),
            (".github/PULL_REQUEST_TEMPLATE.md", None),
        ];
        assert_eq!(check(&none), []);
    }

    #[test]
    fn fails_without_the_justfile_or_agents_md() {
        let violations = check(&[("AGENTS.md", None)]);
        assert_eq!(codes(&violations), ["ERR_CHECK_INPUT_MISSING"]);
        assert_eq!(violations[0].summary, "there is no AGENTS.md");
        assert_eq!(
            codes(&check(&[("justfile", None)])),
            ["ERR_CHECK_INPUT_MISSING"]
        );
    }

    #[test]
    fn reports_spans_chains_and_fenced_lines() {
        let agents = format!("{AGENTS}\nThen run `just bogus`.\n");
        let violations = check(&[("AGENTS.md", Some(&agents))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_RECIPE_MISSING"]);
        assert_eq!(
            summaries(&violations),
            [missing(
                "AGENTS.md",
                line_of(&agents, "`just bogus`"),
                "bogus"
            )]
        );
        let violations = check(&[("README.md", Some("`just build && just bogus-two`\n"))]);
        assert_eq!(
            summaries(&violations),
            [missing("README.md", 1, "bogus-two")]
        );
        let contributing = "# C\n\n```bash\njust build\njust bogus-three  # comment\n```\n";
        let violations = check(&[("CONTRIBUTING.md", Some(contributing))]);
        assert_eq!(
            summaries(&violations),
            [missing("CONTRIBUTING.md", 5, "bogus-three")]
        );
    }

    #[test]
    fn reads_a_fenced_line_only_where_just_starts_a_command() {
        let readme = [
            "```",
            "Its CI just failed: fix it.",
            "pnpm lint  # just bogus-comment",
            "run --verify \"just bogus-quoted\"",
            "FOO=1 just bogus-env && mise exec -- just bogus-dashes",
            "then just bogus-then",
            "\u{e9}X=1 just bogus-ascii",
            "```",
        ]
        .join("\n");
        assert_eq!(
            summaries(&check(&[("README.md", Some(&readme))])),
            [
                missing("README.md", 3, "bogus-comment"),
                missing("README.md", 4, "bogus-quoted"),
                missing("README.md", 5, "bogus-env"),
                missing("README.md", 5, "bogus-dashes"),
                missing("README.md", 6, "bogus-then"),
                missing("README.md", 7, "bogus-ascii"),
            ]
        );
        let violations = check(&[("README.md", Some("````md\n```\njust bogus-open\n"))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_RECIPE_MISSING"]);
    }

    #[test]
    fn reads_every_document_kind_but_the_planning_records() {
        for path in [
            "docs/other.md",
            "docs/design/x.md",
            "docs/architecture/overview.md",
            "CLAUDE.md",
            ".claude/rules/x.md",
            ".github/PULL_REQUEST_TEMPLATE.md",
            ".agents/skills/demo/SKILL.md",
            ".agents/skills/demo/references/deep/more.md",
            ".claude/agents/x.md",
            ".github/ISSUE_TEMPLATE/legacy.md",
        ] {
            let violations = check(&[(path, Some("Run `just bogus-four`.\n"))]);
            assert_eq!(
                summaries(&violations),
                [missing(path, 1, "bogus-four")],
                "{path}"
            );
        }
        for (path, text) in [
            (
                ".github/ISSUE_TEMPLATE/bug_report.yml",
                "description: Run `just bogus-four`.",
            ),
            (
                ".github/ISSUE_TEMPLATE/task.yaml",
                "description: Run `just bogus-four`.",
            ),
            (
                ".github/ISSUE_TEMPLATE/config.yml",
                "contact_links:\n  - about: Run `just bogus-four`.",
            ),
        ] {
            let content = format!("# Form\n{text}\n");
            let violations = check(&[(path, Some(&content))]);
            assert_eq!(
                summaries(&violations),
                [missing(path, line_of(&content, "bogus-four"), "bogus-four")]
            );
        }
    }

    #[test]
    fn reads_each_string_of_an_issue_form_at_its_own_line() {
        let form = [
            "name: Task",
            "body:",
            "  - type: markdown",
            "    attributes:",
            "      value: |",
            "        Triage first.",
            "",
            "        ```sh",
            "        just bogus-fenced",
            "        ```",
            "      label: 'Run `just bogus-quoted`'",
            "      description: >-",
            "        A span that wraps: `just",
            "        bogus-wrapped`.",
            "      options:",
            "        - just bogus-prose",
            "        - Run `just bogus-listed`",
            "      notes: >",
            "        Run this:",
            "",
            "        ```sh",
            "        just bogus-folded",
            "        ```",
            "      after: Then run `just bogus-after`.",
        ]
        .join("\n");
        let path = ".github/ISSUE_TEMPLATE/task.yml";
        let violations = check(&[(path, Some(&form))]);
        assert_eq!(
            summaries(&violations),
            [
                missing(path, 9, "bogus-fenced"),
                missing(path, 11, "bogus-quoted"),
                missing(path, 13, "bogus-wrapped"),
                missing(path, 17, "bogus-listed"),
                missing(path, 22, "bogus-folded"),
                missing(path, 24, "bogus-after"),
            ]
        );
        let violations = check(&[(
            ".github/ISSUE_TEMPLATE/bug_report.yml",
            Some("body: [\n  `just build`\n"),
        )]);
        assert_eq!(codes(&violations), ["ERR_CHECK_INPUT_UNREADABLE"]);
        assert_eq!(
            violations[0].summary,
            ".github/ISSUE_TEMPLATE/bug_report.yml is not YAML"
        );
    }

    #[test]
    fn pairs_backticks_by_run_length_within_a_paragraph() {
        let violations = check(&[(
            "README.md",
            Some("A stray ` backtick.\n\n`just bogus-five`\n"),
        )]);
        assert_eq!(
            summaries(&violations),
            [missing("README.md", 3, "bogus-five")]
        );
        let violations = check(&[(
            "README.md",
            Some("``just `x` bogus-six`` and ``just bogus-seven``\n"),
        )]);
        assert_eq!(
            summaries(&violations),
            [missing("README.md", 1, "bogus-seven")]
        );
    }

    #[test]
    fn reports_a_permission_for_a_missing_recipe() {
        let settings = SETTINGS.replace(
            "\"deny\": [",
            "\"ask\": [\"Bash(just bogus-rule --flag)\"],\n    \"deny\": [",
        );
        let violations = check(&[(".claude/settings.json", Some(&settings))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_PERMISSION_RECIPE_MISSING"]);
        assert_eq!(
            violations[0].summary,
            format!(
                ".claude/settings.json:{} permits `just bogus-rule`, which the justfile does not define",
                line_of(&settings, "bogus-rule")
            )
        );
        assert_eq!(
            codes(&check(&[(".claude/settings.json", Some("{ nope"))])),
            ["ERR_CHECK_INPUT_UNREADABLE"]
        );
        assert_eq!(
            check(&[(
                ".claude/settings.json",
                Some(r#"{ "permissions": ["Bash(just bogus)"] }"#)
            )]),
            []
        );
    }
}
