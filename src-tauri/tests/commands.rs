//! The commands through Tauri's mock runtime (`tauri::test`): argument decoding, the
//! JSON the UI receives, error codes, the `counter-changed` event, and the line
//! `log_from_ui` writes. The state holds core's service over test-support fakes, so
//! nothing touches a window, and only the logging test writes (to a temporary directory).

use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use myapp_core::{
    CounterService, CounterStore, StorageErrorKind, StoredCounter, Tuning, UiLogEntry,
};
use myapp_lib::{AppState, COUNTER_CHANGED, with_commands};
use myapp_platform::init_logging;
use myapp_test_support::{FailingCounterStore, FixedClock, InMemoryCounterStore};
use serde_json::{Value, json};
use tauri::http::HeaderMap;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const T0: i64 = 1_700_000_000_000;

/// A setup step that must succeed for the test to mean anything; panics with context.
fn must<T, E: std::fmt::Debug>(result: Result<T, E>, what: &str) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{what}: {error:?}"),
    }
}

fn app_holding(value: Option<i64>) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let store = match value {
        Some(value) => InMemoryCounterStore::holding(StoredCounter {
            value,
            last_changed_at: None,
        }),
        None => InMemoryCounterStore::default(),
    };
    app_over(Arc::new(store))
}

fn app_over(store: Arc<dyn CounterStore>) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let service = CounterService::new(
        store,
        Arc::new(FixedClock::default()),
        must(Tuning::new(0, 2), "0 to 2 is a valid range"),
    );
    let app = must(
        with_commands(mock_builder())
            .manage(AppState {
                counter: Arc::new(service),
            })
            .build(mock_context(noop_assets())),
        "the mock app builds",
    );
    let window = must(
        WebviewWindowBuilder::new(&app, "main", WebviewUrl::default()).build(),
        "the mock window builds",
    );
    (app, window)
}

fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: must("tauri://localhost".parse(), "the URL parses"),
            body: InvokeBody::Json(body),
            headers: HeaderMap::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| must(body.deserialize::<Value>(), "the response is JSON"))
}

/// Collect every `counter-changed` payload the app emits.
fn record_events(app: &App<MockRuntime>) -> mpsc::Receiver<Value> {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    app.listen(COUNTER_CHANGED, move |event| {
        let payload: Value = must(serde_json::from_str(event.payload()), "the payload is JSON");
        let sender = tx.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // The receiver outlives every emit in these tests; a closed channel is not a failure.
        let _ = sender.send(payload);
    });
    rx
}

/// Whether an event arrives within a grace period long enough for an emit that was
/// going to happen.
fn nothing_emitted(events: &mpsc::Receiver<Value>) -> bool {
    events.recv_timeout(Duration::from_millis(200)).is_err()
}

/// Every line of every log file in `dir`.
fn log_lines(dir: &Path) -> Vec<String> {
    let mut lines = Vec::new();
    for file in must(std::fs::read_dir(dir), "the log directory is readable") {
        let path = must(file, "the log directory lists").path();
        let text = must(std::fs::read_to_string(&path), "a log file is readable");
        lines.extend(text.lines().map(str::to_owned));
    }
    lines
}

#[test]
fn get_counter_returns_the_view_as_camel_case_json_and_emits_nothing() {
    let (app, window) = app_holding(Some(1));
    let events = record_events(&app);
    assert_eq!(
        invoke(&window, "get_counter", json!({})),
        Ok(json!({ "value": 1, "lastChangedAt": null }))
    );
    assert!(
        nothing_emitted(&events),
        "reading the counter changes nothing"
    );
}

#[test]
fn increment_returns_the_new_view_and_emits_counter_changed() {
    let (app, window) = app_holding(None);
    let events = record_events(&app);
    let expected = json!({ "value": 1, "lastChangedAt": T0 });
    assert_eq!(
        invoke(&window, "increment", json!({})),
        Ok(expected.clone())
    );
    assert_eq!(events.recv_timeout(Duration::from_secs(5)), Ok(expected));
}

#[test]
fn decrement_returns_the_new_view_and_emits_counter_changed() {
    let (app, window) = app_holding(Some(2));
    let events = record_events(&app);
    let expected = json!({ "value": 1, "lastChangedAt": T0 });
    assert_eq!(
        invoke(&window, "decrement", json!({})),
        Ok(expected.clone())
    );
    assert_eq!(events.recv_timeout(Duration::from_secs(5)), Ok(expected));
}

#[test]
fn reset_returns_the_new_view_and_emits_counter_changed() {
    let (app, window) = app_holding(Some(2));
    let events = record_events(&app);
    let expected = json!({ "value": 0, "lastChangedAt": T0 });
    assert_eq!(invoke(&window, "reset", json!({})), Ok(expected.clone()));
    assert_eq!(events.recv_timeout(Duration::from_secs(5)), Ok(expected));
}

