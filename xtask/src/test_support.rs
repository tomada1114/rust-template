//! Shared by the tasks' unit tests: a task run against a fake context, and throwaway git
//! repositories. Nothing here touches the real checkout.

use std::cell::RefCell;
use std::path::Path;

use tempfile::TempDir;

use crate::context::{Context, Env, Run, RunOptions, process_env, run_command};
use crate::fail::{ScriptError, TaskResult};
use crate::git_env::git_env;

use crate::Task;

/// What one run of a task did: its result and every line it logged.
pub(crate) struct Outcome {
    pub(crate) result: TaskResult,
    pub(crate) lines: Vec<String>,
}

impl Outcome {
    /// The failure the task reported; panics when it succeeded.
    pub(crate) fn failure(self) -> ScriptError {
        match self.result {
            Ok(()) => panic!("expected a failure; the task logged {:?}", self.lines),
            Err(error) => error,
        }
    }

    /// The code of the failure the task reported.
    pub(crate) fn code(self) -> String {
        self.failure().details.code
    }

    /// Panics unless the task succeeded.
    pub(crate) fn assert_ok(&self) {
        if let Err(error) = &self.result {
            panic!("expected success, got:\n{error}");
        }
    }
}

/// The inputs of one task run; anything left out is empty.
pub(crate) struct Fake<'a> {
    pub(crate) root: &'a Path,
    pub(crate) argv: &'a [&'a str],
    pub(crate) env: Env,
    pub(crate) run: Option<Run<'a>>,
    pub(crate) stdin: Option<&'a str>,
}

impl<'a> Fake<'a> {
    /// A run at `root` with no arguments, an empty environment, the real process runner,
    /// and no standard input.
    pub(crate) fn at(root: &'a Path) -> Self {
        Self {
            root,
            argv: &[],
            env: Env::new(),
            run: None,
            stdin: None,
        }
    }

    pub(crate) fn argv(mut self, argv: &'a [&'a str]) -> Self {
        self.argv = argv;
        self
    }

    pub(crate) fn env(mut self, env: Env) -> Self {
        self.env = env;
        self
    }

    pub(crate) fn run(mut self, run: Run<'a>) -> Self {
        self.run = Some(run);
        self
    }

    pub(crate) fn stdin(mut self, stdin: &'a str) -> Self {
        self.stdin = Some(stdin);
        self
    }

    /// Run `task` with these inputs.
    pub(crate) fn task(self, task: Task) -> Outcome {
        let lines = RefCell::new(Vec::new());
        let log = |line: &str| lines.borrow_mut().push(line.to_owned());
        let text = self.stdin.unwrap_or_default().to_owned();
        let read = move || Ok(text.clone());
        let context = Context {
            argv: self.argv.iter().map(ToString::to_string).collect(),
            env: self.env,
            root: self.root.to_path_buf(),
            run: self.run.unwrap_or(&run_command),
            log: &log,
            stdin: self
                .stdin
                .map(|_| &read as &dyn Fn() -> Result<String, ScriptError>),
        };
        let result = task(&context);
        drop(context);
        Outcome {
            result,
            lines: lines.into_inner(),
        }
    }
}

/// An environment from name-value pairs.
pub(crate) fn env_of(pairs: &[(&str, &str)]) -> Env {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

/// This process's environment with every `GIT_*` variable stripped, as a hook-free git
/// in a throwaway repository needs.
pub(crate) fn hook_env() -> Env {
    git_env(&process_env())
}

/// A fresh temporary directory, removed when dropped.
pub(crate) fn temp_dir() -> TempDir {
    tempfile::tempdir().expect("a temporary directory")
}

/// Run git in `dir` with `GIT_*` stripped; panics when it fails.
pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
    git_with(dir, args, &hook_env())
}

/// Run git in `dir` with `env`; panics when it fails.
pub(crate) fn git_with(dir: &Path, args: &[&str], env: &Env) -> String {
    let result = run_command(
        "git",
        args,
        &RunOptions {
            cwd: Some(dir.to_path_buf()),
            env: Some(env.clone()),
            input: None,
        },
    );
    assert!(
        result.success(),
        "git {}: {}",
        args.join(" "),
        result.stderr_text()
    );
    result.stdout_text()
}

/// Write `content` to `root/path`, creating its directories.
pub(crate) fn write(root: &Path, path: &str, content: impl AsRef<[u8]>) {
    let target = root.join(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).expect("create the parent directory");
    }
    std::fs::write(target, content).expect("write the file");
}

/// A git repository with one commit, an identity, and no signing.
pub(crate) fn committed_repo() -> TempDir {
    let dir = temp_dir();
    let root = dir.path();
    git(root, &["init", "-q"]);
    git(root, &["config", "user.email", "test@example.com"]);
    git(root, &["config", "user.name", "Test"]);
    git(root, &["config", "commit.gpgsign", "false"]);
    write(root, "README.md", "hello\n");
    git(root, &["add", "README.md"]);
    git(root, &["commit", "-q", "--no-verify", "-m", "init"]);
    dir
}
