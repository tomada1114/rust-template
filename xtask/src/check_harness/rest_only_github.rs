//! The skills and the guide reach GitHub over REST alone: they name no `gh` command built
//! on GraphQL. A Claude Code cloud session's GitHub proxy answers GraphQL with a 403, and
//! with it every `gh` subcommand built on GraphQL and the issue-search endpoint, so a step
//! spelled with one works on a developer's machine and stops the same run in a cloud
//! session.
//!
//! Read: every `*.md` file under [`SKILLS`], recursively, and [`GUIDE`], every line (prose,
//! code spans, and code blocks alike). Not read: a skill's scripts and tests. A line scan
//! cannot see a command a script builds as an argument list, so each script's own suite
//! pins the calls it makes, against a fake `gh` that refuses any other.
//!
//! A line fails when it contains one of [`FORBIDDEN`], case-sensitively, where the
//! character before the match is not a letter, a digit, `_`, `-`, or `/` (so `though pr`
//! and a longer path ending in the same words do not match).
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` (no Markdown file under [`SKILLS`], or no [`GUIDE`]),
//! `ERR_CHECK_GRAPHQL_GH` (one per line and command).

use super::documents::markdown_files;
use super::{Input, finding, read_file};
use crate::fail::FailureDetails;

const THIS: &str = "xtask/src/check_harness/rest_only_github.rs";

/// Where the skills live: every Markdown file under it is held to REST-only calls.
const SKILLS: &str = ".claude/skills";
/// The guide every session reads, held to the same spelling.
const GUIDE: &str = "AGENTS.md";

/// What a document in scope may not name, each with what it is.
const FORBIDDEN: [(&str, &str); 6] = [
    ("gh pr ", "a pull-request subcommand, built on GraphQL"),
    ("gh issue ", "an issue subcommand, built on GraphQL"),
    ("gh repo view", "the repository view, built on GraphQL"),
    ("gh label list", "the label listing, built on GraphQL"),
    ("gh api graphql", "a GraphQL query"),
    (
        "search/issues",
        "the issue-search endpoint, refused in a cloud session",
    ),
];

/// Whether `c` could continue a longer word or path into the match.
fn joins(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// Whether `line` names `needle` as a command of its own.
fn names(line: &str, needle: &str) -> bool {
    line.match_indices(needle)
        .any(|(start, _)| !line[..start].chars().next_back().is_some_and(joins))
}

/// A finding for each forbidden command `text`, the content of `file`, names.
fn scan(file: &str, text: &str) -> Vec<FailureDetails> {
    let mut violations = Vec::new();
    for (index, line) in text.lines().enumerate() {
        for (needle, what) in FORBIDDEN {
            if !names(line, needle) {
                continue;
            }
            violations.push(finding(
                "ERR_CHECK_GRAPHQL_GH",
                format!("{file}:{} names `{}`", index + 1, needle.trim_end()),
                "every GitHub call spelled as a REST `gh api repos/{owner}/{repo}/…` call",
                format!("{} ({what})", line.trim()),
                format!(
                    "spell the step as a REST `gh api` call, and describe a refused command in words rather than naming it ({THIS} lists them)"
                ),
            ));
        }
    }
    violations
}

fn missing(what: String, expected: &str, actual: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_INPUT_MISSING",
        what,
        expected,
        actual,
        "run the check against the repository root (--root DIR)",
    )
}

/// Every forbidden command named in a skill's Markdown or in the guide.
pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let mut violations = Vec::new();
    let files = markdown_files(input.root, SKILLS);
    if files.is_empty() {
        violations.push(missing(
            format!("{SKILLS} holds no Markdown file to check"),
            "each skill's SKILL.md and references under it",
            "no *.md file there",
        ));
    }
    for file in files {
        let text = read_file(input.root, &file).unwrap_or_default();
        violations.extend(scan(&file, &text));
    }
    match read_file(input.root, GUIDE) {
        Some(text) => violations.extend(scan(GUIDE, &text)),
        None => violations.push(missing(
            format!("{GUIDE} does not exist"),
            "the guide at the root",
            "no such file",
        )),
    }
    violations
}

#[cfg(test)]
mod tests {
    use super::{GUIDE, SKILLS, run};
    use crate::check_harness::test_support::{codes, run_at};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const SKILL: &str = ".claude/skills/create-pr";

    /// The check against a tree with a clean guide whose one skill holds `files`, as
    /// (path under the skill, text).
    fn check(files: &[(&str, &str)]) -> Vec<FailureDetails> {
        let dir = temp_dir();
        write(dir.path(), GUIDE, "Fine.\n");
        for (path, text) in files {
            write(dir.path(), &format!("{SKILL}/{path}"), text);
        }
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_a_skill_spelled_in_rest_calls() {
        let found = check(&[
            (
                "SKILL.md",
                "Read it with `gh api repos/{owner}/{repo}/pulls/<pr> --jq .state`.\n",
            ),
            (
                "references/rest-calls.md",
                "GitHub GraphQL is refused, though pr numbers are fine; so is /advanced-search/issues.\n",
            ),
        ]);
        assert_eq!(found, []);
    }

    #[test]
    fn fails_on_each_command_built_on_graphql() {
        for (line, named) in [
            ("Run `gh pr checks <pr>`.", "gh pr"),
            ("Then gh issue view <n> reads it.", "gh issue"),
            ("`gh repo view --json name`", "gh repo view"),
            ("`gh label list`", "gh label list"),
            ("`gh api graphql -f query=…`", "gh api graphql"),
            ("`gh api search/issues?q=…`", "search/issues"),
        ] {
            let found = check(&[("SKILL.md", &format!("Fine.\n{line}\n"))]);
            assert_eq!(codes(&found), ["ERR_CHECK_GRAPHQL_GH"], "{line}");
            assert_eq!(
                found[0].summary,
                format!("{SKILL}/SKILL.md:2 names `{named}`")
            );
            assert!(found[0].actual.starts_with(line), "{found:?}");
        }
    }

    #[test]
    fn reads_reference_files_and_reports_every_line() {
        let found = check(&[
            ("SKILL.md", "Fine.\n"),
            (
                "references/calls.md",
                "```bash\ngh pr view <pr>\ngh issue list\n```\n",
            ),
        ]);
        assert_eq!(
            codes(&found),
            ["ERR_CHECK_GRAPHQL_GH", "ERR_CHECK_GRAPHQL_GH"]
        );
        assert!(
            found[1].summary.contains("references/calls.md:3"),
            "{found:?}"
        );
    }

    #[test]
    fn leaves_scripts_unread() {
        let found = check(&[
            ("SKILL.md", "Fine.\n"),
            ("scripts/tests/_fakegh.py", "# stands in for gh pr list\n"),
        ]);
        assert_eq!(found, []);
    }

    #[test]
    fn reads_every_skill_under_the_skills_directory() {
        let dir = temp_dir();
        write(dir.path(), GUIDE, "Fine.\n");
        write(dir.path(), &format!("{SKILLS}/one/SKILL.md"), "Fine.\n");
        write(
            dir.path(),
            &format!("{SKILLS}/two/references/calls.md"),
            "`gh pr merge <pr>`\n",
        );
        let found = run_at(dir.path(), run);
        assert_eq!(codes(&found), ["ERR_CHECK_GRAPHQL_GH"]);
        assert_eq!(
            found[0].summary,
            format!("{SKILLS}/two/references/calls.md:1 names `gh pr`")
        );
    }

    #[test]
    fn reads_the_guide() {
        let dir = temp_dir();
        write(dir.path(), &format!("{SKILL}/SKILL.md"), "Fine.\n");
        write(
            dir.path(),
            GUIDE,
            "Fine.\nThe sign-off for the `gh issue create` of each issue.\n",
        );
        let found = run_at(dir.path(), run);
        assert_eq!(codes(&found), ["ERR_CHECK_GRAPHQL_GH"]);
        assert_eq!(found[0].summary, "AGENTS.md:2 names `gh issue`");
    }

    #[test]
    fn fails_when_no_skill_holds_a_markdown_file() {
        let found = check(&[("scripts/survey.py", "# no document\n")]);
        assert_eq!(codes(&found), ["ERR_CHECK_INPUT_MISSING"]);
        assert!(found[0].summary.contains(SKILLS), "{found:?}");
    }

    #[test]
    fn fails_when_the_guide_is_absent() {
        let dir = temp_dir();
        write(dir.path(), &format!("{SKILL}/SKILL.md"), "Fine.\n");
        let found = run_at(dir.path(), run);
        assert_eq!(codes(&found), ["ERR_CHECK_INPUT_MISSING"]);
        assert!(found[0].summary.contains(GUIDE), "{found:?}");
    }
}
