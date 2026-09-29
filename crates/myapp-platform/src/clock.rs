use std::time::{SystemTime, UNIX_EPOCH};

use myapp_core::{Clock, UnixMillis};

/// The wall clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> UnixMillis {
        // A clock set before 1970 reads as the epoch rather than failing: a wrong
        // timestamp is recoverable, a panic in a command is not.
        let since_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        UnixMillis(i64::try_from(since_epoch.as_millis()).unwrap_or(i64::MAX))
    }
}
