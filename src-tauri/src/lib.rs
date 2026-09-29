//! The Tauri shell: the composition root, and the thin commands and events between the
//! UI and `myapp-core`. It decides nothing: rules live in core, OS access in
//! `myapp-platform` (see `docs/architecture.md`).

mod commands;
mod startup;

use std::sync::Arc;

use myapp_core::{CounterService, Tuning};
use myapp_platform::{
    JsonFileCounterStore, SystemClock, counter_file, home_dir, init_logging, log_dir,
};
use tauri::{Manager, RunEvent, Runtime};

pub use commands::{AppState, COUNTER_CHANGED};
pub use startup::{SMOKE_ENV, StartupActivation, StartupPlan, startup_plan};

/// The file prefix of the app's daily log files (the helper CLI uses `myapp-cli`).
pub const LOG_FILE_PREFIX: &str = "myapp";

/// Why the app could not start. Carries no path: no user data in errors (design D2).
#[derive(Debug, thiserror::Error)]
pub enum StartupError {
    /// `HOME` is not set, so the data and log directories cannot be found.
    #[error("HOME is not set")]
    NoHome,
    /// The log directory could not be used.
    #[error("logging could not start: {0}")]
    Logging(#[from] myapp_platform::LoggingError),
}

/// The real wiring: the JSON file store under the app data directory, the system clock.
fn build_state(home: &std::path::Path) -> AppState {
    AppState {
        counter: Arc::new(CounterService::new(
            Arc::new(JsonFileCounterStore::new(counter_file(home))),
            Arc::new(SystemClock),
            Tuning::default(),
        )),
    }
}

/// Register every command. Shared by `run()` and the command tests, so the tests
/// exercise the same handler list the app ships.
pub fn with_commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        commands::get_counter,
        commands::increment,
        commands::decrement,
        commands::reset,
        commands::log_from_ui,
    ])
}

/// Start the app. In smoke mode (`MYAPP_SMOKE=1`) it runs the same startup path with no
/// window, no Dock icon, and no focus change, logs `startup complete`, and exits 0
/// (design D22).
pub fn run() {
    let plan = startup_plan(std::env::var_os(SMOKE_ENV).is_some());
    let app = with_commands(tauri::Builder::default())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(plan.activation_policy.into());
            let home = home_dir().ok_or(StartupError::NoHome)?;
            init_logging(&log_dir(&home), LOG_FILE_PREFIX, cfg!(debug_assertions))
                .map_err(StartupError::from)?;
            app.manage(build_state(&home));
            if plan.show_window
                && let Some(window) = app.get_webview_window("main")
            {
                window.show()?;
            }
            tracing::info!(
                pid = std::process::id(),
                smoke = plan.exit_after_startup,
                "startup complete"
            );
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            tracing::error!(%error, "the app could not start");
            eprintln!("error: the app could not start: {error}");
            std::process::exit(1);
        }
    };
    app.run(move |handle, event| {
        if plan.exit_after_startup && matches!(event, RunEvent::Ready) {
            handle.exit(0);
        }
    });
}
