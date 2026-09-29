//! The composition root through Tauri's mock runtime: `compose` wires the real store
//! under a temporary `HOME`, and `finish_startup` — the setup body `run()` uses — behaves
//! the same under both startup plans apart from the window's visibility (design D22).

use std::path::Path;

use myapp_lib::{
    AppState, MAIN_WINDOW, StartupError, StartupPlan, compose, finish_startup, startup_plan,
};
use myapp_platform::counter_file;
use serde_json::{Value, json};
use tauri::http::HeaderMap;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// A setup step that must succeed for the test to mean anything; panics with context.
fn must<T, E: std::fmt::Debug>(result: Result<T, E>, what: &str) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{what}: {error:?}"),
    }
}

/// The app `run()` composes for `home`, on the mock runtime.
fn composed_app(home: &Path) -> App<MockRuntime> {
    must(
        compose(mock_builder(), home).build(mock_context(noop_assets())),
        "the mock app builds",
    )
}

/// The window `tauri.conf.json` declares; the mock context creates none by itself.
fn main_window(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    must(
        WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::default()).build(),
        "the mock window builds",
    )
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

/// A command's outcome without the wall-clock `lastChangedAt` the real clock stamps.
fn without_time(outcome: Result<Value, Value>) -> Result<Value, Value> {
    outcome.map(|value| match value.get("value") {
        Some(counter) => counter.clone(),
        None => value,
    })
}

/// The value `counter.json` under `home` holds.
fn saved_value(home: &Path) -> Value {
    let bytes = must(
        std::fs::read(counter_file(home)),
        "counter.json is readable",
    );
    let file: Value = must(serde_json::from_slice(&bytes), "counter.json is JSON");
    file["counter"]["value"].clone()
}

#[test]
fn the_composed_app_saves_an_increment_to_the_counter_file_under_home() {
    let home = must(tempfile::tempdir(), "a temporary HOME");
    let app = composed_app(home.path());
    let window = main_window(&app);

    let incremented = invoke(&window, "increment", json!({}));

    assert_eq!(without_time(incremented), Ok(json!(1)));
    assert_eq!(saved_value(home.path()), json!(1));
}

/// Run the setup body under `plan`, then every command, in a fresh `HOME`.
fn setup_then_every_command(plan: StartupPlan) -> (bool, Vec<Result<Value, Value>>, Value) {
    let home = must(tempfile::tempdir(), "a temporary HOME");
    let app = composed_app(home.path());
    let window = main_window(&app);
    must(finish_startup(app.handle(), plan), "setup succeeds");

    let managed = app.try_state::<AppState>().is_some();
    let log_entry = json!({ "entry": { "level": "warn", "message": "probe" } });
    let outcomes = [
        ("get_counter", json!({})),
        ("decrement", json!({})),
        ("increment", json!({})),
        ("increment", json!({})),
        ("decrement", json!({})),
        ("increment", json!({})),
        ("reset", json!({})),
        ("increment", json!({})),
        ("log_from_ui", log_entry),
        ("explode", json!({})),
    ]
    .into_iter()
    .map(|(cmd, body)| without_time(invoke(&window, cmd, body)))
    .collect();
    (managed, outcomes, saved_value(home.path()))
}

#[test]
fn setup_leaves_the_same_state_and_commands_under_both_plans() {
    let normal = setup_then_every_command(startup_plan(false));
    let smoke = setup_then_every_command(startup_plan(true));

    let (managed, outcomes, saved) = &smoke;
    assert!(managed, "AppState is managed");
    assert_eq!(
        outcomes.get(..9),
        Some(
            &[
                Ok(json!(0)),
                Err(json!({ "code": "atMinimum" })),
                Ok(json!(1)),
                Ok(json!(2)),
                Ok(json!(1)),
                Ok(json!(2)),
                Ok(json!(0)),
                Ok(json!(1)),
                Ok(Value::Null),
            ][..]
        )
    );
    assert!(
        outcomes.get(9).is_some_and(Result::is_err),
        "an unregistered command is rejected"
    );
    assert_eq!(saved, &json!(1));
    assert_eq!(normal, smoke);
}

#[test]
fn startup_fails_without_the_main_window_under_both_plans() {
    for smoke in [false, true] {
        let home = must(tempfile::tempdir(), "a temporary HOME");
        let app = composed_app(home.path());
        let result = finish_startup(app.handle(), startup_plan(smoke));
        assert!(
            matches!(result, Err(StartupError::NoMainWindow)),
            "smoke={smoke}: {result:?}"
        );
    }
}

#[test]
fn the_configuration_declares_the_main_window() {
    let config: Value = must(
        serde_json::from_str(include_str!("../tauri.conf.json")),
        "tauri.conf.json is JSON",
    );
    let labels: Vec<&str> = config["app"]["windows"]
        .as_array()
        .map(|windows| {
            windows
                .iter()
                .filter_map(|window| window["label"].as_str())
                .collect()
        })
        .unwrap_or_default();
    assert!(labels.contains(&MAIN_WINDOW), "window labels: {labels:?}");
}
