//! Time as core sees it: a number of milliseconds, handed in by a [`Clock`].

use serde::{Deserialize, Serialize};

/// Milliseconds since the Unix epoch. Core never reads the clock itself (see [`Clock`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct UnixMillis(pub i64);

/// The source of the current time: `SystemClock` (platform) in the app, `FixedClock`
/// (test-support) in tests. Injected so a test never sleeps and never depends on the date.
/// It is a wall clock: a later read may return an earlier time when the system time is
/// corrected, so nothing may depend on two reads being in order.
pub trait Clock: Send + Sync {
    /// The current time.
    fn now(&self) -> UnixMillis;
}
