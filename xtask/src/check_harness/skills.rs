//! Every skill under `.agents/skills/` loads in both Claude Code and Codex CLI, and
//! `AGENTS.md`'s Skills table indexes exactly those skills. A skill with a stray key, a
//! mismatched name, or a value Codex CLI's strict YAML parser rejects mirrors cleanly and
//! then silently never loads; one with no row is never found by a reader.
//!
//! For each directory `.agents/skills/<dir>/` (`.claude/skills/` is its byte-identical
//! mirror, checked by `just agents-check`):
//! - `<dir>/SKILL.md` opens with a `---` line and a later `---` line closes the block; the
//!   block parses as YAML (duplicate keys rejected) into a mapping of exactly `name` and
//!   `description`. This approximates Codex CLI's own YAML parser, which this check does
//!   not run: a skill found not to load there gets a test and a rule here;
//! - `name` is a string equal to `<dir>`: lowercase letters, digits, and single hyphens,
//!   at most 64 characters (the Agent Skills format);
//! - `description` is a non-empty string of printable ASCII (tab and newline allowed), at
//!   most 1,024 characters once trailing whitespace is dropped, and neither value carries
//!   a trailing YAML comment (an unquoted ` #` silently cuts the value short);
//! - no file named `SKILL.md` exists below `<dir>/` other than `<dir>/SKILL.md`;
//! - the body after the closing `---` is at most 200 lines;
//! - nothing under `.agents/skills/` is a symbolic link (links are not followed).
//!
//! The index is the first table (lines starting with `|`) after `AGENTS.md`'s `## Skills`
//! heading and before the next heading, fenced code skipped; each row's first cell, with
//! backticks stripped, names one skill, and the rows and the directories must agree.
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` (no AGENTS.md or .agents/skills/),
//! `ERR_CHECK_INPUT_UNREADABLE` (.agents/skills is not a directory, or a path under it
//! cannot be read),
//! `ERR_CHECK_SKILL_FRONTMATTER`, `ERR_CHECK_SKILL_DESCRIPTION`, `ERR_CHECK_SKILL_NESTED`,
//! `ERR_CHECK_SKILL_BODY`, `ERR_CHECK_SKILL_SYMLINK`, `ERR_CHECK_SKILL_INDEX`.

use std::path::Path;

use super::yaml::{self, Keys, Node, Style, Yaml};
use super::{Input, finding, list_dir, read_file};
use crate::fail::FailureDetails;

const SKILLS: &str = ".agents/skills";
const MAX_DESCRIPTION: usize = 1024;
const MAX_BODY_LINES: usize = 200;
const MAX_NAME: usize = 64;
const FIX_SKILL: &str =
    "fix the skill under .agents/skills/ (the authoring-skills skill), then `just agents-sync`";

fn frontmatter_violation(dir: &str, actual: impl Into<String>) -> FailureDetails {
    finding(
        "ERR_CHECK_SKILL_FRONTMATTER",
        format!("{SKILLS}/{dir}/SKILL.md has a frontmatter that would not load as a skill"),
        format!(
            "a --- block of strict YAML holding exactly `name: {dir}` and a non-empty string `description`"
        ),
        actual,
        FIX_SKILL,
    )
}

fn description_violation(dir: &str, actual: impl Into<String>) -> FailureDetails {
    finding(
        "ERR_CHECK_SKILL_DESCRIPTION",
        format!(
            "{SKILLS}/{dir}/SKILL.md has a frontmatter value that would not load in both hosts"
        ),
        format!(
            "a printable-ASCII description of at most {MAX_DESCRIPTION} characters, and no YAML comment cutting a value short"
        ),
        actual,
        format!("{FIX_SKILL} (quote the value, or use `description: >`)"),
    )
}

fn name_shape(name: &str) -> bool {
    name.split('-').all(|part| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
}

/// The `#…` comment in `text`: a `#` at its start or after whitespace, to the line's end.
fn comment_in(text: &str) -> Option<String> {
    let at = text.char_indices().find_map(|(at, c)| {
        (c == '#' && (at == 0 || text[..at].ends_with(char::is_whitespace))).then_some(at)
    })?;
    Some(text[at..].trim_end().to_owned())
}

