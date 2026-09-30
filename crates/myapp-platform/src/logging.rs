use std::path::Path;

use tracing::Level;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::fmt::writer::{BoxMakeWriter, MakeWriterExt};

/// How many daily log files are kept (design D7).
pub const LOG_FILES_KEPT: usize = 14;

/// Logging could not be set up. Carries no path: the caller knows which directory it passed.
#[derive(Debug, thiserror::Error)]
pub enum LoggingError {
    /// The log directory could not be created or opened.
    #[error("the log directory is unavailable")]
    Directory,
    /// A global subscriber was already installed in this process.
    #[error("logging was already initialised")]
    AlreadyInitialised,
}

/// Install the process-wide `tracing` subscriber: daily files named
/// `<prefix>.<YYYY-MM-DD>.log` (dated in UTC) in `dir`, keeping the last
/// [`LOG_FILES_KEPT`]; with `also_stderr`, every line goes to stderr too.
///
/// Only the Tauri shell and the helper CLI call this; libraries only emit events. The
/// appender writes synchronously — no background worker whose last lines a
/// `process::exit` could drop (design D7).
///
/// Retention counts every regular file in `dir` with a UTF-8 name that starts with
/// `prefix` and ends with `log`, deleting the oldest by creation time (the date in the
/// name where the file system has none), so `dir` must hold no other writer's files whose
/// name begins with `prefix`: give each writer its own directory ([`crate::cli_log_dir`]
/// for the helper). Subdirectories are never counted.
///
/// # Errors
/// [`LoggingError`] when the directory cannot be used or a subscriber already exists.
pub fn init_logging(dir: &Path, prefix: &str, also_stderr: bool) -> Result<(), LoggingError> {
    std::fs::create_dir_all(dir).map_err(|_| LoggingError::Directory)?;
    let file = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(prefix)
        .filename_suffix("log")
        .max_log_files(LOG_FILES_KEPT)
        .build(dir)
        .map_err(|_| LoggingError::Directory)?;
    let writer = if also_stderr {
        BoxMakeWriter::new(file.and(std::io::stderr))
    } else {
        BoxMakeWriter::new(file)
    };
    tracing_subscriber::fmt()
        .with_writer(writer)
        .with_ansi(false)
        .with_max_level(Level::INFO)
        .try_init()
        .map_err(|_| LoggingError::AlreadyInitialised)
}
