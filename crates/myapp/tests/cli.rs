//! The command-line contract, against the built `myapp` binary with `HOME` pointed at a
//! temporary directory, so nothing here touches the real `~/Library`: data on stdout,
//! diagnostics on stderr; exit 0 on success, 1 on a runtime error, 2 on a usage error.

use std::fs;
use std::io;
use std::path::Path;
use std::process::{Command, Output, Stdio};

const COUNTER_FILE: &str = "Library/Application Support/com.example.myapp/counter.json";
const LOG_DIR: &str = "Library/Logs/com.example.myapp";

fn command(home: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_myapp"));
    command.args(args).env("HOME", home);
    command
}

fn output(mut command: Command) -> Output {
    match command.output() {
        Ok(output) => output,
        Err(error) => panic!("myapp did not start: {error}"),
    }
}

fn run(home: &Path, args: &[&str]) -> Output {
    output(command(home, args))
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Debug builds also echo log lines to stderr, so the diagnostic is the last line.
fn last_stderr_line(output: &Output) -> Option<String> {
    stderr(output).lines().last().map(str::to_owned)
}

fn write_counter_file(home: &Path, content: &str) -> io::Result<()> {
    let path = home.join(COUNTER_FILE);
    fs::create_dir_all(path.parent().unwrap_or(home))?;
    fs::write(&path, content)
}

fn saved_value(value: i64) -> String {
    format!(r#"{{ "version": 1, "counter": {{ "value": {value}, "lastChangedAt": null }} }}"#)
}

/// A runtime error: exit 1, nothing on stdout, and `error: <wording>` last on stderr.
fn assert_runtime_error(output: &Output, wording: &str) {
    assert_eq!(output.status.code(), Some(1), "{}", stderr(output));
    assert_eq!(stdout(output), "", "a failure prints no data");
    assert_eq!(last_stderr_line(output), Some(format!("error: {wording}")));
}

#[test]
fn show_prints_the_minimum_when_nothing_was_saved() {
    let home = tempfile::tempdir().unwrap();
    let output = run(home.path(), &["counter", "show"]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(stdout(&output), "0\n");
    assert!(
        !home.path().join(COUNTER_FILE).exists(),
        "show writes nothing"
    );
}

#[test]
fn show_prints_the_saved_value() {
    let home = tempfile::tempdir().unwrap();
    write_counter_file(home.path(), &saved_value(41)).unwrap();
    let output = run(home.path(), &["counter", "show"]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(stdout(&output), "41\n");
}

#[test]
fn a_closed_stdout_pipe_is_a_runtime_error_not_a_panic() {
    let home = tempfile::tempdir().unwrap();
    // The read end is dropped before the child starts, so its first write fails with
    // EPIPE deterministically, as in `myapp counter increment | true` once `true` exited.
    let (reader, writer) = io::pipe().unwrap();
    drop(reader);
    let mut command = command(home.path(), &["counter", "increment"]);
    command.stdout(Stdio::from(writer));
    assert_runtime_error(
        &output(command),
        "the result could not be written to standard output",
    );
}

#[test]
fn show_fails_on_a_corrupt_file() {
    let home = tempfile::tempdir().unwrap();
    write_counter_file(home.path(), "garbage").unwrap();
    assert_runtime_error(
        &run(home.path(), &["counter", "show"]),
        "the counter file holds data this version cannot read",
    );
}

#[test]
fn show_fails_on_an_unreadable_file() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join(COUNTER_FILE)).unwrap(); // a directory where the file goes
    assert_runtime_error(
        &run(home.path(), &["counter", "show"]),
        "the counter file could not be read or written",
    );
}

#[test]
fn increment_prints_and_saves_the_new_value() {
    let home = tempfile::tempdir().unwrap();
    let first = run(home.path(), &["counter", "increment"]);
    assert_eq!(first.status.code(), Some(0), "{}", stderr(&first));
    assert_eq!(stdout(&first), "1\n");
    assert_eq!(stdout(&run(home.path(), &["counter", "increment"])), "2\n");
    assert_eq!(stdout(&run(home.path(), &["counter", "show"])), "2\n");
    let file = fs::read_to_string(home.path().join(COUNTER_FILE)).unwrap();
    assert!(file.contains("\"value\": 2"), "{file}");
}

#[test]
fn increment_at_the_maximum_fails_and_changes_nothing() {
    let home = tempfile::tempdir().unwrap();
    write_counter_file(home.path(), &saved_value(99)).unwrap();
    assert_runtime_error(
        &run(home.path(), &["counter", "increment"]),
        "the counter is already at its maximum",
    );
    assert_eq!(stdout(&run(home.path(), &["counter", "show"])), "99\n");
}

#[test]
fn increment_fails_on_a_corrupt_file() {
    let home = tempfile::tempdir().unwrap();
    write_counter_file(home.path(), "garbage").unwrap();
    assert_runtime_error(
        &run(home.path(), &["counter", "increment"]),
        "the counter file holds data this version cannot read",
    );
}

#[test]
fn increment_fails_when_the_data_directory_cannot_be_created() {
    let home = tempfile::tempdir().unwrap();
    let data_dir = home.path().join(COUNTER_FILE);
    let data_dir = data_dir.parent().unwrap();
    fs::create_dir_all(data_dir.parent().unwrap()).unwrap();
    fs::write(data_dir, "a file where a directory should be").unwrap();
    assert_runtime_error(
        &run(home.path(), &["counter", "increment"]),
        "the counter file could not be read or written",
    );
}

#[test]
fn a_missing_home_fails_with_exit_code_1() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_myapp"));
    command.args(["counter", "show"]).env_remove("HOME");
    let output = output(command);
    assert_runtime_error(
        &output,
        "HOME is not set, so the counter file cannot be found",
    );
}

#[test]
fn an_empty_home_fails_with_exit_code_1() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_myapp"));
    command.args(["counter", "show"]).env("HOME", "");
    assert_runtime_error(
        &output(command),
        "HOME is not set, so the counter file cannot be found",
    );
}