#[test]
fn increment_at_the_maximum_rejects_with_a_code_and_emits_nothing() {
    let (app, window) = app_holding(Some(2));
    let events = record_events(&app);
    assert_eq!(
        invoke(&window, "increment", json!({})),
        Err(json!({ "code": "atMaximum" }))
    );
    assert!(nothing_emitted(&events), "no event for a rejected change");
}

#[test]
fn decrement_at_the_minimum_rejects_with_a_code() {
    let (_app, window) = app_holding(None);
    assert_eq!(
        invoke(&window, "decrement", json!({})),
        Err(json!({ "code": "atMinimum" }))
    );
}

#[test]
fn a_store_that_cannot_load_rejects_every_command_with_the_storage_code() {
    let (app, window) = app_over(Arc::new(FailingCounterStore::load_fails(
        StorageErrorKind::Corrupt,
    )));
    let events = record_events(&app);
    for cmd in ["get_counter", "increment", "decrement", "reset"] {
        assert_eq!(
            invoke(&window, cmd, json!({})),
            Err(json!({ "code": "storage", "kind": "corrupt" })),
            "{cmd}"
        );
    }
    assert!(nothing_emitted(&events), "no event for a failed change");
}

#[test]
fn a_store_that_cannot_save_rejects_a_change_with_the_storage_code_and_emits_nothing() {
    let (app, window) = app_over(Arc::new(FailingCounterStore::save_fails(
        StorageErrorKind::Unavailable,
        None,
    )));
    let events = record_events(&app);
    assert_eq!(
        invoke(&window, "increment", json!({})),
        Err(json!({ "code": "storage", "kind": "unavailable" }))
    );
    assert!(
        nothing_emitted(&events),
        "no event for a change that was not saved"
    );
}

#[test]
fn log_from_ui_writes_one_line_per_entry_whatever_the_message_holds() {
    let logs = must(tempfile::tempdir(), "a temporary log directory");
    must(
        init_logging(logs.path(), "commands-test", false),
        "logging starts",
    );
    let (_app, window) = app_holding(None);
    // What `scripts/smoke.ts` looks for, after a newline that would start a line of its own.
    let forged = format!("probe-newline\nstartup complete pid={}", std::process::id());
    let long = format!(
        "probe-long {}",
        "y".repeat(UiLogEntry::MAX_MESSAGE_CHARS * 5)
    );
    for (level, message) in [("error", forged.as_str()), ("warn", long.as_str())] {
        let body = json!({ "entry": { "level": level, "message": message } });
        assert_eq!(invoke(&window, "log_from_ui", body), Ok(Value::Null));
    }

    let lines = log_lines(logs.path());
    let with = |needle: &str| -> Vec<&String> {
        lines.iter().filter(|line| line.contains(needle)).collect()
    };
    let expected_tail = format!(
        "ERROR ui: probe-newline\\nstartup complete pid={}",
        std::process::id()
    );
    match with("probe-newline").as_slice() {
        [line] => assert!(line.ends_with(&expected_tail), "{line}"),
        other => panic!("one line for the entry with a newline, got {other:?}"),
    }
    assert_eq!(
        with("startup complete").len(),
        1,
        "the forged text stays inside the UI's line: {lines:?}"
    );
    match with("probe-long").as_slice() {
        [line] => {
            let logged = line
                .split_once("WARN ui: ")
                .map_or(0, |(_, message)| message.chars().count());
            assert!(
                line.ends_with("…[truncated]"),
                "a long message is marked as cut"
            );
            assert!(
                logged <= UiLogEntry::MAX_MESSAGE_CHARS + "…[truncated]".chars().count(),
                "a long message is cut to the limit: {logged} characters"
            );
        }
        other => panic!("one line for the long entry, got {} lines", other.len()),
    }
}

#[test]
fn log_from_ui_accepts_a_warning_and_an_error() {
    let (_app, window) = app_holding(None);
    for level in ["warn", "error"] {
        let body = json!({ "entry": { "level": level, "message": "probe" } });
        assert_eq!(invoke(&window, "log_from_ui", body), Ok(Value::Null));
    }
}

#[test]
fn log_from_ui_rejects_an_unknown_level() {
    let (_app, window) = app_holding(None);
    let body = json!({ "entry": { "level": "shout", "message": "probe" } });
    assert!(invoke(&window, "log_from_ui", body).is_err());
}

#[test]
fn an_unregistered_command_is_rejected() {
    let (_app, window) = app_holding(None);
    assert!(invoke(&window, "explode", json!({})).is_err());
}
