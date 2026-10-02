//! `cargo xtask check-harness`: re-asserts the harness's claims about itself (`just
//! check-harness`, part of `just check` and CI's `Repo Lint & Harness` job). Each claim is
//! one module below with a `run` that returns its violations (empty when the claim holds),
//! listed in [`CHECKS`]; every check runs, and each violation is printed, before the run
//! fails.
//!
//! ```text
//! cargo xtask check-harness                       every check against this checkout
//! cargo xtask check-harness --root DIR            every check against another tree
//! cargo xtask check-harness --check NAME [...]    only the named checks
//! ```
//!
//! A check reads files under the root with real parsers (YAML through [`yaml`], TOML
//! through the `toml` crate, JSON through `serde_json`) and never writes. A violation's
//! code is `ERR_CHECK_<WHAT>`, printed as the four-line report under the check's `FAIL`
//! line.
//!
//! Git work tree: not required; ruleset-contexts reads origin/HEAD when the root is the top
//! of one.
//!
//! Errors: `ERR_CHECK_USAGE` (bad arguments, an unknown check, a root that is not a
//! directory), `ERR_HARNESS_FAILED` (a check found violations), and, printed under the
//! check it stopped, `ERR_CHECK_PATTERN_INVALID` (a check's own regex does not compile: a
//! bug in the check, never a finding about the repository).

mod advisory_ignores_agree;
mod bots_agree;
mod bundle_identifier;
mod clippy_allow_invalid;
mod core_boundary;
mod documents;
mod expressions;
mod ignore_lists_agree;
mod just_check_matches_ci;
mod just_recipes_exist;
mod labels_declared;
mod no_issue_references;
mod product_section;
mod ruleset_contexts;
mod settings_allow_list;
mod skills;
#[cfg(test)]
mod workflow_fixtures;
mod workflow_hygiene;
mod workflow_write_scopes;
mod workflows;
mod yaml;

use std::path::{Path, PathBuf};

use crate::context::{Context, Env, Run};
use crate::fail::{FailureDetails, ScriptError, TaskResult};

/// What a check reads: the root, and for the two checks that run a child process
/// (`cargo metadata`, `git`), the runner and the environment.
pub(crate) struct Input<'a> {
    pub(crate) root: &'a Path,
    pub(crate) run: Run<'a>,
    pub(crate) env: &'a Env,
}

/// A check's entry point: every violation of its claim under the root.
type CheckFn = fn(&Input<'_>) -> Vec<FailureDetails>;

/// Every check, by name, in the order they run.
const CHECKS: [(&str, CheckFn); 16] = [
    ("advisory-ignores-agree", advisory_ignores_agree::run),
    ("bots-agree", bots_agree::run),
    ("bundle-identifier", bundle_identifier::run),
    ("clippy-allow-invalid", clippy_allow_invalid::run),
    ("core-boundary", core_boundary::run),
    ("ignore-lists-agree", ignore_lists_agree::run),
    ("just-check-matches-ci", just_check_matches_ci::run),
    ("just-recipes-exist", just_recipes_exist::run),
    ("labels-declared", labels_declared::run),
    ("no-issue-references", no_issue_references::run),
    ("product-section", product_section::run),
    ("ruleset-contexts", ruleset_contexts::run),
    ("settings-allow-list", settings_allow_list::run),
    ("skills", skills::run),
    ("workflow-hygiene", workflow_hygiene::run),
    ("workflow-write-scopes", workflow_write_scopes::run),
];

/// A violation with its four lines.
pub(crate) fn finding(
    code: &str,
    summary: impl Into<String>,
    expected: impl Into<String>,
    actual: impl Into<String>,
    next: impl Into<String>,
) -> FailureDetails {
    FailureDetails {
        code: code.to_owned(),
        summary: summary.into(),
        expected: expected.into(),
        actual: actual.into(),
        next: next.into(),
    }
}

/// A file under the root as text (invalid UTF-8 replaced), or `None` when it is not a
/// regular file there.
pub(crate) fn read_file(root: &Path, path: &str) -> Option<String> {
    let full = root.join(path);
    if !full.is_file() {
        return None;
    }
    std::fs::read(full)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// A pattern a check writes as a literal, compiled. One that does not compile is a bug in
/// the check, reported as a violation so the run fails rather than matching nothing.
pub(crate) fn pattern(source: &str) -> Result<regex::Regex, FailureDetails> {
    regex::Regex::new(source).map_err(|error| {
        finding(
            "ERR_CHECK_PATTERN_INVALID",
            "a pattern in a harness check does not compile",
            "every pattern under xtask/src/check_harness/ to compile",
            first_line(&error.to_string()).to_owned(),
            "fix the pattern the error names",
        )
    })
}

/// Whether `path`'s extension is one of `extensions`, compared exactly as the files are
/// named in the repository (case-sensitive, like the tools that read them).
pub(crate) fn has_extension(path: &str, extensions: &[&str]) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extensions.contains(&extension))
}

