//! `myapp`: the command-line tool, and the composition root that wires the real adapters
//! from `myapp-platform` into `myapp-core`.
//!
//! The contract (`docs/architecture.md`): data on stdout, diagnostics on stderr; exit 0
//! on success, 1 when the action failed (at a bound, storage, no home directory), and 2
//! on a usage error (clap's own code).

// A `match` on a core enum names each variant, so a new one is a compile error in
// `wording` until it has its words.
#![deny(clippy::wildcard_enum_match_arm)]

mod wording;

use std::io::Write;
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use myapp_core::{CounterService, CounterView, Tuning};
use myapp_platform::{
    JsonFileCounterStore, SystemClock, counter_file, home_dir, init_logging, log_dir,
};

/// Read and change the counter.
#[derive(Debug, Parser)]
#[command(version, about)]
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

fn render(view: &CounterView) -> String {
    view.value.to_string()
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let Some(home) = home_dir() else {
        eprintln!("error: {}", wording::HOME_MISSING);
        return ExitCode::FAILURE;
    };
    // Logging is best effort: a read-only log directory must not stop the action.
    if init_logging(
        &log_dir(&home),
        env!("CARGO_PKG_NAME"),
        cfg!(debug_assertions),
    )
    .is_err()
    {
        eprintln!("warning: {}", wording::LOGGING_UNAVAILABLE);
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
            tracing::info!(?action, value = view.value, "counter action succeeded");
            // `println!` would panic (an abort in release) when stdout is closed or
            // unwritable, as in `myapp counter show | true`.
            if writeln!(std::io::stdout().lock(), "{}", render(&view)).is_err() {
                eprintln!("error: {}", wording::STDOUT_UNAVAILABLE);
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            tracing::warn!(?action, %error, "counter action failed");
            eprintln!("error: {}", wording::counter_error(error));
            ExitCode::FAILURE
        }
    }
}
