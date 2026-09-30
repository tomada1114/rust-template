//! The commands through Tauri's mock runtime (`tauri::test`): argument decoding, the
//! JSON the UI receives, error codes, and the `counter-changed` event. The state holds
//! core's service over test-support fakes, so nothing touches the disk or a window.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use myapp_core::{CounterService, StoredCounter, Tuning};
use myapp_lib::{AppState, COUNTER_CHANGED, with_commands};
use myapp_test_support::{FixedClock, InMemoryCounterStore};
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
    let service = CounterService::new(
        Arc::new(store),
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

#[test]
fn get_counter_returns_the_view_as_camel_case_json() {
    let (_app, window) = app_holding(Some(1));
    assert_eq!(
        invoke(&window, "get_counter", json!({})),
        Ok(json!({ "value": 1, "lastChangedAt": null }))
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
fn decrement_and_reset_return_the_new_view() {
    let (_app, window) = app_holding(Some(2));
    assert_eq!(
        invoke(&window, "decrement", json!({})),
        Ok(json!({ "value": 1, "lastChangedAt": T0 }))
    );
    assert_eq!(
        invoke(&window, "reset", json!({})),
        Ok(json!({ "value": 0, "lastChangedAt": T0 }))
    );
}

#[test]
fn increment_at_the_maximum_rejects_with_a_code_and_emits_nothing() {
    let (app, window) = app_holding(Some(2));
    let events = record_events(&app);
    assert_eq!(
        invoke(&window, "increment", json!({})),
        Err(json!({ "code": "atMaximum" }))
    );
    assert!(
        events.recv_timeout(Duration::from_millis(200)).is_err(),
        "no event for a rejected change"
    );
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
