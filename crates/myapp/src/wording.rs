//! Every sentence `myapp` writes to stderr. Core reports a failure as a code and never as
//! a sentence, so the wording for each code lives here, in one place, and each `match`
//! names every variant: a new core variant does not compile until it has its words.

use myapp_core::{CounterError, StorageErrorKind};

/// Printed when `HOME` is unset or empty, so no file location can be derived.
pub const HOME_MISSING: &str = "HOME is not set, so the counter file cannot be found";

/// Printed when the log directory cannot be used; the action still runs.
pub const LOGGING_UNAVAILABLE: &str = "logging is unavailable for this run";

/// The wording for a failed counter action.
pub fn counter_error(error: CounterError) -> &'static str {
    match error {
        CounterError::AtMaximum => "the counter is already at its maximum",
        CounterError::AtMinimum => "the counter is already at its minimum",
        CounterError::Storage { kind } => storage_error(kind),
    }
}

/// The wording for a storage failure behind a counter action.
fn storage_error(kind: StorageErrorKind) -> &'static str {
    match kind {
        StorageErrorKind::Unavailable => "the counter file could not be read or written",
        StorageErrorKind::Corrupt => "the counter file holds data this version cannot read",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_maximum_says_the_counter_cannot_go_higher() {
        assert_eq!(
            counter_error(CounterError::AtMaximum),
            "the counter is already at its maximum"
        );
    }

    #[test]
    fn at_minimum_says_the_counter_cannot_go_lower() {
        assert_eq!(
            counter_error(CounterError::AtMinimum),
            "the counter is already at its minimum"
        );
    }

    #[test]
    fn unavailable_storage_says_the_file_could_not_be_used() {
        assert_eq!(
            counter_error(CounterError::Storage {
                kind: StorageErrorKind::Unavailable
            }),
            "the counter file could not be read or written"
        );
    }

    #[test]
    fn corrupt_storage_says_the_file_cannot_be_read_by_this_version() {
        assert_eq!(
            counter_error(CounterError::Storage {
                kind: StorageErrorKind::Corrupt
            }),
            "the counter file holds data this version cannot read"
        );
    }
}
