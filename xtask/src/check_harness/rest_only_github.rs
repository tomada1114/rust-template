//! The skills that reach GitHub over REST alone name no `gh` command built on GraphQL. A
//! Claude Code cloud session's GitHub proxy answers GraphQL with a 403, and with it every
//! `gh` subcommand built on GraphQL and the issue-search endpoint, so a step spelled with
//! one works on a developer's machine and stops the same run in a cloud session.
//!
//! Read: every `*.md` file under each directory in [`SCOPES`], recursively, every line
//! (prose, code spans, and code blocks alike). Not read: a skill's scripts and tests,
//! which are code and are exercised by their own suite.
//!
//! A line fails when it contains one of [`FORBIDDEN`], case-sensitively, where the
//! character before the match is not a letter, a digit, `_`, `-`, or `/` (so `though pr`
//! and a longer path ending in the same words do not match).
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` (a scope holds no Markdown file: the skill moved, and
//! the list in this file must follow it), `ERR_CHECK_GRAPHQL_GH` (one per line and
//! command).

use super::documents::markdown_files;
use super::{Input, finding, read_file};
use crate::fail::FailureDetails;

const THIS: &str = "xtask/src/check_harness/rest_only_github.rs";

/// The skill directories held to REST-only `gh api` calls. A skill joins the list once
/// its documents are rewritten to that spelling.
const SCOPES: [&str; 1] = [".claude/skills/shipping-issues"];

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

/// The check's violations under the root, for the given scopes.
fn scan(input: &Input<'_>, scopes: &[&str]) -> Vec<FailureDetails> {
    let mut violations = Vec::new();
    for scope in scopes {
        let files = markdown_files(input.root, scope);
        if files.is_empty() {
            violations.push(finding(
                "ERR_CHECK_INPUT_MISSING",
                format!("{scope} holds no Markdown file to check"),
                format!("the skill's SKILL.md and references under {scope}"),
                "no *.md file there",
                format!("restore the skill, or update SCOPES in {THIS} when it moved"),
            ));
            continue;
        }
        for file in files {
            let text = read_file(input.root, &file).unwrap_or_default();
            for (index, line) in text.lines().enumerate() {
                for (needle, what) in FORBIDDEN {
                    if !names(line, needle) {
                        continue;
                    }
                    violations.push(finding(
                        "ERR_CHECK_GRAPHQL_GH",
                        format!("{file}:{} names `{}`", index + 1, needle.trim_end()),
                        "every GitHub call in the skill spelled as a REST `gh api repos/{owner}/{repo}/…` call",
                        format!("{} ({what})", line.trim()),
                        format!(
                            "spell the step as a REST `gh api` call, and describe a refused command in words rather than naming it ({THIS} lists them)"
                        ),
                    ));
                }
            }
        }
    }
    violations
}

/// Every forbidden command named under [`SCOPES`].
pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    scan(input, &SCOPES)
}

#[cfg(test)]
mod tests {
    use super::{SCOPES, run};
    use crate::check_harness::test_support::{codes, run_at};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    /// The check against a tree whose skill holds `files`, as (path under the skill, text).
    fn check(files: &[(&str, &str)]) -> Vec<FailureDetails> {
        let dir = temp_dir();
        for (path, text) in files {
            write(dir.path(), &format!("{}/{path}", SCOPES[0]), text);
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
                format!("{}/SKILL.md:2 names `{named}`", SCOPES[0])
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
    fn fails_when_the_skill_is_absent() {
        let found = check(&[]);
        assert_eq!(codes(&found), ["ERR_CHECK_INPUT_MISSING"]);
        assert!(found[0].summary.contains(SCOPES[0]), "{found:?}");
    }
}
