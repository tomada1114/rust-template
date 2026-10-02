//! `cargo xtask <task> [arguments…]`: the repository's own automation, in Rust. Never
//! shipped; `.cargo/config.toml` defines the alias, and the `just` recipes, the
//! pre-commit hook (`lefthook.yml`), and CI call it.
//!
//! Every task is a function of a [`context::Context`] (its arguments, environment,
//! repository root, a child-process runner, a logger, and standard input), so its tests
//! call it with fakes, in a temporary directory, never the real checkout. A failure
//! follows the contract in [`fail`]: the first stderr line is `ERR_<STAGE>_<WHAT>: …`,
//! then `Expected:`, `Actual:`, and `Next:`, and the process exits 1 (2 for the Claude
//! Code hook).
//!
//! Errors of its own: `ERR_XTASK_USAGE` (no task, or one it does not know).

mod apply_ruleset;
mod bootstrap;
mod check_harness;
mod check_staged;
mod clippy_guard;
mod context;
mod fail;
mod format_edited_file;
mod git_env;
mod prune_temp;
mod sync_agents;
mod sync_labels;
mod verify_bootstrap;
mod verify_hooks;

#[cfg(test)]
mod test_support;

use std::io::IsTerminal;
use std::process::ExitCode;

use context::{Context, Env};
use fail::{ScriptError, TaskResult};

/// A task's entry point.
type Task = fn(&Context<'_>) -> TaskResult;

/// A task's name, what it does, and its entry point.
type TaskEntry = (&'static str, &'static str, Task);

const TASKS: &[TaskEntry] = &[
    (
        "apply-ruleset",
        "create or update every .github/rulesets/*.json ruleset by name (a GitHub write)",
        apply_ruleset::main,
    ),
    (
        "bootstrap",
        "turn the template into a new app: rename its placeholders, remove template-only material",
        bootstrap::main,
    ),
    (
        "check-harness",
        "re-assert the harness's claims about itself (--root DIR, --check NAME)",
        check_harness::main,
    ),
    (
        "check-staged",
        "refuse secret-shaped staged paths and content (the pre-commit hook)",
        check_staged::main,
    ),
    (
        "clippy-guard",
        "run `cargo clippy …` and fail on a clippy.toml entry clippy cannot resolve",
        clippy_guard::main,
    ),
    (
        "format-edited-file",
        "format the file a Claude Code edit touched (a PostToolUse hook)",
        format_edited_file::main,
    ),
    (
        "prune-temp",
        "remove stale verify-bootstrap-* temp dirs and idle Claude Code scratchpads",
        prune_temp::main,
    ),
    (
        "sync-agents",
        "mirror .agents/skills/ into .claude/skills/ (--check, --check --staged)",
        sync_agents::main,
    ),
    (
        "sync-labels",
        "create or update the repository's labels from .github/labels.yml (a GitHub write)",
        sync_labels::main,
    ),
    (
        "verify-bootstrap",
        "bootstrap a scratch clone and fail on anything the bootstrap leaves behind",
        verify_bootstrap::main,
    ),
    (
        "verify-hooks",
        "fail when lefthook's pre-commit hook is not installed",
        verify_hooks::main,
    ),
];

fn usage(task: Option<&str>) -> ScriptError {
    let names: Vec<&str> = TASKS.iter().map(|(name, _, _)| *name).collect();
    let listed: Vec<String> = TASKS
        .iter()
        .map(|(name, about, _)| format!("{name} ({about})"))
        .collect();
    ScriptError::new(
        "ERR_XTASK_USAGE",
        task.map_or_else(
            || "no task given".to_owned(),
            |task| format!("unknown task `{task}`"),
        ),
        format!("cargo xtask <{}> [arguments…]", names.join("|")),
        task.map_or_else(|| "no arguments".to_owned(), |task| format!("`{task}`")),
        format!("run one of: {}", listed.join("; ")),
    )
}

/// The task named `task`, with the environment it runs with.
fn select(task: Option<&str>, env: Env) -> Result<(Task, Env), ScriptError> {
    let (name, _, entry) = TASKS
        .iter()
        .find(|(name, _, _)| Some(*name) == task)
        .ok_or_else(|| usage(task))?;
    let env = if *name == "clippy-guard" {
        clippy_guard::child_env(env, std::io::stdout().is_terminal())
    } else {
        env
    };
    Ok((*entry, env))
}

fn main() -> ExitCode {
    let mut words = std::env::args_os()
        .skip(1)
        .map(|word| word.to_string_lossy().into_owned());
    let task = words.next();
    let argv: Vec<String> = words.collect();
    let env = context::process_env();
    let root = context::repo_root(&env);
    let result = select(task.as_deref(), env).and_then(|(entry, env)| {
        entry(&Context {
            argv,
            env,
            root,
            run: &context::run_command,
            log: &context::log_line,
            stdin: Some(&context::read_stdin),
        })
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(error.exit_code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{TASKS, select};
    use crate::context::Env;

    #[test]
    fn names_every_task_when_none_or_an_unknown_one_is_given() {
        for task in [None, Some("bogus")] {
            let Err(error) = select(task, Env::new()) else {
                panic!("expected a usage error for {task:?}");
            };
            assert_eq!(error.code(), "ERR_XTASK_USAGE");
            for (name, _, _) in TASKS {
                assert!(error.details.expected.contains(name), "{name}");
            }
        }
    }

    #[test]
    fn selects_each_task_by_name() {
        for (name, _, _) in TASKS {
            assert!(select(Some(name), Env::new()).is_ok(), "{name}");
        }
    }
}