/// The comment after a quoted value that opens at `start` (its quote) on `lines[first]`:
/// the text after the closing quote on its line. A double-quoted value skips `\`
/// escapes; a single-quoted one reads `''` as a quote. `None` when it never closes.
fn quoted_comment(lines: &[&str], first: usize, start: usize) -> Option<String> {
    let quote = lines[first][start..].chars().next()?;
    let mut from = start + quote.len_utf8();
    for (index, line) in lines.iter().enumerate().skip(first) {
        let mut chars = line[from..]
            .char_indices()
            .map(|(at, c)| (at + from, c))
            .peekable();
        while let Some((at, c)) = chars.next() {
            let escaped = (quote == '"' && c == '\\')
                || (quote == '\''
                    && c == quote
                    && chars.peek().is_some_and(|(_, next)| *next == '\''));
            if escaped {
                chars.next();
            } else if c == quote {
                return comment_in(&lines[index][at + c.len_utf8()..]);
            }
        }
        from = 0;
    }
    None
}

/// The comment a YAML parser would attach after a top-level block-mapping value, whose
/// key is on `lines[key]` and whose own lines end before `lines[end]`, or `None`. A
/// comment before the value (on the key's line with the value on a later one, or on its
/// own line) and one after a plain value's last line on its own line are not attached to
/// the value, and a `#` inside quotes or a block scalar's content is text.
fn value_comment(lines: &[&str], key: usize, end: usize, value: &Node) -> Option<String> {
    let region = lines.get(key..end.max(key + 1).min(lines.len()))?;
    let first = *region.first()?;
    let colon = first.find(':')? + 1;
    let rest = &first[colon..];
    match value.style {
        Style::Literal | Style::Folded => {
            let header = rest.find(['|', '>']).map_or(rest, |at| &rest[at + 1..]);
            comment_in(header)
        }
        Style::Quoted => {
            let (line, start) = std::iter::once((0, rest, colon))
                .chain(
                    region
                        .iter()
                        .enumerate()
                        .skip(1)
                        .map(|(index, line)| (index, *line, 0)),
                )
                .find_map(|(index, text, offset)| {
                    let trimmed = text.trim_start();
                    let start = text.len() - trimmed.len() + offset;
                    (trimmed.starts_with(['"', '\''])).then_some((index, start))
                })?;
            quoted_comment(region, line, start)
        }
        Style::Plain => {
            let mut started = false;
            for text in std::iter::once(rest).chain(region.iter().skip(1).copied()) {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.starts_with('#') {
                    if started {
                        return None;
                    }
                    continue;
                }
                started = true;
                if let Some(comment) = comment_in(text) {
                    return Some(comment);
                }
            }
            None
        }
        Style::Collection => None,
    }
}

