//! `init_logging` writes to a dated file in the directory it is given. One test per
//! binary: a process has one global subscriber, and nextest runs each test alone.

use std::fs;

use myapp_platform::{LoggingError, init_logging};

#[test]
fn writes_events_to_a_dated_file_with_the_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("Logs");
    init_logging(&logs, "probe", false).unwrap();
    tracing::info!(answer = 42, "hello from the test");

    let files: Vec<_> = fs::read_dir(&logs)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1, "one file for today: {files:?}");
    let name = files[0].file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("probe."), "{name}");
    assert_eq!(files[0].extension().and_then(|e| e.to_str()), Some("log"));
    let text = fs::read_to_string(&files[0]).unwrap();
    assert!(
        text.contains("hello from the test") && text.contains("answer=42"),
        "{text}"
    );

    assert!(matches!(
        init_logging(&logs, "probe", false),
        Err(LoggingError::AlreadyInitialised)
    ));
}

#[test]
fn a_directory_that_cannot_be_created_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("blocker");
    fs::write(&blocker, "a file where a directory should be").unwrap();
    assert!(matches!(
        init_logging(&blocker.join("Logs"), "probe", true),
        Err(LoggingError::Directory)
    ));
}
