//! `init_logging` writes to a dated file in the directory it is given and prunes only its
//! own files there. Each test installs the process-wide subscriber, so the file relies on
//! nextest's process per test (`just` and CI use it); plain `cargo test` runs them in one
//! process and fails with `AlreadyInitialised`.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::Path;

use myapp_platform::{LoggingError, init_logging, log_dir};

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
fn seed(dir: &Path, prefix: &str) -> io::Result<BTreeSet<String>> {
    fs::create_dir_all(dir)?;
    (1..=20)
        .map(|day| {
            let name = format!("{prefix}.2020-01-{day:02}.log");
            fs::write(dir.join(&name), "")?;
            Ok(name)
        })
        .collect()
}

/// The regular files in `dir` named `<prefix>.*.log`.
fn log_names(dir: &Path, prefix: &str) -> io::Result<BTreeSet<String>> {
    let start = format!("{prefix}.");
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_file()
            && name.starts_with(&start)
            && Path::new(&name).extension().is_some_and(|e| e == "log")
        {
            names.insert(name);
        }
    }
    Ok(names)
}

// Counts only: on ext4 the seeded files share birth times, so which ones survive is arbitrary.
#[test]
fn retention_keeps_14_and_never_counts_another_prefix_or_a_subdirectory() {
    let home = tempfile::tempdir().unwrap();
    let dir = log_dir(home.path());
    let own = seed(&dir, "probe").unwrap();
    let other = seed(&dir, "other").unwrap();
    let nested = seed(&dir.join("nested"), "probe").unwrap();
    init_logging(&dir, "probe", false).unwrap();

    let kept = log_names(&dir, "probe").unwrap();
    assert_eq!(kept.len(), 14, "{kept:?}");
    assert_eq!(kept.intersection(&own).count(), 13, "{kept:?}");
    assert_eq!(kept.difference(&own).count(), 1, "{kept:?}");
    assert_eq!(log_names(&dir, "other").unwrap(), other);
    assert_eq!(log_names(&dir.join("nested"), "probe").unwrap(), nested);
}