/// Checks one SKILL.md's frontmatter and body length.
fn skill_file_violations(dir: &str, text: &str) -> Vec<FailureDetails> {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.first() != Some(&"---") {
        return vec![frontmatter_violation(
            dir,
            "SKILL.md does not start with a `---` line",
        )];
    }
    let Some(close) = lines
        .iter()
        .skip(1)
        .position(|line| *line == "---")
        .map(|at| at + 1)
    else {
        return vec![frontmatter_violation(
            dir,
            "the frontmatter block is never closed with a `---` line",
        )];
    };

    let mut violations = Vec::new();
    let mut body = &lines[close + 1..];
    if body.last() == Some(&"") {
        body = &body[..body.len() - 1];
    }
    if body.len() > MAX_BODY_LINES {
        violations.push(finding(
            "ERR_CHECK_SKILL_BODY",
            format!("{SKILLS}/{dir}/SKILL.md is over the {MAX_BODY_LINES}-line body cap"),
            format!("at most {MAX_BODY_LINES} lines after the closing `---` (the target is 150)"),
            format!("{} lines", body.len()),
            "move tables, long examples, and edge cases into references/ (the authoring-skills skill), then `just agents-sync`",
        ));
    }

    let block = &lines[1..close];
    let document = match yaml::parse(&block.join("\n"), Keys::Unique) {
        Ok(document) => document,
        Err(error) => {
            let mut found = vec![frontmatter_violation(
                dir,
                format!("the block does not parse as YAML: {}", error.message),
            )];
            found.extend(violations);
            return found;
        }
    };
    let flow = block
        .iter()
        .map(|line| line.trim())
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .is_some_and(|line| line.starts_with('{'));
    let Yaml::Map(pairs) = &document.root.value else {
        let mut found = vec![frontmatter_violation(
            dir,
            "the block is not a mapping of keys",
        )];
        found.extend(violations);
        return found;
    };

    let mut name = None;
    let mut description = None;
    for (index, (key, value)) in pairs.iter().enumerate() {
        let label = key.scalar_text().unwrap_or_else(|| key.to_json());
        if label != "name" && label != "description" {
            violations.push(frontmatter_violation(
                dir,
                format!("unexpected key `{label}` (only `name` and `description` are allowed)"),
            ));
            continue;
        }
        // A flow mapping (`{name: x, description: y}`) shares its lines between keys, and
        // its values carry no comment this reads.
        let end = pairs
            .get(index + 1)
            .map_or(block.len(), |(next, _)| next.line - 1);
        let comment = if flow {
            None
        } else {
            value_comment(block, key.line - 1, end, value)
        };
        if let Some(comment) = comment {
            violations.push(description_violation(
                dir,
                format!("`{label}` is followed by a YAML comment (`{comment}`), which drops that text from the value"),
            ));
        }
        if label == "name" {
            name = Some(value);
        } else {
            description = Some(value);
        }
    }

    violations.extend(name_violation(dir, name));
    violations.extend(description_violations(dir, description));
    violations
}

/// What is wrong with the frontmatter's `name`, if anything.
fn name_violation(dir: &str, name: Option<&Node>) -> Option<FailureDetails> {
    let problem = match name.map(Node::as_str) {
        None => "no `name` key".to_owned(),
        Some(None) => "`name` is not a string".to_owned(),
        Some(Some(name)) if name != dir => {
            format!("`name` is `{name}`, but the directory is `{dir}`")
        }
        Some(Some(name)) if !name_shape(name) || name.len() > MAX_NAME => format!(
            "`name` `{name}` is not lowercase letters, digits, and single hyphens of at most {MAX_NAME} characters"
        ),
        Some(Some(_)) => return None,
    };
    Some(frontmatter_violation(dir, problem))
}

/// What is wrong with the frontmatter's `description`.
fn description_violations(dir: &str, description: Option<&Node>) -> Vec<FailureDetails> {
    let mut found = Vec::new();
    match description.map(|value| value.as_str()) {
        None => found.push(frontmatter_violation(dir, "no `description` key")),
        Some(None) => found.push(frontmatter_violation(dir, "`description` is not a string")),
        Some(Some(text)) if text.trim().is_empty() => {
            found.push(frontmatter_violation(dir, "`description` is empty"));
        }
        Some(Some(text)) => {
            let text = text.trim_end();
            if text
                .chars()
                .any(|c| c != '\t' && c != '\n' && !(' '..='~').contains(&c))
            {
                found.push(description_violation(
                    dir,
                    "`description` holds a non-ASCII or non-printable character (an em dash or a curly quote, say)",
                ));
            }
            let length = text.encode_utf16().count();
            if length > MAX_DESCRIPTION {
                found.push(description_violation(
                    dir,
                    format!("`description` is {length} characters"),
                ));
            }
        }
    }
    found
}

