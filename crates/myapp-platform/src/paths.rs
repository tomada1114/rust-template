use std::path::{Path, PathBuf};

/// The bundle identifier. Must equal the justfile's `bundle_id` (a harness check
/// compares them); the bootstrap renames both.
pub const BUNDLE_IDENTIFIER: &str = "com.example.myapp";

/// The counter's file name inside [`app_data_dir`].
pub const COUNTER_FILE_NAME: &str = "counter.json";

/// The user's home directory, from `HOME`. Tests point `HOME` at a temporary directory,
/// so nothing they run touches the real `~/Library`.
#[must_use]
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// `~/Library/Application Support/<identifier>` — the directory Tauri's
/// `app_data_dir()` returns on macOS, so the app and the helper CLI share it.
#[must_use]
pub fn app_data_dir(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join(BUNDLE_IDENTIFIER)
}

/// `~/Library/Logs/<identifier>` — the log directory Tauri documents for macOS, and the
/// app's; the helper CLI logs to [`cli_log_dir`] under it.
#[must_use]
pub fn log_dir(home: &Path) -> PathBuf {
    home.join("Library").join("Logs").join(BUNDLE_IDENTIFIER)
}

/// The helper CLI's log subdirectory inside [`log_dir`].
pub const CLI_LOG_DIR_NAME: &str = "cli";

/// `~/Library/Logs/<identifier>/cli` — the helper CLI's log directory. It is separate
/// from the app's because log retention counts every file in a directory whose name
/// starts with the writer's prefix, and the app's prefix is a prefix of the helper's.
#[must_use]
pub fn cli_log_dir(home: &Path) -> PathBuf {
    log_dir(home).join(CLI_LOG_DIR_NAME)
}

/// Where the app and the CLI keep the counter.
#[must_use]
pub fn counter_file(home: &Path) -> PathBuf {
    app_data_dir(home).join(COUNTER_FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directories_follow_the_macos_conventions() {
        let home = Path::new("/Users/someone");
        assert_eq!(
            app_data_dir(home),
            PathBuf::from("/Users/someone/Library/Application Support/com.example.myapp")
        );
        assert_eq!(
            log_dir(home),
            PathBuf::from("/Users/someone/Library/Logs/com.example.myapp")
        );
        assert_eq!(
            cli_log_dir(home),
            PathBuf::from("/Users/someone/Library/Logs/com.example.myapp/cli")
        );
        assert_eq!(
            counter_file(home),
            PathBuf::from(
                "/Users/someone/Library/Application Support/com.example.myapp/counter.json"
            )
        );
    }
}
