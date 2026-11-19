//! The committed `.claude/settings.json` and the `PostToolUse` wrapper it registers,
//! `.claude/hooks/format-edited-file.sh`. The settings file is read from the checkout; the
//! wrapper runs under bash from a throwaway directory with stub `cargo` and `mise` (and
//! `cat`) as the only commands on PATH, so no real toolchain is reached. A cloud session
//! reads only the committed settings file, so a hook that points at a missing script or
//! the wrong event fails on every session there and nowhere else.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;
use tempfile::TempDir;

/// The value, or a panic that names what failed: a panic is how a test fails.
fn must<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> T {
    result.unwrap_or_else(|error| panic!("{what}: {error}"))
}

fn checkout() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn settings() -> Value {
    let text = must(
        std::fs::read_to_string(checkout().join(".claude/settings.json")),
        "read .claude/settings.json",
    );
    must(serde_json::from_str(&text), "parse .claude/settings.json")
}

/// Every `(matcher, command)` pair registered for `event`.
fn hooks(settings: &Value, event: &str) -> Vec<(String, String)> {
    let groups = settings
        .pointer(&format!("/hooks/{event}"))
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("no {event} hooks"));
    groups
        .iter()
        .flat_map(|group| {
            let matcher = group
                .get("matcher")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            group
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|hook| hook.get("command").and_then(Value::as_str))
                .map(move |command| (matcher.clone(), command.to_owned()))
        })
        .collect()
}

/// The repository-relative script paths `command` names.
fn scripts(command: &str) -> Vec<String> {
    command
        .split_whitespace()
        .map(|word| word.replace('"', ""))
        .filter_map(|word| {
            word.strip_prefix("$CLAUDE_PROJECT_DIR/")
                .map(str::to_owned)
                .filter(|path| Path::new(path).extension().is_some_and(|ext| ext == "sh"))
        })
        .collect()
}

const RUST_PAYLOAD: &str = r#"{"tool_name":"Edit","tool_input":{"file_path":"/w/src/lib.rs"}}"#;

/// A throwaway project directory and a PATH of stub commands.
struct Sandbox {
    dir: TempDir,
}

impl Sandbox {
    /// `stubs` names which of `cargo` and `mise` exist; `cat` always does.
    fn new(stubs: &[&str]) -> Self {
        let dir = must(TempDir::new(), "tempdir");
        let bin = dir.path().join("bin");
        must(std::fs::create_dir_all(&bin), "mkdir bin");
        must(
            std::fs::create_dir_all(dir.path().join("project")),
            "mkdir project",
        );
        must(
            std::os::unix::fs::symlink(cat(), bin.join("cat")),
            "link cat",
        );
        for name in stubs {
            let body = match *name {
                // Records its call, then runs the wrapped command (`mise exec -- cmd …`).
                "mise" => "printf 'mise %s\\n' \"$*\" >> \"$STUB_LOG\"\nshift 2\nexec \"$@\"\n",
                // Records its call, directory, target dir, and stdin; exits $CARGO_EXIT.
                _ => {
                    "printf 'cargo %s CARGO_TARGET_DIR=%s PWD=%s\\n' \"$*\" \"${CARGO_TARGET_DIR:-}\" \"$PWD\" >> \"$STUB_LOG\"\ncat > \"$STUB_LOG.stdin\"\nexit \"${CARGO_EXIT:-0}\"\n"
                }
            };
            let path = bin.join(name);
            must(
                std::fs::write(&path, format!("#!/bin/sh\n{body}")),
                "write a stub",
            );
            let mut permissions = must(std::fs::metadata(&path), "stat").permissions();
            std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
            must(std::fs::set_permissions(&path, permissions), "chmod");
        }
        Self { dir }
    }

    fn project(&self) -> PathBuf {
        self.dir.path().join("project")
    }

    fn log(&self) -> PathBuf {
        self.dir.path().join("stub.log")
    }

