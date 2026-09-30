//! The Tauri shell: the composition root, and the thin commands and events between the
//! UI and `myapp-core`. It decides nothing: rules live in core, OS access in
//! `myapp-platform` (see `docs/architecture.md`).

mod commands;
mod startup;

use std::path::Path;
use std::sync::Arc;

use myapp_core::{CounterService, Tuning};
use myapp_platform::{
    JsonFileCounterStore, SystemClock, counter_file, home_dir, init_logging, log_dir,
};
use tauri::{App, AppHandle, Manager, RunEvent, Runtime};

pub use commands::{AppState, COUNTER_CHANGED};
pub use startup::{SMOKE_ENV, StartupActivation, StartupPlan, smoke_requested, startup_plan};

/// The file prefix of the app's daily log files in `log_dir` (the helper CLI logs as
/// `myapp-cli` in its own directory, `myapp_platform::cli_log_dir`).
pub const LOG_FILE_PREFIX: &str = "myapp";

/// The label of the window `tauri.conf.json` declares. Startup fails without it, so a
/// renamed label stops `just smoke` instead of silently never showing the window.
pub const MAIN_WINDOW: &str = "main";

/// Why the app could not start. Carries no path: no user data in errors.
#[derive(Debug, thiserror::Error)]
pub enum StartupError {
    /// `HOME` is not set, so the data and log directories cannot be found.
    #[error("HOME is not set")]
    NoHome,
    /// The log directory could not be used.
    #[error("logging could not start: {0}")]
    Logging(#[from] myapp_platform::LoggingError),
    /// Tauri could not build the app from its configuration.
    #[error("the app could not be built: {0}")]
    Build(#[source] tauri::Error),
    /// No window carries [`MAIN_WINDOW`]'s label: `tauri.conf.json` and the shell disagree.
    #[error("the main window is missing")]
    NoMainWindow,
    /// The main window exists but could not be shown.
    #[error("the main window could not be shown: {0}")]
    ShowWindow(#[source] tauri::Error),
}

/// The real wiring: the JSON file store under the app data directory, the system clock.
fn build_state(home: &Path) -> AppState {
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

/// The composition: the real state for this `home` and every command. `run()` builds
/// the app from it, and a `tauri::test` test drives it against a temporary `home`, so
/// the wiring the app ships is the wiring under test.
pub fn compose<R: Runtime>(builder: tauri::Builder<R>, home: &Path) -> tauri::Builder<R> {
    with_commands(builder).manage(build_state(home))
}

/// The setup step, once the event loop has created the configured windows: show the main
/// window when the plan says so, then log `startup complete`. Both plans run the same
/// body; only the window's visibility differs.
///
/// # Errors
///
/// [`StartupError::NoMainWindow`] when no window is labelled [`MAIN_WINDOW`], whatever
/// the plan, and [`StartupError::ShowWindow`] when showing it fails.
pub fn finish_startup<R: Runtime>(
    app: &AppHandle<R>,
    plan: StartupPlan,
) -> Result<(), StartupError> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or(StartupError::NoMainWindow)?;
    if plan.show_window {
        window.show().map_err(StartupError::ShowWindow)?;
    }
    tracing::info!(
        pid = std::process::id(),
        smoke = plan.exit_after_startup,
        "startup complete"
    );
    Ok(())
}

/// Everything that can fail before the event loop starts: home, logging, the composed
/// state and commands, the built app, and the activation policy — set here, between
/// `build` and `run`, so macOS applies it when the app finishes launching instead of
/// after it has already activated as a regular app.
fn prepare(plan: StartupPlan) -> Result<App, StartupError> {
    let home = home_dir().ok_or(StartupError::NoHome)?;
    init_logging(&log_dir(&home), LOG_FILE_PREFIX, cfg!(debug_assertions))?;
    let mut app = compose(tauri::Builder::default(), &home)
        .setup(move |app| {
            // An error returned from setup makes Tauri panic, which `panic = "abort"`
            // turns into SIGABRT and a crash report; exit 1 instead.
            if let Err(error) = finish_startup(app.handle(), plan) {
                exit_after_startup_error(&error);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(StartupError::Build)?;
    #[cfg(target_os = "macos")]
    app.set_activation_policy(plan.activation_policy.into());
    Ok(app)
}

/// Report a startup error and exit 1. It also goes to stderr, because logging may not
/// have started (no `HOME`), and `just smoke` reads it there.
fn exit_after_startup_error(error: &StartupError) -> ! {
    tracing::error!(%error, "the app could not start");
    eprintln!("error: the app could not start: {error}");
    std::process::exit(1);
}

/// Start the app. In smoke mode (`MYAPP_SMOKE=1`) it runs the same startup path with no
/// window, no Dock icon, and no focus change, logs `startup complete`, and exits 0; any
/// startup error exits 1.
pub fn run() {
    let plan = startup_plan(smoke_requested(std::env::var_os(SMOKE_ENV).as_deref()));
    let app = match prepare(plan) {
        Ok(app) => app,
        Err(error) => exit_after_startup_error(&error),
    };
    app.run(move |handle, event| {
        if plan.exit_after_startup && matches!(event, RunEvent::Ready) {
            handle.exit(0);
        }
    });
}