/// The first line of a message.
pub(crate) fn first_line(message: &str) -> &str {
    message.lines().next().unwrap_or_default()
}

fn usage(summary: &str, actual: impl Into<String>) -> ScriptError {
    let names: Vec<&str> = CHECKS.iter().map(|(name, _)| *name).collect();
    ScriptError::new(
        "ERR_CHECK_USAGE",
        summary,
        "cargo xtask check-harness [--root DIR] [--check NAME]…",
        actual,
        format!(
            "pass --root with an existing directory, and --check with one of: {}",
            names.join(", ")
        ),
    )
}

/// The root and the checks the arguments name (every check when none is named).
fn parse_args(
    argv: &[String],
    fallback: &Path,
) -> Result<(PathBuf, Vec<&'static str>), ScriptError> {
    let mut root = fallback.to_path_buf();
    let mut wanted = Vec::new();
    let mut words = argv.iter();
    while let Some(word) = words.next() {
        match word.as_str() {
            "--root" => {
                let value = words
                    .next()
                    .ok_or_else(|| usage("--root needs a directory", "--root with no value"))?;
                root = std::path::absolute(value).unwrap_or_else(|_| PathBuf::from(value));
            }
            "--check" => {
                let value = words.next().ok_or_else(|| {
                    usage("--check needs a check's name", "--check with no value")
                })?;
                let name = CHECKS
                    .iter()
                    .map(|(name, _)| *name)
                    .find(|name| name == value)
                    .ok_or_else(|| usage("no such check", value.clone()))?;
                if !wanted.contains(&name) {
                    wanted.push(name);
                }
            }
            other => return Err(usage("unknown argument", other)),
        }
    }
    if !root.is_dir() {
        return Err(usage(
            "--root is not a directory",
            root.display().to_string(),
        ));
    }
    Ok((root, wanted))
}