    /// Runs the checkout's wrapper with `payload` on stdin; `cargo_exit` is the stub's code.
    fn run(&self, payload: &str, cargo_exit: i32) -> Run {
        let mut child = must(
            Command::new("/bin/bash")
                .arg(checkout().join(".claude/hooks/format-edited-file.sh"))
                .env_clear()
                .env("PATH", self.dir.path().join("bin"))
                .env("HOME", self.dir.path())
                .env("CLAUDE_PROJECT_DIR", self.project())
                .env("STUB_LOG", self.log())
                .env("CARGO_EXIT", cargo_exit.to_string())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn(),
            "spawn the wrapper",
        );
        let mut stdin = child.stdin.take().unwrap_or_else(|| panic!("no stdin"));
        must(stdin.write_all(payload.as_bytes()), "write the payload");
        drop(stdin);
        let output = must(child.wait_with_output(), "wait for the wrapper");
        let mut stdin_log = self.log().into_os_string();
        stdin_log.push(".stdin");
        Run {
            calls: std::fs::read_to_string(self.log())
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect(),
            cargo_stdin: std::fs::read_to_string(stdin_log).unwrap_or_default(),
            status: output.status.code(),
        }
    }
}

struct Run {
    calls: Vec<String>,
    cargo_stdin: String,
    status: Option<i32>,
}

/// The system `cat`, which the wrapper reads its payload with.
fn cat() -> &'static Path {
    ["/bin/cat", "/usr/bin/cat"]
        .into_iter()
        .map(Path::new)
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("no cat in /bin or /usr/bin"))
}

/// Named after the file, so `cargo nextest run -p xtask cloud_settings` selects them.
mod cloud_settings {
    use super::{RUST_PAYLOAD, Sandbox, checkout, hooks, scripts, settings};

    #[test]
    fn the_committed_settings_register_the_cloud_hooks() {
        let settings = settings();

        let session = hooks(&settings, "SessionStart");
        assert_eq!(session.len(), 1, "{session:?}");
        assert_eq!(session[0].0, "startup|resume");
        assert!(
            session[0].1.ends_with(".claude/cloud/provision.sh session"),
            "{}",
            session[0].1
        );

        let edits = hooks(&settings, "PostToolUse");
        assert_eq!(edits.len(), 1, "{edits:?}");
        assert_eq!(edits[0].0, "Edit|Write|MultiEdit");
        assert_eq!(
            scripts(&edits[0].1),
            [".claude/hooks/format-edited-file.sh"]
        );

        for (_, command) in session.iter().chain(&edits) {
            let named = scripts(command);
            assert!(!named.is_empty(), "{command}");
            for script in named {
                assert!(checkout().join(&script).is_file(), "missing: {script}");
            }
        }
    }

    #[test]
    fn the_format_hook_skips_a_payload_that_names_no_rust_file() {
        let sandbox = Sandbox::new(&["cargo", "mise"]);
        let run = sandbox.run(
            r#"{"tool_name":"Write","tool_input":{"file_path":"/w/README.md"}}"#,
            0,
        );
        assert_eq!(run.status, Some(0));
        assert_eq!(run.calls, Vec::<String>::new());
    }

    #[test]
    fn the_format_hook_skips_quietly_on_a_machine_without_cargo() {
        let sandbox = Sandbox::new(&["mise"]);
        let run = sandbox.run(RUST_PAYLOAD, 0);
        assert_eq!(run.status, Some(0));
        assert_eq!(run.calls, Vec::<String>::new());
    }

    #[test]
    fn the_format_hook_runs_the_formatter_under_mise_in_the_project() {
        let sandbox = Sandbox::new(&["cargo", "mise"]);
        let run = sandbox.run(RUST_PAYLOAD, 0);
        assert_eq!(run.status, Some(0));
        assert_eq!(
            run.calls,
            [
                "mise exec -- cargo xtask format-edited-file".to_owned(),
                format!(
                    "cargo xtask format-edited-file CARGO_TARGET_DIR=target/xtask PWD={}",
                    sandbox.project().display()
                ),
            ]
        );
        assert_eq!(run.cargo_stdin, RUST_PAYLOAD);
    }

    #[test]
    fn the_format_hook_runs_cargo_directly_without_mise() {
        let sandbox = Sandbox::new(&["cargo"]);
        let run = sandbox.run(RUST_PAYLOAD, 0);
        assert_eq!(run.status, Some(0));
        assert_eq!(
            run.calls,
            [format!(
                "cargo xtask format-edited-file CARGO_TARGET_DIR=target/xtask PWD={}",
                sandbox.project().display()
            )]
        );
    }

    #[test]
    fn the_format_hook_passes_the_formatters_exit_2_back_to_claude() {
        let sandbox = Sandbox::new(&["cargo", "mise"]);
        assert_eq!(sandbox.run(RUST_PAYLOAD, 2).status, Some(2));
    }
}
