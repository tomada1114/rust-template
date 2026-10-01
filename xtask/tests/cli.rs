//! The `xtask` binary end to end: each task reached by name, standard input read, lines
//! logged, and the failure contract printed with its exit code. Each run gets a temporary
//! directory as its repository root (through `CARGO_MANIFEST_DIR`, as `cargo run` sets
//! it), never the real checkout.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

/// Run the binary with `root` as its repository root, `GIT_*` stripped.
fn xtask(root: &Path, args: &[&str], stdin: &str, env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_xtask"));
    command
        .args(args)
        .current_dir(root)
        .env("CARGO_MANIFEST_DIR", root.join("xtask"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_remove("CARGO_TERM_COLOR");
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            command.env_remove(name);
        }
    }
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = must(command.spawn(), "start xtask");
    if let Some(mut pipe) = child.stdin.take() {
        must(pipe.write_all(stdin.as_bytes()), "write stdin");
    }
    must(child.wait_with_output(), "wait for xtask")
}

/// The value, or a panic that names what failed: a panic is how a test fails.
fn must<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> T {
    result.unwrap_or_else(|error| panic!("{what}: {error}"))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Assert the four-line failure report under `code`, and the exit status.
fn assert_failure(output: &Output, code: &str, status: i32) {
    let stderr = text(&output.stderr);
    let lines: Vec<&str> = stderr.lines().collect();
    assert!(
        lines
            .first()
            .is_some_and(|line| line.starts_with(&format!("{code}: "))),
        "{stderr}"
    );
    assert!(
        lines
            .get(1)
            .is_some_and(|line| line.starts_with("Expected: ")),
        "{stderr}"
    );
    assert!(
        lines
            .get(2)
            .is_some_and(|line| line.starts_with("Actual: ")),
        "{stderr}"
    );
    assert!(
        lines.iter().any(|line| line.starts_with("Next: ")),
        "{stderr}"
    );
    assert_eq!(output.status.code(), Some(status), "{stderr}");
}

#[test]
fn refuses_no_task_or_an_unknown_one() {
    let dir = tempfile::tempdir().expect("temp dir");
    assert_failure(&xtask(dir.path(), &[], "", &[]), "ERR_XTASK_USAGE", 1);
    assert_failure(
        &xtask(dir.path(), &["bogus"], "", &[]),
        "ERR_XTASK_USAGE",
        1,
    );
}

#[test]
fn formats_the_rust_file_a_hook_payload_names() {
    let dir = tempfile::tempdir().expect("temp dir");
    let file = dir.path().join("lib.rs");
    std::fs::write(&file, "fn main(){}").expect("write");
    let payload = format!(
        "{{\"tool_input\":{{\"file_path\":{}}}}}",
        serde_json::Value::from(file.display().to_string())
    );
    let output = xtask(dir.path(), &["format-edited-file"], &payload, &[]);
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert_eq!(
        std::fs::read_to_string(&file).expect("read"),
        "fn main() {}\n"
    );
}

#[test]
fn exits_2_on_a_hook_usage_error() {
    let dir = tempfile::tempdir().expect("temp dir");
    let output = xtask(dir.path(), &["format-edited-file", "--fast"], "{}", &[]);
    assert_failure(&output, "ERR_FORMAT_USAGE", 2);
}

#[test]
fn logs_to_standard_output() {
    let dir = tempfile::tempdir().expect("temp dir");
    let output = xtask(
        dir.path(),
        &["verify-hooks"],
        "",
        &[("ALLOW_MISSING_GIT_HOOKS", "1")],
    );
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert!(
        text(&output.stdout).starts_with("verify-hooks: skipped (ALLOW_MISSING_GIT_HOOKS is set)")
    );
}

#[test]
fn reaches_every_other_task() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path();
    assert_failure(
        &xtask(root, &["clippy-guard"], "", &[]),
        "ERR_CLIPPY_USAGE",
        1,
    );
    assert_failure(
        &xtask(root, &["check-staged"], "", &[]),
        "ERR_STAGED_NOT_A_REPO",
        1,
    );
    assert_failure(
        &xtask(root, &["sync-agents", "--staged"], "", &[]),
        "ERR_AGENTS_USAGE",
        1,
    );
    let temp = root.join("tmp").display().to_string();
    let base = root.join("claude").display().to_string();
    let output = xtask(
        root,
        &[
            "prune-temp",
            "--dry-run",
            "--temp-dir",
            &temp,
            "--claude-base",
            &base,
        ],
        "",
        &[],
    );
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert_eq!(text(&output.stdout), "prune-temp: nothing to prune\n");
}

#[test]
fn asks_cargo_for_colour_only_through_clippy_guard() {
    // stdout is a pipe here, so clippy-guard leaves CARGO_TERM_COLOR unset; a fake cargo
    // reports what it was given.
    let dir = tempfile::tempdir().expect("temp dir");
    let bin = dir.path().join("bin");
    std::fs::create_dir(&bin).expect("mkdir");
    let cargo = bin.join("cargo");
    std::fs::write(
        &cargo,
        "#!/bin/sh\necho \"colour=${CARGO_TERM_COLOR:-unset} args=$*\"\n",
    )
    .expect("write");
    let mut permissions = std::fs::metadata(&cargo).expect("stat").permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
    std::fs::set_permissions(&cargo, permissions).expect("chmod");
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let output = xtask(
        dir.path(),
        &["clippy-guard", "cargo", "clippy", "--locked"],
        "",
        &[("PATH", &path)],
    );
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert_eq!(text(&output.stdout), "colour=unset args=clippy --locked\n");
}
