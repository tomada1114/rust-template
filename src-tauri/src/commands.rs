//! The commands the UI invokes and the event it listens to (design D4, D6).
//!
//! A command decides nothing: it moves the work to a blocking thread (file I/O stays off
//! the IPC thread), calls core, emits the change, and logs one line. Command and event
//! names are contract: `ui/src/ipc/commands.ts` and `ui/src/ipc/events.ts` use the same
//! strings, and a harness check compares them.

use std::sync::Arc;

use myapp_core::{
    CounterError, CounterService, CounterView, StorageErrorKind, UiLogEntry, UiLogLevel,
};
use tauri::{AppHandle, Emitter, Runtime, State};

/// Emitted with the new [`CounterView`] after every change.
pub const COUNTER_CHANGED: &str = "counter-changed";

/// What the commands share. Managed by the app (`app.manage`).
pub struct AppState {
    /// The counter's use cases, over the real store and clock.
    pub counter: Arc<CounterService>,
}

/// Run a counter use case on a blocking thread. A worker that panicked or was cancelled
/// is reported as unavailable storage, never as a panic across IPC.
async fn on_blocking_thread(
    state: &State<'_, AppState>,
    action: fn(&CounterService) -> Result<CounterView, CounterError>,
) -> Result<CounterView, CounterError> {
    let service = Arc::clone(&state.counter);
    tauri::async_runtime::spawn_blocking(move || action(&service))
        .await
        .map_err(|_| CounterError::Storage {
            kind: StorageErrorKind::Unavailable,
        })?
}

/// Tell every window the counter changed. A failed emit never fails the command.
fn announce<R: Runtime>(app: &AppHandle<R>, view: &CounterView) {
    if let Err(error) = app.emit(COUNTER_CHANGED, view) {
        tracing::warn!(%error, "counter-changed was not delivered");
    }
}

/// Log the outcome of a counter command: one line either way.
fn log_outcome(command: &'static str, result: &Result<CounterView, CounterError>) {
    match result {
        Ok(view) => tracing::info!(command, value = view.value, "counter command succeeded"),
        Err(error) => tracing::warn!(command, %error, "counter command failed"),
    }
}

/// The counter as it is now.
#[tauri::command]
pub async fn get_counter(state: State<'_, AppState>) -> Result<CounterView, CounterError> {
    let result = on_blocking_thread(&state, CounterService::view).await;
    log_outcome("get_counter", &result);
    result
}

async fn change<R: Runtime>(
    command: &'static str,
    state: &State<'_, AppState>,
    app: &AppHandle<R>,
    action: fn(&CounterService) -> Result<CounterView, CounterError>,
) -> Result<CounterView, CounterError> {
    let result = on_blocking_thread(state, action).await;
    log_outcome(command, &result);
    let view = result?;
    announce(app, &view);
    Ok(view)
}

/// Add one.
#[tauri::command]
pub async fn increment<R: Runtime>(
    state: State<'_, AppState>,
    app: AppHandle<R>,
) -> Result<CounterView, CounterError> {
    change("increment", &state, &app, CounterService::increment).await
}

/// Subtract one.
#[tauri::command]
pub async fn decrement<R: Runtime>(
    state: State<'_, AppState>,
    app: AppHandle<R>,
) -> Result<CounterView, CounterError> {
    change("decrement", &state, &app, CounterService::decrement).await
}

/// Back to the minimum.
#[tauri::command]
pub async fn reset<R: Runtime>(
    state: State<'_, AppState>,
    app: AppHandle<R>,
) -> Result<CounterView, CounterError> {
    change("reset", &state, &app, CounterService::reset).await
}

/// Record a warning or error the UI caught (`ui/src/ipc/log.ts`), as one line holding
/// core's escaped and length-capped [`UiLogEntry::loggable_message`]. The log writer is
/// synchronous, so the write runs on a blocking thread, off the main thread.
#[tauri::command]
pub async fn log_from_ui(entry: UiLogEntry) {
    let written = tauri::async_runtime::spawn_blocking(move || {
        let message = entry.loggable_message();
        match entry.level {
            UiLogLevel::Warn => tracing::warn!(target: "ui", %message),
            UiLogLevel::Error => tracing::error!(target: "ui", %message),
        }
    })
    .await;
    if let Err(error) = written {
        tracing::warn!(%error, "a UI log entry was not written");
    }
}
