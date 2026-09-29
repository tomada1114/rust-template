//! A log line the UI asks the shell to record (`log_from_ui`).

use serde::Deserialize;
use ts_rs::TS;

/// How serious a UI log entry is. The UI forwards only warnings and errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UiLogLevel {
    /// Something unexpected that the UI recovered from.
    Warn,
    /// Something failed.
    Error,
}

/// One entry from the UI's `ipc/log.ts`. The message must carry no user data: it is
/// written to the log file as-is.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UiLogEntry {
    /// Severity.
    pub level: UiLogLevel,
    /// What happened, in developer terms (never user-facing wording).
    pub message: String,
}
