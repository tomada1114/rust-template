//! The JSON shapes that cross IPC and reach disk are contract (docs/architecture.md).
//! These tests pin them with literal JSON, independent of serde's derive.

use myapp_core::{
    CounterError, CounterView, StorageErrorKind, StoredCounter, UiLogEntry, UiLogLevel, UnixMillis,
};
use serde_json::json;

#[test]
fn counter_view_is_camel_case_with_a_numeric_time() {
    let view = CounterView {
        value: 3,
        last_changed_at: Some(UnixMillis(1_700_000_000_000)),
        revision: 4,
    };
    assert_eq!(
        serde_json::to_value(&view).unwrap(),
        json!({ "value": 3, "lastChangedAt": 1_700_000_000_000_i64, "revision": 4 })
    );
}

#[test]
fn a_counter_view_never_changed_has_a_null_time() {
    let view = CounterView {
        value: 0,
        last_changed_at: None,
        revision: 0,
    };
    assert_eq!(
        serde_json::to_value(&view).unwrap(),
        json!({ "value": 0, "lastChangedAt": null, "revision": 0 })
    );
}

#[test]
fn counter_errors_serialize_as_codes() {
    assert_eq!(
        serde_json::to_value(CounterError::AtMaximum).unwrap(),
        json!({ "code": "atMaximum" })
    );
    assert_eq!(
        serde_json::to_value(CounterError::AtMinimum).unwrap(),
        json!({ "code": "atMinimum" })
    );
    assert_eq!(
        serde_json::to_value(CounterError::Storage {
            kind: StorageErrorKind::Corrupt
        })
        .unwrap(),
        json!({ "code": "storage", "kind": "corrupt" })
    );
    assert_eq!(
        serde_json::to_value(CounterError::Storage {
            kind: StorageErrorKind::Unavailable
        })
        .unwrap(),
        json!({ "code": "storage", "kind": "unavailable" })
    );
}

#[test]
fn a_stored_counter_round_trips_through_its_file_format() {
    let stored = StoredCounter {
        value: 4,
        last_changed_at: Some(UnixMillis(12)),
    };
    let text = json!({ "value": 4, "lastChangedAt": 12 });
    assert_eq!(serde_json::to_value(&stored).unwrap(), text);
    assert_eq!(
        serde_json::from_value::<StoredCounter>(text).unwrap(),
        stored
    );
}

#[test]
fn a_ui_log_entry_reads_from_camel_case_json() {
    let entry: UiLogEntry =
        serde_json::from_value(json!({ "level": "error", "message": "boom" })).unwrap();
    assert_eq!(
        entry,
        UiLogEntry {
            level: UiLogLevel::Error,
            message: "boom".to_owned()
        }
    );
    let entry: UiLogEntry =
        serde_json::from_value(json!({ "level": "warn", "message": "hm" })).unwrap();
    assert_eq!(entry.level, UiLogLevel::Warn);
}

#[test]
fn error_messages_carry_no_data() {
    assert_eq!(
        CounterError::AtMaximum.to_string(),
        "the counter is at its maximum"
    );
    assert_eq!(
        CounterError::AtMinimum.to_string(),
        "the counter is at its minimum"
    );
    assert_eq!(
        CounterError::Storage {
            kind: StorageErrorKind::Corrupt
        }
        .to_string(),
        "counter storage failed: Corrupt"
    );
}
