//! `myapp`: the command-line tool, and the composition root that wires the real adapters
//! from `myapp-platform` into `myapp-core`.
//!
//! The contract (`docs/architecture.md`): data on stdout, diagnostics on stderr; exit 0
//! on success, 1 when the action failed (at a bound, storage, no home directory, no
//! terminal for `tui`), and 2 on a usage error (clap's own code).

// A `match` on a core enum names each variant, so a new one is a compile error in
// `wording` until it has its words.
#![deny(clippy::wildcard_enum_match_arm)]

mod tui;
mod wording;

use std::io::{self, IsTerminal, Write};
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use myapp_core::{CounterService, CounterView, Tuning};
use myapp_platform::{
    JsonFileCounterStore, SystemClock, counter_file, home_dir, init_logging, log_dir,
};

/// Read and change the counter.
#[derive(Debug, Parser)]
#[command(version)]
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
    /// Open the full-screen counter view (needs an interactive terminal).
    Tui,
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
    match Cli::parse().command {
        Command::Counter { action } => counter(action),
        Command::Tui => tui(),
    }
}

/// The service over the real store and clock under `HOME`, with logging started; `None`
/// once the reason has been printed. `echo_logs` copies log lines to stderr in a debug
/// build, which only a command that does not own the screen may do.
fn compose(echo_logs: bool) -> Option<CounterService> {
    let Some(home) = home_dir() else {
        eprintln!("error: {}", wording::HOME_MISSING);
        return None;
    };
    // Logging is best effort: a read-only log directory must not stop the action.
    if init_logging(
        &log_dir(&home),
        env!("CARGO_PKG_NAME"),
        echo_logs && cfg!(debug_assertions),
    )
    .is_err()
    {
        eprintln!("warning: {}", wording::LOGGING_UNAVAILABLE);
    }
    Some(CounterService::new(
        Arc::new(JsonFileCounterStore::new(counter_file(&home))),
        Arc::new(SystemClock),
        Tuning::default(),
    ))
}

fn counter(action: CounterAction) -> ExitCode {
    let Some(service) = compose(true) else {
        return ExitCode::FAILURE;
    };
    let result = match action {
        CounterAction::Show => service.view(),
        CounterAction::Increment => service.increment(),
    };
    match result {
        Ok(view) => {
            tracing::info!(?action, value = view.value, "counter action succeeded");
            // `println!` would panic (an abort in release) when stdout is closed or
            // unwritable, as in `myapp counter show | true`.
            if writeln!(io::stdout().lock(), "{}", render(&view)).is_err() {
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

fn tui() -> ExitCode {
    // Checked before anything else is touched: without a terminal on both ends there is
    // no screen to draw and no key to read, and waiting for one would hang a script.
    if !(io::stdin().is_terminal() && io::stdout().is_terminal()) {
        eprintln!("error: {}", wording::TERMINAL_MISSING);
        return ExitCode::FAILURE;
    }
    // Nothing may write to the terminal while the screen owns it, so logs go to the file only.
    let Some(service) = compose(false) else {
        return ExitCode::FAILURE;
    };
    match tui::run(&service) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(kind = ?error.kind(), "the terminal failed");
            eprintln!("error: {}", wording::TERMINAL_FAILED);
            ExitCode::FAILURE
        }
    }
}