/// Every path under `dir` (root-relative), without following symbolic links: (path, is a
/// link, is a file).
fn walk(root: &Path, dir: &str) -> Vec<(String, bool, bool)> {
    let mut found = Vec::new();
    for (name, kind) in list_dir(root, dir) {
        let path = format!("{dir}/{name}");
        found.push((path.clone(), kind.is_symlink(), kind.is_file()));
        if kind.is_dir() {
            found.extend(walk(root, &path));
        }
    }
    found
}

fn symlink_violation(path: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_SKILL_SYMLINK",
        format!("{path} is a symbolic link"),
        "real files only under .agents/skills/ (git checks a link out as a link only where core.symlinks allows)",
        "a symbolic link",
        "replace the link with the file it points to, then `just agents-sync`",
    )
}

fn tree_violations(root: &Path, dir: &str) -> Vec<FailureDetails> {
    let top = format!("{SKILLS}/{dir}/SKILL.md");
    let mut violations = Vec::new();
    for (path, link, file) in walk(root, &format!("{SKILLS}/{dir}")) {
        if link {
            violations.push(symlink_violation(&path));
        } else if file && path.ends_with("/SKILL.md") && path != top {
            violations.push(finding(
                "ERR_CHECK_SKILL_NESTED",
                format!("{path} is a SKILL.md below a skill's top directory"),
                "SKILL.md only at .agents/skills/<dir>/SKILL.md, so a host never loads a second skill from a subdirectory",
                path.clone(),
                "rename the nested file for its content (references/<topic>.md), then `just agents-sync`",
            ));
        }
    }
    violations
}

/// The Skills table's rows as (line, name), or `None` when there is no table.
fn index_rows(agents: &str) -> Option<Vec<(usize, String)>> {
    let lines: Vec<&str> = agents.split('\n').collect();
    let start = lines.iter().position(|line| {
        line.strip_prefix("## Skills")
            .is_some_and(|rest| rest.trim().is_empty())
    })?;
    let mut fenced = false;
    let mut rows: Option<Vec<(usize, String)>> = None;
    for (index, line) in lines.iter().enumerate().skip(start + 1) {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
        }
        if fenced {
            continue;
        }
        if line.starts_with('#') {
            break;
        }
        if !line.starts_with('|') {
            if rows.is_some() {
                break;
            }
            continue;
        }
        let Some(found) = rows.as_mut() else {
            rows = Some(Vec::new());
            continue;
        };
        if line
            .chars()
            .all(|c| matches!(c, '|' | ':' | '-') || c.is_whitespace())
        {
            continue;
        }
        let cell = line.split('|').nth(1).unwrap_or_default().replace('`', "");
        found.push((index + 1, cell.trim().to_owned()));
    }
    rows
}

fn index_violation(summary: String, actual: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_SKILL_INDEX",
        summary,
        "one row in AGENTS.md's Skills table per directory under .agents/skills/, and no other rows",
        actual,
        "add, rename, or remove the row in AGENTS.md's Skills table (or the skill directory) in the same commit",
    )
}