/// Run the checks, logging `ok`/`FAIL` per check and every violation.
pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    let (root, wanted) = parse_args(&context.argv, &context.root)?;
    let input = Input {
        root: &root,
        run: context.run,
        env: &context.env,
    };
    let selected: Vec<&(&str, CheckFn)> = CHECKS
        .iter()
        .filter(|(name, _)| wanted.is_empty() || wanted.contains(name))
        .collect();
    let mut failures = 0;
    for (name, check) in &selected {
        let violations = check(&input);
        if violations.is_empty() {
            context.log(&format!("ok    {name}"));
            continue;
        }
        failures += 1;
        context.log(&format!("FAIL  {name}"));
        for violation in &violations {
            context.log(&violation.to_string());
        }
    }
    if failures > 0 {
        return Err(ScriptError::new(
            "ERR_HARNESS_FAILED",
            "a harness check found the repository contradicting itself",
            "every check under xtask/src/check_harness/ to pass",
            format!(
                "{failures} of {} checks failed (each is printed above)",
                selected.len()
            ),
            "fix what each ERR_CHECK_* line names, or run one check alone: cargo xtask check-harness --check <name>",
        ));
    }
    context.log(&format!("check-harness: {} checks passed", selected.len()));
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A check run against a temporary tree.

    use std::path::Path;

    use super::Input;
    use crate::context::{Env, RunOptions, RunResult};
    use crate::fail::FailureDetails;

    /// A runner that fails every command, for the checks that never run one.
    pub(crate) fn no_run(command: &str, _args: &[&str], _options: &RunOptions) -> RunResult {
        RunResult {
            status: None,
            started: false,
            stdout: Vec::new(),
            stderr: format!("{command}: not run in this test").into_bytes(),
        }
    }

    /// `check` against `root`, with no child process.
    pub(crate) fn run_at(
        root: &Path,
        check: fn(&Input<'_>) -> Vec<FailureDetails>,
    ) -> Vec<FailureDetails> {
        let env = Env::new();
        check(&Input {
            root,
            run: &no_run,
            env: &env,
        })
    }

    /// The codes of `violations`.
    pub(crate) fn codes(violations: &[FailureDetails]) -> Vec<String> {
        violations.iter().map(|found| found.code.clone()).collect()
    }

    /// The summaries of `violations`.
    pub(crate) fn summaries(violations: &[FailureDetails]) -> Vec<String> {
        violations
            .iter()
            .map(|found| found.summary.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{first_line, main, pattern, read_file};
    use crate::test_support::{Fake, temp_dir, write};

    /// A tree product-section passes: the template's justfile and a `TODO:` skeleton.
    fn template_tree() -> tempfile::TempDir {
        let dir = temp_dir();
        write(
            dir.path(),
            "justfile",
            concat!("bundle_id := \"com.example.", "my", "app\"\n"),
        );
        write(
            dir.path(),
            "AGENTS.md",
            "# Guide\n\n## Product\n\n- **Non-goals** — TODO: fill in.\n\n## Next\n",
        );
        dir
    }

    #[test]
    fn runs_the_named_checks_against_the_root() {
        let dir = template_tree();
        let root = dir.path().to_string_lossy().into_owned();
        let elsewhere = temp_dir();
        let argv = [
            "--check",
            "product-section",
            "--root",
            &root,
            "--check",
            "product-section",
        ];
        let outcome = Fake::at(elsewhere.path()).argv(&argv).task(main);
        outcome.assert_ok();
        assert_eq!(
            outcome.lines,
            ["ok    product-section", "check-harness: 1 checks passed"]
        );
        let outcome = Fake::at(dir.path())
            .argv(&["--check", "product-section"])
            .task(main);
        outcome.assert_ok();
    }

    #[test]
    fn fails_and_prints_every_violation() {
        let dir = template_tree();
        write(dir.path(), "AGENTS.md", "# Guide\n");
        let outcome = Fake::at(dir.path())
            .argv(&["--check", "product-section", "--check", "bundle-identifier"])
            .task(main);
        assert_eq!(
            outcome.lines.first().map(String::as_str),
            Some("FAIL  bundle-identifier")
        );
        assert!(
            outcome
                .lines
                .iter()
                .any(|line| line == "FAIL  product-section")
        );
        assert!(
            outcome
                .lines
                .iter()
                .any(|line| line.starts_with("ERR_CHECK_PRODUCT_SECTION: ")),
            "{:?}",
            outcome.lines
        );
        let failure = outcome.failure();
        assert_eq!(failure.details.code, "ERR_HARNESS_FAILED");
        assert!(
            failure.details.actual.starts_with("2 of 2 checks failed"),
            "{}",
            failure.details.actual
        );
    }

    #[test]
    fn runs_every_check_without_a_selection() {
        let dir = temp_dir();
        let outcome = Fake::at(dir.path()).task(main);
        assert!(
            outcome
                .lines
                .iter()
                .any(|line| line == "FAIL  product-section")
        );
        assert!(
            outcome
                .lines
                .iter()
                .any(|line| line == "ok    clippy-allow-invalid")
        );
        assert_eq!(outcome.code(), "ERR_HARNESS_FAILED");
    }

    #[test]
    fn rejects_bad_arguments() {
        let dir = temp_dir();
        let missing = dir.path().join("missing").to_string_lossy().into_owned();
        for argv in [
            &["--root"][..],
            &["--check"],
            &["--check", "nope"],
            &["--verbose"],
            &["--root", missing.as_str()],
        ] {
            let failure = Fake::at(dir.path()).argv(argv).task(main).failure();
            assert_eq!(failure.details.code, "ERR_CHECK_USAGE", "{argv:?}");
            assert!(failure.details.next.contains("product-section"), "{argv:?}");
        }
    }

    #[test]
    fn reads_files_and_first_lines() {
        let dir = temp_dir();
        write(dir.path(), "a.txt", b"x\xffy\nz\n");
        std::fs::create_dir(dir.path().join("sub")).expect("sub");
        assert_eq!(
            read_file(dir.path(), "a.txt").as_deref(),
            Some("x\u{fffd}y\nz\n")
        );
        assert_eq!(read_file(dir.path(), "sub"), None);
        assert_eq!(read_file(dir.path(), "none"), None);
        assert_eq!(first_line("a\nb"), "a");
        assert_eq!(first_line(""), "");
        assert!(pattern("a+").is_ok());
        let invalid = pattern("(").expect_err("an unclosed group");
        assert_eq!(invalid.code, "ERR_CHECK_PATTERN_INVALID");
    }
}
