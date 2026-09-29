//! What `JsonFileCounterStore` does beyond the shared contract: its file format, and how
//! it reports a damaged or unreachable file.

use std::fs;

use myapp_core::{CounterStore, StorageError, StorageErrorKind, StoredCounter, UnixMillis};
use myapp_platform::JsonFileCounterStore;

fn store_in(dir: &tempfile::TempDir) -> JsonFileCounterStore {
    JsonFileCounterStore::new(dir.path().join("counter.json"))
}

#[test]
fn saves_a_versioned_json_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    store
        .save(&StoredCounter {
            value: 5,
            last_changed_at: Some(UnixMillis(42)),
        })
        .unwrap();
    let written: serde_json::Value =
        serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
    assert_eq!(
        written,
        serde_json::json!({ "version": 1, "counter": { "value": 5, "lastChangedAt": 42 } })
    );
}

#[test]
fn leaves_no_temporary_file_behind() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    store
        .save(&StoredCounter {
            value: 1,
            last_changed_at: None,
        })
        .unwrap();
    let names: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("counter.json")]);
}

#[test]
fn a_file_that_is_not_json_is_corrupt() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    fs::write(store.path(), "not json").unwrap();
    assert_eq!(
        store.load(),
        Err(StorageError::new(StorageErrorKind::Corrupt))
    );
}

#[test]
fn a_file_from_an_unknown_format_version_is_corrupt() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    fs::write(
        store.path(),
        r#"{ "version": 2, "counter": { "value": 1, "lastChangedAt": null } }"#,
    )
    .unwrap();
    assert_eq!(
        store.load(),
        Err(StorageError::new(StorageErrorKind::Corrupt))
    );
}

#[test]
fn a_path_that_cannot_be_read_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let store = JsonFileCounterStore::new(dir.path().to_path_buf()); // a directory, not a file
    assert_eq!(
        store.load(),
        Err(StorageError::new(StorageErrorKind::Unavailable))
    );
}

#[test]
fn a_path_that_cannot_be_written_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("blocker");
    fs::write(&blocker, "a file where a directory should be").unwrap();
    let store = JsonFileCounterStore::new(blocker.join("counter.json"));
    assert_eq!(
        store.save(&StoredCounter {
            value: 1,
            last_changed_at: None
        }),
        Err(StorageError::new(StorageErrorKind::Unavailable))
    );
}