#[test]
fn each_run_logs_to_the_file_just_logs_reads() {
    let home = tempfile::tempdir().unwrap();
    assert!(run(home.path(), &["counter", "increment"]).status.success());
    let names: Vec<String> = fs::read_dir(home.path().join(LOG_DIR))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    // The justfile's `logs` recipe reads `<log_dir>/myapp.*.log`.
    assert_eq!(names.len(), 1, "{names:?}");
    assert!(names[0].starts_with("myapp."), "{names:?}");
    assert_eq!(
        Path::new(&names[0]).extension().and_then(|e| e.to_str()),
        Some("log")
    );
    let log = fs::read_to_string(home.path().join(LOG_DIR).join(&names[0])).unwrap();
    assert!(log.contains("counter action succeeded"), "{log}");
}

#[test]
fn an_unwritable_log_directory_does_not_stop_the_action() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join("Library")).unwrap();
    fs::write(
        home.path().join("Library/Logs"),
        "a file where a directory should be",
    )
    .unwrap();
    let output = run(home.path(), &["counter", "show"]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(stdout(&output), "0\n");
    assert!(
        stderr(&output).contains("warning: logging is unavailable for this run"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn version_prints_the_workspace_version_on_stdout() {
    let home = tempfile::tempdir().unwrap();
    let output = run(home.path(), &["--version"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        stdout(&output),
        format!("myapp {}\n", env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(stderr(&output), "");
}

#[test]
fn help_lists_the_subcommands_on_stdout() {
    let home = tempfile::tempdir().unwrap();
    let output = run(home.path(), &["counter", "--help"]);
    assert_eq!(output.status.code(), Some(0));
    assert!(stdout(&output).contains("show") && stdout(&output).contains("increment"));
    assert_eq!(stderr(&output), "");
}

#[test]
fn an_unknown_subcommand_is_a_usage_error_with_exit_code_2() {
    let home = tempfile::tempdir().unwrap();
    for args in [&["counter", "explode"][..], &["explode"], &["counter"], &[]] {
        let output = run(home.path(), args);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{args:?}: {}",
            stderr(&output)
        );
        assert_eq!(stdout(&output), "", "{args:?}");
        assert!(
            stderr(&output).contains("Usage:"),
            "{args:?}: {}",
            stderr(&output)
        );
    }
}

#[test]
fn an_unknown_flag_is_a_usage_error_with_exit_code_2() {
    let home = tempfile::tempdir().unwrap();
    let output = run(home.path(), &["counter", "show", "--loud"]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(stdout(&output), "");
    assert!(stderr(&output).starts_with("error:"), "{}", stderr(&output));
}

#[test]
fn a_usage_error_touches_nothing() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(
        run(home.path(), &["counter", "explode"]).status.code(),
        Some(2)
    );
    assert_eq!(fs::read_dir(home.path()).unwrap().count(), 0);
}
