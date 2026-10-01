//! `cargo xtask verify-hooks`: fails when lefthook's pre-commit hook is not installed in
//! this checkout. `just install` runs it last and `just check` first, so a clone that
//! skipped `lefthook install` is noticed before a commit bypasses the staged guard.
//!
//! Opt-outs: `ALLOW_MISSING_GIT_HOOKS=1` (a checkout that deliberately commits without
//! hooks), and CI (no one commits there). Hook locations come from
//! `git rev-parse --git-path hooks`, so worktrees and `core.hooksPath` are honoured.
//!
//! Git work tree: required; outside one it refuses.
//!
//! Errors: `ERR_HOOKS_NOT_A_REPO`, `ERR_HOOKS_CONFIG`, `ERR_HOOKS_NOT_INSTALLED`.

use std::path::Path;

use crate::context::{Context, RunOptions};
use crate::fail::{ScriptError, TaskResult};
use crate::git_env::git_env;

const OPT_OUT: &str = "ALLOW_MISSING_GIT_HOOKS";

fn is_set(value: Option<&String>) -> bool {
    value.is_some_and(|value| !matches!(value.as_str(), "" | "0" | "false"))
}

/// Whether `text` has a line starting `pre-commit`, then optional whitespace, then `:`.
fn declares_pre_commit(text: &str) -> bool {
    text.match_indices("pre-commit")
        .filter(|(at, _)| *at == 0 || text.as_bytes().get(at - 1) == Some(&b'\n'))
        .any(|(at, word)| text[at + word.len()..].trim_start().starts_with(':'))
}

pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    if is_set(context.env.get(OPT_OUT)) {
        context.log(&format!(
            "verify-hooks: skipped ({OPT_OUT} is set); commits here bypass the staged guard"
        ));
        return Ok(());
    }
    if is_set(context.env.get("CI")) {
        context.log("verify-hooks: skipped on CI, where no one commits");
        return Ok(());
    }

    let hooks = context.run(
        "git",
        &["rev-parse", "--git-path", "hooks"],
        &RunOptions {
            cwd: Some(context.root.clone()),
            env: Some(git_env(&context.env)),
            input: None,
        },
    );
    if !hooks.success() {
        return Err(ScriptError::new(
            "ERR_HOOKS_NOT_A_REPO",
            "not inside a git work tree",
            "a git checkout of this repository",
            hooks.stderr_text().trim(),
            "run from the repository root",
        ));
    }

    let config = context.root.join("lefthook.yml");
    let config_text = std::fs::read_to_string(&config).ok();
    if !config_text.as_deref().is_some_and(declares_pre_commit) {
        return Err(ScriptError::new(
            "ERR_HOOKS_CONFIG",
            "lefthook.yml declares no pre-commit hook",
            "a `pre-commit:` block in lefthook.yml",
            if config_text.is_some() {
                "lefthook.yml has no pre-commit block"
            } else {
                "no lefthook.yml"
            },
            "restore lefthook.yml from version control",
        ));
    }

    let dir = hooks.stdout_text().trim().to_owned();
    let hook = context.root.join(Path::new(&dir)).join("pre-commit");
    let hook_text = std::fs::read(&hook).ok();
    let is_lefthook = hook_text
        .as_deref()
        .is_some_and(|bytes| String::from_utf8_lossy(bytes).contains("lefthook"));
    if !is_lefthook {
        return Err(ScriptError::new(
            "ERR_HOOKS_NOT_INSTALLED",
            "lefthook's pre-commit hook is not installed",
            format!("a lefthook pre-commit hook at {}", hook.display()),
            if hook_text.is_some() {
                "a pre-commit hook that is not lefthook's"
            } else {
                "no pre-commit hook"
            },
            format!(
                "run `just install` (it runs `lefthook install`), or set {OPT_OUT}=1 to commit without hooks on purpose"
            ),
        ));
    }
    context.log("verify-hooks: lefthook's pre-commit hook is installed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tempfile::TempDir;

    use super::{declares_pre_commit, main};
    use crate::test_support::{Fake, Outcome, env_of, git, temp_dir, write};

    const LEFTHOOK_HOOK: &str = "#!/bin/sh\n# lefthook generated\ncall_lefthook run pre-commit\n";

    fn repo(hook: Option<&str>, config: Option<&str>) -> TempDir {
        let dir = temp_dir();
        git(dir.path(), &["init", "-q"]);
        write(
            dir.path(),
            "lefthook.yml",
            config.unwrap_or("pre-commit:\n  jobs: []\n"),
        );
        if let Some(hook) = hook {
            write(dir.path(), ".git/hooks/pre-commit", hook);
        }
        dir
    }

    fn verify(root: &Path, env: &[(&str, &str)]) -> Outcome {
        Fake::at(root).env(env_of(env)).task(main)
    }

    #[test]
    fn passes_when_lefthooks_pre_commit_hook_is_installed() {
        let dir = repo(Some(LEFTHOOK_HOOK), None);
        let outcome = verify(dir.path(), &[]);
        outcome.assert_ok();
        assert!(
            outcome
                .lines
                .join("\n")
                .contains("pre-commit hook is installed")
        );
    }

    #[test]
    fn fails_when_no_pre_commit_hook_is_installed() {
        let dir = repo(None, None);
        let error = verify(dir.path(), &[]).failure();
        assert_eq!(error.code(), "ERR_HOOKS_NOT_INSTALLED");
        assert_eq!(error.details.actual, "no pre-commit hook");
    }

    #[test]
    fn fails_when_the_installed_hook_is_not_lefthooks() {
        let dir = repo(Some("#!/bin/sh\necho custom\n"), None);
        let error = verify(dir.path(), &[]).failure();
        assert_eq!(error.code(), "ERR_HOOKS_NOT_INSTALLED");
        assert_eq!(
            error.details.actual,
            "a pre-commit hook that is not lefthook's"
        );
    }

    #[test]
    fn fails_when_lefthook_yml_has_no_pre_commit_block() {
        let dir = repo(Some(LEFTHOOK_HOOK), Some("pre-push:\n  jobs: []\n"));
        assert_eq!(verify(dir.path(), &[]).code(), "ERR_HOOKS_CONFIG");
    }

    #[test]
    fn fails_when_lefthook_yml_is_missing() {
        let dir = repo(Some(LEFTHOOK_HOOK), None);
        std::fs::remove_file(dir.path().join("lefthook.yml")).expect("remove");
        let error = verify(dir.path(), &[]).failure();
        assert_eq!(error.code(), "ERR_HOOKS_CONFIG");
        assert_eq!(error.details.actual, "no lefthook.yml");
    }

    #[test]
    fn fails_outside_a_git_work_tree() {
        let dir = temp_dir();
        assert_eq!(verify(dir.path(), &[]).code(), "ERR_HOOKS_NOT_A_REPO");
    }

    #[test]
    fn honours_the_allow_missing_git_hooks_opt_out() {
        let dir = repo(None, None);
        let outcome = verify(dir.path(), &[("ALLOW_MISSING_GIT_HOOKS", "1")]);
        outcome.assert_ok();
        assert!(outcome.lines.join("\n").contains("ALLOW_MISSING_GIT_HOOKS"));
    }

    #[test]
    fn does_not_treat_an_off_value_as_an_opt_out() {
        let dir = repo(None, None);
        for value in ["0", "false", ""] {
            assert_eq!(
                verify(dir.path(), &[("ALLOW_MISSING_GIT_HOOKS", value)]).code(),
                "ERR_HOOKS_NOT_INSTALLED",
                "{value:?}"
            );
        }
    }

    #[test]
    fn skips_on_ci_where_no_one_commits() {
        let dir = repo(None, None);
        let outcome = verify(dir.path(), &[("CI", "true")]);
        outcome.assert_ok();
        assert!(outcome.lines.join("\n").contains("CI"));
    }

    #[test]
    fn reads_a_pre_commit_key_at_the_start_of_any_line() {
        assert!(declares_pre_commit("pre-commit:\n"));
        assert!(declares_pre_commit("# hooks\npre-commit :\n"));
        assert!(!declares_pre_commit("  pre-commit:\n"));
        assert!(!declares_pre_commit("pre-commits: x\nx-pre-commit:\n"));
    }
}
