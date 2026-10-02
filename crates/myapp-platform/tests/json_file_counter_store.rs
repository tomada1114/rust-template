//! What `JsonFileCounterStore` does beyond the shared contract: its file format, how it
//! reports a damaged or unreachable file, and how two stores on one file (two runs of
//! the binary) save at once.

use std::fs;
use std::sync::{Arc, Barrier};
use std::thread;

use myapp_core::{
    CounterService, CounterStore, StorageError, StorageErrorKind, StoredCounter, Tuning, UnixMillis,
};
use myapp_platform::JsonFileCounterStore;
use myapp_test_support::FixedClock;

/// How many times each thread in a concurrency test saves, loads, or updates.
const ROUNDS: i64 = 50;

fn store_in(dir: &tempfile::TempDir) -> JsonFileCounterStore {
    JsonFileCounterStore::new(dir.path().join("counter.json"))
}

/// The directory's entries, sorted. Panics (failing the test) when it cannot be listed.
fn names_in(dir: &tempfile::TempDir) -> Vec<std::ffi::OsString> {
    let listed: Result<Vec<_>, _> = fs::read_dir(dir.path()).and_then(|entries| {
        entries
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect()
    });
    match listed {
        Ok(mut names) => {
            names.sort();
            names
        }
        Err(error) => panic!("listing the test directory: {error:?}"),
    }
}

fn counter(value: i64) -> StoredCounter {
    StoredCounter {
        value,
        last_changed_at: None,
    }
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
fn leaves_no_temporary_file_behind_only_the_file_and_its_lock() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    store.save(&counter(1)).unwrap();
    assert_eq!(names_in(&dir), ["counter.json", "counter.json.lock"]);
}

#[test]
fn a_save_removes_the_temporary_files_a_crashed_save_left() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    // The fixed name earlier builds used, and one in this build's pattern.
    fs::write(dir.path().join("counter.json.tmp"), "{ \"vers").unwrap();
    fs::write(
        dir.path().join("counter.json.99-0-00000000deadbeef.tmp"),
        "{",
    )
    .unwrap();
    fs::write(dir.path().join("other.json.tmp"), "not this store's").unwrap();
    store.save(&counter(1)).unwrap();
    assert_eq!(
        names_in(&dir),
        ["counter.json", "counter.json.lock", "other.json.tmp"]
    );
    assert_eq!(store.load(), Ok(Some(counter(1))));
}

#[test]
fn saves_and_loads_from_two_stores_on_one_file_all_succeed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("counter.json");
    let start = Arc::new(Barrier::new(4));
    let writers = [1, 2].map(|writer| {
        let (store, start) = (JsonFileCounterStore::new(path.clone()), start.clone());
        thread::spawn(move || {
            start.wait();
            (0..ROUNDS)
                .map(|round| store.save(&counter(writer * 1_000 + round)))
                .filter(Result::is_err)
                .count()
        })
    });
    let readers = [1, 2].map(|_| {
        let (store, start) = (JsonFileCounterStore::new(path.clone()), start.clone());
        thread::spawn(move || {
            start.wait();
            (0..ROUNDS)
                .map(|_| store.load())
                .filter(|loaded| {
                    // Nothing yet, or a whole counter one of the writers saved.
                    !matches!(loaded, Ok(None))
                        && !matches!(loaded, Ok(Some(c)) if c.value >= 1_000 && c.value < 3_000)
                })
                .count()
        })
    });
    let failed_saves: usize = writers.map(|w| w.join().unwrap()).iter().sum();
    let failed_loads: usize = readers.map(|r| r.join().unwrap()).iter().sum();
    assert_eq!((failed_saves, failed_loads), (0, 0));
    assert_eq!(names_in(&dir), ["counter.json", "counter.json.lock"]);
}

#[test]
fn updates_from_two_stores_on_one_file_lose_no_update() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("counter.json");
    let start = Arc::new(Barrier::new(2));
    let updaters = [(); 2].map(|()| {
        let (store, start) = (JsonFileCounterStore::new(path.clone()), start.clone());
        thread::spawn(move || {
            start.wait();
            for _ in 0..ROUNDS {
                store
                    .update(&mut |stored| Some(counter(stored.map_or(0, |c| c.value) + 1)))
                    .unwrap();
            }
        })
    });
    for updater in updaters {
        updater.join().unwrap();
    }
    assert_eq!(store_in(&dir).load(), Ok(Some(counter(100))));
}

#[test]
fn two_services_on_one_file_lose_no_increment() {
    // Two runs of the binary: separate services, separate stores, one file.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("counter.json");
    let start = Arc::new(Barrier::new(2));
    let services = [(); 2].map(|()| {
        let service = CounterService::new(
            Arc::new(JsonFileCounterStore::new(path.clone())),
            Arc::new(FixedClock::default()),
            Tuning::new(0, 1_000).unwrap(),
        );
        let start = start.clone();
        thread::spawn(move || {
            start.wait();
            for _ in 0..ROUNDS {
                service.increment().unwrap();
            }
        })
    });
    for service in services {
        service.join().unwrap();
    }
    assert_eq!(
        store_in(&dir).load().map(|c| c.map(|c| c.value)),
        Ok(Some(100))
    );
}

#[test]
fn update_hands_the_change_what_was_saved_and_saves_its_answer() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    store.save(&counter(4)).unwrap();
    let mut seen = Vec::new();
    store
        .update(&mut |stored| {
            seen.push(stored);
            Some(counter(5))
        })
        .unwrap();
    assert_eq!(seen, [Some(counter(4))]);
    assert_eq!(store.load(), Ok(Some(counter(5))));
}

#[test]
fn update_over_a_corrupt_file_is_corrupt_and_never_calls_the_change() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    fs::write(store.path(), "not json").unwrap();
    let mut calls = 0;
    assert_eq!(
        store.update(&mut |_| {
            calls += 1;
            Some(counter(1))
        }),
        Err(StorageError::new(StorageErrorKind::Corrupt))
    );
    assert_eq!(calls, 0);
    assert_eq!(fs::read_to_string(store.path()).unwrap(), "not json");
}

#[test]
fn a_lock_that_cannot_be_taken_makes_saves_and_updates_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    fs::create_dir(dir.path().join("counter.json.lock")).unwrap(); // not a lockable file
    let unavailable = Err(StorageError::new(StorageErrorKind::Unavailable));
    assert_eq!(store.save(&counter(1)), unavailable);
    assert_eq!(store.update(&mut |_| Some(counter(1))), unavailable);
    assert_eq!(store.load(), Ok(None), "nothing was written");
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
fn a_save_replaces_a_file_that_is_not_json() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    fs::write(store.path(), "not json").unwrap();
    let saved = StoredCounter {
        value: 3,
        last_changed_at: Some(UnixMillis(7)),
    };
    assert_eq!(store.save(&saved), Ok(()));
    assert_eq!(
        store.load(),
        Ok(Some(StoredCounter {
            value: 3,
            last_changed_at: Some(UnixMillis(7)),
        }))
    );
}

#[test]
fn a_save_replaces_a_file_from_an_unknown_format_version() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(&dir);
    fs::write(
        store.path(),
        r#"{ "version": 2, "counter": { "value": 1, "lastChangedAt": null } }"#,
    )
    .unwrap();
    assert_eq!(store.save(&counter(0)), Ok(()));
    assert_eq!(store.load(), Ok(Some(counter(0))));
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
