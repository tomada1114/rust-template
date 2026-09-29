use std::sync::Mutex;
use std::sync::PoisonError;

use myapp_core::{Clock, UnixMillis};

/// A clock that returns whatever it was set to. Tests move time with [`FixedClock::set`]
/// or [`FixedClock::advance`] instead of sleeping.
#[derive(Debug)]
pub struct FixedClock {
    now: Mutex<UnixMillis>,
}

impl FixedClock {
    /// 2023-11-14T22:13:20Z — a fixed, recognisable instant.
    pub const DEFAULT: UnixMillis = UnixMillis(1_700_000_000_000);

    /// A clock stopped at `now`.
    #[must_use]
    pub const fn at(now: UnixMillis) -> Self {
        Self {
            now: Mutex::new(now),
        }
    }

    /// Move the clock to `now`.
    pub fn set(&self, now: UnixMillis) {
        *self.now.lock().unwrap_or_else(PoisonError::into_inner) = now;
    }

    /// Move the clock forward by `millis`.
    pub fn advance(&self, millis: i64) {
        let mut now = self.now.lock().unwrap_or_else(PoisonError::into_inner);
        *now = UnixMillis(now.0 + millis);
    }
}

impl Default for FixedClock {
    fn default() -> Self {
        Self::at(Self::DEFAULT)
    }
}

impl Clock for FixedClock {
    fn now(&self) -> UnixMillis {
        *self.now.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The behaviour every [`Clock`] must have: a time after 2020, and never going backwards
/// between two reads.
///
/// # Panics
/// When the clock breaks the contract; that is how the calling test fails.
pub fn clock_contract(mut make: impl FnMut() -> Box<dyn Clock>) {
    const JAN_1_2020: UnixMillis = UnixMillis(1_577_836_800_000);
    let clock = make();
    let first = clock.now();
    assert!(
        first > JAN_1_2020,
        "a clock reads milliseconds since the Unix epoch: {first:?}"
    );
    let second = clock.now();
    assert!(
        second >= first,
        "a clock never runs backwards: {first:?} then {second:?}"
    );
}
