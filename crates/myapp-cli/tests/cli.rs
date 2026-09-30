//! Runs the built `myapp-cli` binary with `HOME` pointed at a temporary directory, so
//! nothing here touches the real `~/Library`.

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

const COUNTER_FILE: &str = "Library/Application Support/com.example.myapp/counter.json";
const LOG_DIR: &str = "Library/Logs/com.example.myapp";
const CLI_LOG_DIR: &str = "Library/Logs/com.example.myapp/cli";

fn run(home: &Path, args: &[&str]) -> Output {
    match Command::new(env!("CARGO_BIN_EXE_myapp-cli"))
        .args(args)
        .env("HOME", home)
        .output()
    {
        Ok(output) => output,
        Err(error) => panic!("myapp-cli did not start: {error}"),
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn show_prints_the_minimum_when_nothing_was_saved() {
    let home = tempfile::tempdir().unwrap();
    let output = run(home.path(), &["counter", "show"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stdout(&output), "0");
    assert!(
        !home.path().join(COUNTER_FILE).exists(),
        "show writes nothing"
    );
}

#[test]
fn increment_saves_to_the_file_the_app_reads() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(stdout(&run(home.path(), &["counter", "increment"])), "1");
    assert_eq!(stdout(&run(home.path(), &["counter", "increment"])), "2");
    assert_eq!(stdout(&run(home.path(), &["counter", "show"])), "2");
    let file = fs::read_to_string(home.path().join(COUNTER_FILE)).unwrap();
    assert!(file.contains("\"value\": 2"), "{file}");
}

#[test]
fn increment_at_the_maximum_fails_with_exit_code_1() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join(COUNTER_FILE);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{ "version": 1, "counter": { "value": 99, "lastChangedAt": null } }"#,
    )
    .unwrap();
    let output = run(home.path(), &["counter", "increment"]);
    assert_eq!(output.status.code(), Some(1));
    // Debug builds also echo log lines to stderr; the message is the last line.
    assert_eq!(
        stderr(&output).lines().last(),
        Some("error: the counter is already at its maximum")
    );
}

#[test]
fn a_corrupt_file_fails_with_exit_code_1() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join(COUNTER_FILE);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "garbage").unwrap();
    let output = run(home.path(), &["counter", "show"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("holds data this version cannot read"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn an_unreadable_file_fails_with_exit_code_1() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join(COUNTER_FILE)).unwrap(); // a directory where the file goes
    let output = run(home.path(), &["counter", "show"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("could not be read or written"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn each_run_logs_to_the_helpers_own_directory() {
    let home = tempfile::tempdir().unwrap();
    assert!(run(home.path(), &["counter", "increment"]).status.success());
    let root: Vec<String> = fs::read_dir(home.path().join(LOG_DIR))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(root, vec!["cli".to_owned()], "no .log file in the root");
    assert!(home.path().join(LOG_DIR).join("cli").is_dir());
    let names: Vec<String> = fs::read_dir(home.path().join(CLI_LOG_DIR))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 1, "{names:?}");
    assert!(names[0].starts_with("myapp-cli."), "{names:?}");
    assert_eq!(
        Path::new(&names[0]).extension().and_then(|e| e.to_str()),
        Some("log")
    );
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
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stderr(&output).contains("logging is unavailable"));
}

#[test]
fn a_missing_home_fails_with_exit_code_1() {
    let output = Command::new(env!("CARGO_BIN_EXE_myapp-cli"))
        .args(["counter", "show"])
        .env_remove("HOME")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("HOME is not set"));
}

#[test]
fn version_prints_the_workspace_version() {
    let home = tempfile::tempdir().unwrap();
    let output = run(home.path(), &["--version"]);
    assert!(output.status.success());
    assert_eq!(
        stdout(&output),
        format!("myapp-cli {}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn help_lists_the_counter_command() {
    let home = tempfile::tempdir().unwrap();
    let output = run(home.path(), &["counter", "--help"]);
    assert!(output.status.success());
    assert!(stdout(&output).contains("show") && stdout(&output).contains("increment"));
}

#[test]
fn an_unknown_command_is_a_usage_error_with_exit_code_2() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(
        run(home.path(), &["counter", "explode"]).status.code(),
        Some(2)
    );
}
