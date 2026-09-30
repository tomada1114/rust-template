//! `init_logging` writes to a dated file in the directory it is given and prunes only its
//! own files there. Each test calls it once: a process has one global subscriber, and
//! nextest runs each test alone.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use myapp_platform::{LoggingError, cli_log_dir, init_logging, log_dir};

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

/// Writes an empty `<prefix>.2020-01-DD.log` for DD = 01..=20 into `dir`.
fn seed(dir: &Path, prefix: &str) -> BTreeSet<String> {
    fs::create_dir_all(dir).unwrap();
    (1..=20)
        .map(|day| {
            let name = format!("{prefix}.2020-01-{day:02}.log");
            fs::write(dir.join(&name), "").unwrap();
            name
        })
        .collect()
}

/// The regular files in `dir` named `<prefix>.*.log`.
fn log_names(dir: &Path, prefix: &str) -> BTreeSet<String> {
    let start = format!("{prefix}.");
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap())
        .filter(|e| e.file_type().unwrap().is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(&start) && name.ends_with(".log"))
        .collect()
}

// Counts only: on ext4 the seeded files share birth times, so which ones survive is arbitrary.
#[test]
fn app_retention_keeps_14_and_never_counts_the_helpers_files() {
    let home = tempfile::tempdir().unwrap();
    let home = home.path();
    let app = seed(&log_dir(home), "probe");
    let cli = seed(&cli_log_dir(home), "probe-cli");
    init_logging(&log_dir(home), "probe", false).unwrap();
    tracing::info!("retention probe");

    let kept = log_names(&log_dir(home), "probe");
    assert_eq!(kept.len(), 14, "{kept:?}");
    assert_eq!(kept.intersection(&app).count(), 13, "{kept:?}");
    assert_eq!(kept.difference(&app).count(), 1, "{kept:?}");
    assert!(cli_log_dir(home).is_dir());
    assert_eq!(log_names(&cli_log_dir(home), "probe-cli"), cli);
}

#[test]
fn helper_retention_keeps_14_and_never_touches_the_apps_files() {
    let home = tempfile::tempdir().unwrap();
    let home = home.path();
    let app = seed(&log_dir(home), "probe");
    let cli = seed(&cli_log_dir(home), "probe-cli");
    init_logging(&cli_log_dir(home), "probe-cli", false).unwrap();
    tracing::info!("retention probe");

    let kept = log_names(&cli_log_dir(home), "probe-cli");
    assert_eq!(kept.len(), 14, "{kept:?}");
    assert_eq!(kept.intersection(&cli).count(), 13, "{kept:?}");
    assert_eq!(kept.difference(&cli).count(), 1, "{kept:?}");
    assert_eq!(log_names(&log_dir(home), "probe"), app);
}
