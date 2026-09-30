//! `myapp-cli`: the helper executable bundled inside the app as a sidecar.
//!
//! It reads and writes the same store as the app, through the same core and platform
//! code, without starting the GUI — the shape a launchd job needs.
//!
//! Exit codes: 0 success; 1 the action failed (at a bound, storage, no home directory);
//! 2 a usage error (clap's own code).

use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use myapp_core::{CounterError, CounterService, CounterView, StorageErrorKind, Tuning};
use myapp_platform::{
    JsonFileCounterStore, SystemClock, cli_log_dir, counter_file, home_dir, init_logging,
};

/// The app's helper: reads and changes the same counter the app shows.
#[derive(Debug, Parser)]
#[command(name = "myapp-cli", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Read or change the counter.
    Counter {
        #[command(subcommand)]
        action: CounterAction,
    },
}

#[derive(Debug, Clone, Copy, Subcommand)]
enum CounterAction {
    /// Print the current value.
    Show,
    /// Add one and print the new value.
    Increment,
}

/// Printed to stderr for a failed action. The CLI is developer-facing, so the wording
/// lives here rather than in the UI's copy.
fn describe(error: CounterError) -> &'static str {
    match error {
        CounterError::AtMaximum => "the counter is already at its maximum",
        CounterError::AtMinimum => "the counter is already at its minimum",
        CounterError::Storage {
            kind: StorageErrorKind::Unavailable,
        } => "the counter file could not be read or written",
        CounterError::Storage {
            kind: StorageErrorKind::Corrupt,
        } => "the counter file holds data this version cannot read",
    }
}

fn render(view: &CounterView) -> String {
    view.value.to_string()
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let Some(home) = home_dir() else {
        eprintln!("error: HOME is not set, so the counter file cannot be found");
        return ExitCode::FAILURE;
    };
    // Logging is best effort for a helper: a read-only log directory must not stop it.
    if init_logging(&cli_log_dir(&home), "myapp-cli", cfg!(debug_assertions)).is_err() {
        eprintln!("warning: logging is unavailable for this run");
    }

    let service = CounterService::new(
        Arc::new(JsonFileCounterStore::new(counter_file(&home))),
        Arc::new(SystemClock),
        Tuning::default(),
    );
    let Command::Counter { action } = cli.command;
    let result = match action {
        CounterAction::Show => service.view(),
        CounterAction::Increment => service.increment(),
    };
    match result {
        Ok(view) => {
            tracing::info!(?action, value = view.value, "cli counter action succeeded");
            println!("{}", render(&view));
            ExitCode::SUCCESS
        }
        Err(error) => {
            tracing::warn!(?action, %error, "cli counter action failed");
            eprintln!("error: {}", describe(error));
            ExitCode::FAILURE
        }
    }
}
