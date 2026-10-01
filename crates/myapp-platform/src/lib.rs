//! Adapters implementing `myapp-core`'s ports against the real operating system.
//!
//! Each adapter translates: it turns OS results into core's types and OS failures into
//! core's error kinds, and decides nothing. The data and log directories are chosen per
//! OS in `paths`; macOS-only code goes behind `#[cfg(target_os = "macos")]` so this crate
//! still builds and tests on Linux CI.

mod clock;
mod counter_store;
mod logging;
mod paths;

pub use clock::SystemClock;
pub use counter_store::JsonFileCounterStore;
pub use logging::{LOG_FILES_KEPT, LoggingError, init_logging};
pub use paths::{
    BUNDLE_IDENTIFIER, COUNTER_FILE_NAME, XDG_APP_NAME, app_data_dir, counter_file, home_dir,
    log_dir, macos_data_dir, macos_log_dir, xdg_data_dir, xdg_log_dir,
};