fn index_violations(agents: &str, dirs: &[String]) -> Vec<FailureDetails> {
    let Some(rows) = index_rows(agents) else {
        return vec![index_violation(
            "AGENTS.md has no Skills table".to_owned(),
            "no table under a `## Skills` heading",
        )];
    };
    let mut violations = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for (line, name) in &rows {
        let place = format!("AGENTS.md:{line}");
        if name.is_empty() {
            violations.push(index_violation(
                format!("{place}: a Skills table row has an empty first cell"),
                "an empty first cell",
            ));
        } else if seen.contains(&name.as_str()) {
            violations.push(index_violation(
                format!("{place}: `{name}` is indexed twice"),
                &format!("a second row for `{name}`"),
            ));
        } else if !dirs.contains(name) {
            violations.push(index_violation(
                format!("{place}: `{name}` has a row but no .agents/skills/{name}/"),
                "a row for a skill that does not exist",
            ));
        }
        seen.push(name);
    }
    for dir in dirs.iter().filter(|dir| !seen.contains(&dir.as_str())) {
        violations.push(index_violation(
            format!(".agents/skills/{dir}/ has no row, `{dir}`, in AGENTS.md's Skills table"),
            "a skill no row indexes",
        ));
    }
    violations
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let agents = read_file(input.root, "AGENTS.md");
    let skills_dir = input.root.join(SKILLS);
    let mut absent = Vec::new();
    if agents.is_none() {
        absent.push("AGENTS.md".to_owned());
    }
    let skills_kind = match std::fs::symlink_metadata(&skills_dir) {
        Ok(metadata) => Some(metadata.is_dir()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return vec![finding(
                "ERR_CHECK_INPUT_UNREADABLE",
                format!("{SKILLS} cannot be read"),
                format!("{SKILLS}/ to be a readable directory"),
                error.to_string(),
                format!("fix the permissions on {SKILLS}/"),
            )];
        }
    };
    if skills_kind.is_none() {
        absent.push(format!("{SKILLS}/"));
    }
    let (Some(agents), true) = (agents, absent.is_empty()) else {
        return vec![finding(
            "ERR_CHECK_INPUT_MISSING",
            format!("{} does not exist", absent.join(" and ")),
            "AGENTS.md and .agents/skills/ under the root",
            format!("missing: {}", absent.join(", ")),
            "run the check against the repository root (--root DIR)",
        )];
    };
    if skills_kind == Some(false) {
        return vec![finding(
            "ERR_CHECK_INPUT_UNREADABLE",
            format!("{SKILLS} is not a directory"),
            format!("{SKILLS}/ to be a directory holding one directory per skill"),
            "a file or a link",
            format!("restore {SKILLS}/ from version control"),
        )];
    }

    let mut entries: Vec<(String, bool)> = list_dir(input.root, SKILLS)
        .into_iter()
        .filter(|(_, kind)| kind.is_dir() || kind.is_symlink())
        .map(|(name, kind)| (name, kind.is_symlink()))
        .collect();
    entries.sort_by(|a, b| {
        a.0.to_lowercase()
            .cmp(&b.0.to_lowercase())
            .then(a.0.cmp(&b.0))
    });

    let mut violations = Vec::new();
    for (name, link) in &entries {
        if *link {
            violations.push(symlink_violation(&format!("{SKILLS}/{name}")));
            continue;
        }
        match read_file(input.root, &format!("{SKILLS}/{name}/SKILL.md")) {
            None => violations.push(frontmatter_violation(name, "the directory has no SKILL.md")),
            Some(text) => violations.extend(skill_file_violations(name, &text)),
        }
        violations.extend(tree_violations(input.root, name));
    }
    let dirs: Vec<String> = entries.into_iter().map(|(name, _)| name).collect();
    violations.extend(index_violations(&agents, &dirs));
    violations
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::check_harness::test_support::{codes, run_at};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    fn skill(frontmatter: &str) -> String {
        format!("---\n{frontmatter}\n---\n\n# Title\n\nBody.\n")
    }

    fn index(rows: &[&str]) -> String {
        let rows: Vec<String> = rows
            .iter()
            .map(|row| format!("| {row} | Something |"))
            .collect();
        format!(
            "# Guide\n\n## Skills\n\nSkills live under `.agents/skills/`.\n\n| Skill | Load it for |\n|---|---|\n{}\n\n### Rules\n\n| Rule | Loads when you touch |\n|---|---|\n| `.claude/rules/rust.md` | Rust |\n\n## Next section\n",
            rows.join("\n")
        )
    }

    fn fixture(overrides: &[(&str, Option<&str>)]) -> tempfile::TempDir {
        let dir = temp_dir();
        let alpha =
            skill("name: alpha\ndescription: >\n  Covers alpha. Use when alpha\n  happens.");
        let beta = skill("name: \"beta\"\ndescription: \"Beta: quoted, with a colon.\" ");
        let agents = index(&["`alpha`", "`beta`"]);
        let mut files: Vec<(&str, Option<&str>)> = vec![
            ("AGENTS.md", Some(&agents)),
            (".agents/skills/alpha/SKILL.md", Some(&alpha)),
            (".agents/skills/beta/SKILL.md", Some(&beta)),
            (".agents/skills/beta/references/notes.md", Some("# Notes\n")),
        ];
        for (path, content) in overrides {
            files.retain(|(existing, _)| existing != path);
            files.push((path, *content));
        }
        for (path, content) in files {
            if let Some(content) = content {
                write(dir.path(), path, content);
            }
        }
        dir
    }

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<FailureDetails> {
        let dir = fixture(overrides);
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_on_well_formed_skills_indexed_once() {
        assert_eq!(check(&[]), []);
    }

    #[test]
    fn fails_on_each_frontmatter_fault() {
        for (content, actual) in [
            (
                skill("name: alpha\ndescription: x\npaths: src/**"),
                "unexpected key `paths`",
            ),
            (skill("name: alfa\ndescription: x"), "`name` is `alfa`"),
            (skill("description: x"), "no `name`"),
            (skill("name: alpha"), "no `description`"),
            (
                skill("name: alpha\ndescription: \"\""),
                "`description` is empty",
            ),
            (
                skill("name: alpha\ndescription: 42"),
                "`description` is not a string",
            ),
            (
                skill("name: [alpha]\ndescription: x"),
                "`name` is not a string",
            ),
            ("# Alpha\n".to_owned(), "does not start with a `---` line"),
            (
                "---\nname: alpha\ndescription: x\n".to_owned(),
                "never closed",
            ),
            (
                skill("name: alpha\ndescription: Use when: this"),
                "does not parse as YAML",
            ),
            (
                skill("name: alpha\nname: alpha\ndescription: x"),
                "does not parse as YAML",
            ),
            (skill("- alpha"), "not a mapping"),
        ] {
            let violations = check(&[(".agents/skills/alpha/SKILL.md", Some(&content))]);
            assert_eq!(
                codes(&violations),
                ["ERR_CHECK_SKILL_FRONTMATTER"],
                "{content}"
            );
            assert!(
                violations[0].actual.contains(actual),
                "{}",
                violations[0].actual
            );
        }
        let agents = index(&["`alpha`", "`beta`", "`Gamma_Skill`"]);
        let gamma = skill("name: Gamma_Skill\ndescription: x");
        let violations = check(&[
            ("AGENTS.md", Some(&agents)),
            (".agents/skills/Gamma_Skill/SKILL.md", Some(&gamma)),
        ]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_FRONTMATTER"]);
        assert!(
            violations[0]
                .actual
                .contains("lowercase letters, digits, and single hyphens")
        );
        let agents = index(&["`alpha`", "`beta`", "`empty`"]);
        let violations = check(&[
            ("AGENTS.md", Some(&agents)),
            (".agents/skills/empty/references/x.md", Some("x\n")),
        ]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_FRONTMATTER"]);
        assert!(violations[0].actual.contains("no SKILL.md"));
    }

    #[test]
    fn fails_on_a_description_that_would_not_load() {
        let content = skill("name: alpha\ndescription: Covers alpha \u{2014} and more.");
        assert_eq!(
            codes(&check(&[(".agents/skills/alpha/SKILL.md", Some(&content))])),
            ["ERR_CHECK_SKILL_DESCRIPTION"]
        );
        let at = skill(&format!(
            "name: alpha\ndescription: >\n  {}",
            "a".repeat(1024)
        ));
        assert_eq!(check(&[(".agents/skills/alpha/SKILL.md", Some(&at))]), []);
        let over = skill(&format!(
            "name: alpha\ndescription: >\n  {}",
            "a".repeat(1025)
        ));
        let violations = check(&[(".agents/skills/alpha/SKILL.md", Some(&over))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_DESCRIPTION"]);
        assert!(violations[0].actual.contains("1025 characters"));
        for content in [
            skill("name: alpha\ndescription: Use it #now to see"),
            skill("name: alpha # the name\ndescription: x"),
            skill("name: alpha\ndescription: 'quoted' # gone"),
            skill("name: alpha\ndescription: > # gone\n  text"),
            skill("name: alpha\ndescription: a plain\n  value # gone"),
        ] {
            let violations = check(&[(".agents/skills/alpha/SKILL.md", Some(&content))]);
            assert_eq!(
                codes(&violations),
                ["ERR_CHECK_SKILL_DESCRIPTION"],
                "{content}"
            );
            assert!(violations[0].actual.contains("comment"));
        }
        let content = skill("name: alpha\ndescription: >\n  A # inside a block is text.");
        assert_eq!(
            check(&[(".agents/skills/alpha/SKILL.md", Some(&content))]),
            []
        );
    }

    #[test]
    fn reads_comments_only_where_a_yaml_parser_attaches_them() {
        let comment_of = |frontmatter: &str| {
            let content = skill(frontmatter);
            check(&[(".agents/skills/alpha/SKILL.md", Some(&content))])
                .into_iter()
                .find(|found| found.actual.contains("YAML comment"))
                .map(|found| found.actual)
        };
        for frontmatter in [
            "name: alpha\ndescription: \"Use when a lint fires,\n  even with #[allow] or #[expect].\"",
            "name: alpha\ndescription: \"it's #x\n  still text\"",
            "name: alpha\ndescription: 'it''s # text'",
            "name: alpha\ndescription: \"a \\\" # quoted\"",
            "name: alpha\ndescription: # a note before the value\n  Covers alpha.",
            "name: alpha\ndescription: Covers alpha.\n  # an own-line comment",
            "{name: alpha, description: Covers alpha.}",
            "{name: alpha,\n description: Covers alpha.}",
        ] {
            assert_eq!(comment_of(frontmatter), None, "{frontmatter}");
        }
        for (frontmatter, comment) in [
            ("name: \"alpha\" # it's\ndescription: x", "# it's"),
            (
                "name: alpha\ndescription: \"first\n  second\" # gone",
                "# gone",
            ),
            ("name: alpha\ndescription: 'a ''b''' # gone", "# gone"),
            ("name: alpha\ndescription:\n  text # gone", "# gone"),
        ] {
            let found = comment_of(frontmatter).unwrap_or_default();
            assert!(
                found.contains(&format!("(`{comment}`)")),
                "{frontmatter}: {found}"
            );
        }
    }

    #[test]
    fn fails_when_the_skills_path_or_a_skill_cannot_be_read() {
        let dir = temp_dir();
        let agents = index(&[]);
        write(dir.path(), "AGENTS.md", &agents);
        write(dir.path(), ".agents/skills", "not a directory\n");
        let found = run_at(dir.path(), run);
        assert_eq!(codes(&found), ["ERR_CHECK_INPUT_UNREADABLE"]);
        assert!(found[0].summary.contains("not a directory"), "{found:?}");

        let dir = fixture(&[]);
        let file = dir.path().join(".agents/skills/alpha/SKILL.md");
        let mut permissions = std::fs::metadata(&file).expect("metadata").permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o000);
        std::fs::set_permissions(&file, permissions).expect("chmod");
        // Root reads a mode-000 file, so the case holds only for an ordinary user.
        if std::fs::read(&file).is_err() {
            let found = run_at(dir.path(), run);
            assert!(
                codes(&found).contains(&"ERR_CHECK_INPUT_UNREADABLE".to_owned()),
                "{found:?}"
            );
        }
    }

    #[test]
    fn fails_on_a_nested_skill_and_a_long_body() {
        let nested = skill("name: alpha\ndescription: x");
        let violations = check(&[(".agents/skills/beta/references/SKILL.md", Some(&nested))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_NESTED"]);
        assert!(
            violations[0]
                .summary
                .contains(".agents/skills/beta/references/SKILL.md")
        );
        let body = |lines: usize| {
            (0..lines)
                .map(|i| format!("line {i}"))
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        };
        let at = format!("---\nname: alpha\ndescription: x\n---\n{}", body(200));
        assert_eq!(check(&[(".agents/skills/alpha/SKILL.md", Some(&at))]), []);
        let over = format!("---\nname: alpha\ndescription: x\n---\n{}", body(201));
        let violations = check(&[(".agents/skills/alpha/SKILL.md", Some(&over))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_BODY"]);
        assert!(violations[0].actual.contains("201 lines"));
        let bad = format!("---\nname: alpha\nname: x\n---\n{}", body(201));
        let violations = check(&[(".agents/skills/alpha/SKILL.md", Some(&bad))]);
        assert_eq!(
            codes(&violations),
            ["ERR_CHECK_SKILL_FRONTMATTER", "ERR_CHECK_SKILL_BODY"]
        );
    }

    #[test]
    fn fails_on_a_symlinked_file_or_skill_directory() {
        let dir = fixture(&[]);
        let root = dir.path();
        std::os::unix::fs::symlink(
            root.join(".agents/skills/beta/references/notes.md"),
            root.join(".agents/skills/alpha/link.md"),
        )
        .expect("link");
        let violations = run_at(root, run);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_SYMLINK"]);
        assert!(
            violations[0]
                .summary
                .contains(".agents/skills/alpha/link.md")
        );

        let agents = index(&["`alpha`", "`beta`", "`gamma`"]);
        let dir = fixture(&[("AGENTS.md", Some(&agents))]);
        let root = dir.path();
        std::os::unix::fs::symlink(
            root.join(".agents/skills/alpha"),
            root.join(".agents/skills/gamma"),
        )
        .expect("link");
        assert_eq!(codes(&run_at(root, run)), ["ERR_CHECK_SKILL_SYMLINK"]);
    }

    #[test]
    fn fails_when_the_index_and_the_directories_disagree() {
        let violations = check(&[("AGENTS.md", Some(&index(&["`alpha`"])))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_INDEX"]);
        assert!(violations[0].summary.contains("`beta`"));
        let agents = index(&["`alpha`", "`beta`", "`ghost`"]);
        let violations = check(&[("AGENTS.md", Some(&agents))]);
        let line = agents
            .split('\n')
            .position(|l| l.contains("ghost"))
            .expect("row")
            + 1;
        assert!(violations[0].summary.contains(&format!("AGENTS.md:{line}")));
        let violations = check(&[("AGENTS.md", Some(&index(&["`alpha`", "`beta`", "alpha"])))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_INDEX"]);
        assert!(violations[0].actual.contains("second row"));
        let violations = check(&[("AGENTS.md", Some(&index(&["`alpha`", "`beta`", " "])))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_INDEX"]);
        let none = "# Guide\n\n## Skills\n\nNone yet.\n\n## Rules\n\n| a | b |\n|---|---|\n| `alpha` | x |\n";
        let violations = check(&[("AGENTS.md", Some(none))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_INDEX"]);
        assert!(violations[0].actual.contains("no table"));
        let fenced = index(&["`alpha`", "`beta`"]).replace(
            "Skills live under",
            "```bash\n# a comment, not a heading\n```\n\nSkills live under",
        );
        assert_eq!(check(&[("AGENTS.md", Some(&fenced))]), []);
    }

    #[test]
    fn fails_when_an_input_is_missing() {
        assert_eq!(
            codes(&check(&[("AGENTS.md", None)])),
            ["ERR_CHECK_INPUT_MISSING"]
        );
        let dir = temp_dir();
        write(dir.path(), "AGENTS.md", index(&[]));
        assert_eq!(codes(&run_at(dir.path(), run)), ["ERR_CHECK_INPUT_MISSING"]);
    }
}
