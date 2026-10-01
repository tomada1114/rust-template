//! What a task receives from the process, gathered in one place so each task is a plain
//! function its tests call with fakes: the arguments, the environment, the repository
//! root, a function that runs a child process, a logger, and standard input.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::fail::ScriptError;

/// An environment, by variable name.
pub(crate) type Env = BTreeMap<String, String>;

/// How a child process is started.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RunOptions {
    /// The working directory; this process's when absent.
    pub(crate) cwd: Option<PathBuf>,
    /// The child's whole environment; this process's when absent.
    pub(crate) env: Option<Env>,
    /// Bytes written to the child's standard input; none (an empty, closed stdin) when
    /// absent.
    pub(crate) input: Option<Vec<u8>>,
}

/// What a child process did. Its output is captured whole, as bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RunResult {
    /// The exit status; `None` when a signal stopped it, or it never started.
    pub(crate) status: Option<i32>,
    /// Whether it started at all; when it did not, `stderr` holds why.
    pub(crate) started: bool,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

impl RunResult {
    /// A child that ran and exited with `status`.
    #[cfg(test)]
    pub(crate) fn exited(status: i32, stdout: &str, stderr: &str) -> Self {
        Self {
            status: Some(status),
            started: true,
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    /// Whether it exited 0.
    pub(crate) fn success(&self) -> bool {
        self.status == Some(0)
    }

    /// Standard output as text (invalid UTF-8 replaced).
    pub(crate) fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// Standard error as text (invalid UTF-8 replaced).
    pub(crate) fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// Runs a child process: `run(command, args, options)`.
pub(crate) type Run<'a> = &'a dyn Fn(&str, &[&str], &RunOptions) -> RunResult;

/// Everything a task reads from the process.
pub(crate) struct Context<'a> {
    pub(crate) argv: Vec<String>,
    pub(crate) env: Env,
    /// The repository root (the parent of `xtask/`).
    pub(crate) root: PathBuf,
    pub(crate) run: Run<'a>,
    pub(crate) log: &'a dyn Fn(&str),
    /// Read all of standard input; only tasks fed a payload (hooks) call it.
    pub(crate) stdin: Option<&'a dyn Fn() -> Result<String, ScriptError>>,
}

impl Context<'_> {
    /// Run a child process.
    pub(crate) fn run(&self, command: &str, args: &[&str], options: &RunOptions) -> RunResult {
        (self.run)(command, args, options)
    }

    /// Print one line to standard output.
    pub(crate) fn log(&self, line: &str) {
        (self.log)(line);
    }
}

/// Run a command to completion, capturing its output. Standard input is written from a
/// second thread, so a child that writes a lot before reading all of it cannot deadlock.
pub(crate) fn run_command(command: &str, args: &[&str], options: &RunOptions) -> RunResult {
    let mut builder = Command::new(command);
    builder.args(args);
    if let Some(cwd) = &options.cwd {
        builder.current_dir(cwd);
    }
    if let Some(env) = &options.env {
        builder.env_clear().envs(env);
    }
    builder
        .stdin(if options.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match builder.spawn() {
        Ok(child) => child,
        Err(error) => {
            return RunResult {
                status: None,
                started: false,
                stdout: Vec::new(),
                stderr: format!("{command}: {error}").into_bytes(),
            };
        }
    };
    let pipe = child.stdin.take();
    let output = std::thread::scope(|scope| {
        if let (Some(mut pipe), Some(input)) = (pipe, options.input.as_deref()) {
            // A child that exits without reading everything closes the pipe; its status
            // reports that, not this write.
            scope.spawn(move || pipe.write_all(input).is_ok());
        }
        child.wait_with_output()
    });
    match output {
        Ok(output) => RunResult {
            status: output.status.code(),
            started: true,
            stdout: output.stdout,
            stderr: output.stderr,
        },
        Err(error) => RunResult {
            status: None,
            started: true,
            stdout: Vec::new(),
            stderr: format!("{command}: {error}").into_bytes(),
        },
    }
}

/// This process's environment; a variable whose name or value is not UTF-8 is left out.
pub(crate) fn process_env() -> Env {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

/// The repository root: the parent of xtask's manifest directory. `cargo run` (which
/// `cargo xtask` is) sets `CARGO_MANIFEST_DIR` for the program it runs, so the root
/// follows the checkout cargo was run in; a binary run directly falls back to the
/// directory it was built from.
pub(crate) fn repo_root(env: &Env) -> PathBuf {
    let manifest = env
        .get("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from);
    manifest
        .parent()
        .map_or_else(|| manifest.clone(), Path::to_path_buf)
}

/// Print a line to standard output.
pub(crate) fn log_line(line: &str) {
    println!("{line}");
}

/// Read all of standard input as UTF-8.
pub(crate) fn read_stdin() -> Result<String, ScriptError> {
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|error| ScriptError::unexpected("reading standard input", &error))?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{Env, RunOptions, RunResult, repo_root, run_command};

    #[test]
    fn captures_output_and_status() {
        let result = run_command(
            "sh",
            &["-c", "printf out; printf err >&2; exit 3"],
            &RunOptions::default(),
        );
        assert_eq!(result, RunResult::exited(3, "out", "err"));
        assert!(!result.success());
    }

    #[test]
    fn feeds_standard_input_and_sets_the_directory_and_environment() {
        let dir = tempfile::tempdir().expect("temp dir");
        let env: Env = [("ONLY", "this"), ("PATH", "/usr/bin:/bin")]
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect();
        let input = "x".repeat(1024 * 1024);
        let result = run_command(
            "/bin/sh",
            &["-c", "wc -c; pwd; echo \"$ONLY:${HOME:-unset}\""],
            &RunOptions {
                cwd: Some(dir.path().to_path_buf()),
                env: Some(env),
                input: Some(input.into_bytes()),
            },
        );
        assert!(result.success(), "{}", result.stderr_text());
        let text = result.stdout_text();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.first().map(|count| count.trim()), Some("1048576"));
        let real = dir.path().canonicalize().expect("canonical");
        assert_eq!(lines.get(1).map(PathBuf::from), Some(real));
        assert_eq!(lines.get(2), Some(&"this:unset"));
    }

    #[test]
    fn reports_a_command_that_never_started() {
        let result = run_command("/definitely/not/a/command", &[], &RunOptions::default());
        assert!(!result.started);
        assert_eq!(result.status, None);
        assert!(
            result
                .stderr_text()
                .starts_with("/definitely/not/a/command: ")
        );
    }

    #[test]
    fn reports_a_signalled_child_without_a_status() {
        let result = run_command("sh", &["-c", "kill -9 $$"], &RunOptions::default());
        assert!(result.started);
        assert_eq!(result.status, None);
    }

    #[test]
    fn finds_the_root_above_the_manifest_directory() {
        let env: Env = [(
            "CARGO_MANIFEST_DIR".to_owned(),
            "/work/repo/xtask".to_owned(),
        )]
        .into_iter()
        .collect();
        assert_eq!(repo_root(&env), PathBuf::from("/work/repo"));
        assert_eq!(
            repo_root(&Env::new()),
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("a parent")
                .to_path_buf()
        );
        let bare: Env = [("CARGO_MANIFEST_DIR".to_owned(), "/".to_owned())]
            .into_iter()
            .collect();
        assert_eq!(repo_root(&bare), PathBuf::from("/"));
    }
}
