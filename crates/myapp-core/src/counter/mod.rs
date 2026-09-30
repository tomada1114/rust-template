//! The sample counter: a bounded value whose rules live here, persisted
//! through the [`CounterStore`] port and time-stamped through the [`Clock`] port.
//!
//! Every part of it is a deletable illustration: `starting-an-app` lists what to remove
//! when an app replaces the sample.

pub mod store;

use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use ts_rs::TS;

use crate::time::{Clock, UnixMillis};
pub use store::{CounterStore, StorageError, StorageErrorKind, StoredCounter};

/// Tunables in one place (designing-core-logic). Built only by [`Tuning::new`] (or
/// [`Default`]), so every `Tuning` holds a range with at least one value in it.
///
/// ```
/// use myapp_core::{Counter, Tuning, TuningError};
///
/// let tuning = Tuning::new(0, 3)?;
/// assert_eq!(Counter::new(7, tuning).value(), 3);
/// assert_eq!(Tuning::new(5, 1), Err(TuningError::MinAboveMax));
/// # Ok::<(), TuningError>(())
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tuning {
    min: i64,
    max: i64,
}

impl Tuning {
    /// A range from `min` to `max`, both included.
    ///
    /// # Errors
    /// [`TuningError::MinAboveMax`] when `min > max`: no value lies in that range, so a
    /// counter could not stay inside it.
    pub const fn new(min: i64, max: i64) -> Result<Self, TuningError> {
        if min > max {
            return Err(TuningError::MinAboveMax);
        }
        Ok(Self { min, max })
    }

    /// The lowest value; also the value a fresh or reset counter holds.
    #[must_use]
    pub const fn min(&self) -> i64 {
        self.min
    }

    /// The highest value.
    #[must_use]
    pub const fn max(&self) -> i64 {
        self.max
    }
}

impl Default for Tuning {
    fn default() -> Self {
        Self { min: 0, max: 99 }
    }
}

/// A [`Tuning`] that no counter could stay inside.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TuningError {
    /// `min` is above `max`, so the range holds no value.
    #[error("the tuning's minimum is above its maximum")]
    MinAboveMax,
}

/// A counter value that never leaves its range. Pure: no I/O, no time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counter {
    value: i64,
    tuning: Tuning,
}

impl Counter {
    /// A counter holding `value`, pulled into `tuning`'s range if it lies outside it
    /// (a stored value from a build with a wider range, say).
    #[must_use]
    pub fn new(value: i64, tuning: Tuning) -> Self {
        // `clamp` panics when min > max; `Tuning::new` refuses that range.
        Self {
            value: value.clamp(tuning.min, tuning.max),
            tuning,
        }
    }

    /// The current value.
    #[must_use]
    pub const fn value(&self) -> i64 {
        self.value
    }

    /// One more.
    ///
    /// # Errors
    /// [`CounterError::AtMaximum`] when the value is already at `tuning.max`.
    pub fn increment(self) -> Result<Self, CounterError> {
        if self.value >= self.tuning.max {
            return Err(CounterError::AtMaximum);
        }
        Ok(Self {
            value: self.value + 1,
            ..self
        })
    }

    /// One less.
    ///
    /// # Errors
    /// [`CounterError::AtMinimum`] when the value is already at `tuning.min`.
    pub fn decrement(self) -> Result<Self, CounterError> {
        if self.value <= self.tuning.min {
            return Err(CounterError::AtMinimum);
        }
        Ok(Self {
            value: self.value - 1,
            ..self
        })
    }

    /// Back to `tuning.min`.
    #[must_use]
    pub fn reset(self) -> Self {
        Self {
            value: self.tuning.min,
            ..self
        }
    }
}

/// What the UI renders. The only counter type that crosses IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "export-bindings", ts(export))]
pub struct CounterView {
    /// The current value.
    pub value: i64,
    /// When the value last changed; `None` before the first change.
    pub last_changed_at: Option<UnixMillis>,
}

/// A failed counter action. Serialized with a `code` tag (`{ "code": "atMaximum" }`);
/// the UI owns the wording (`ui/src/copy/`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, Serialize, TS)]
#[serde(tag = "code", rename_all = "camelCase")]
#[cfg_attr(feature = "export-bindings", ts(export))]
pub enum CounterError {
    /// Already at the highest value; nothing changed.
    #[error("the counter is at its maximum")]
    AtMaximum,
    /// Already at the lowest value; nothing changed.
    #[error("the counter is at its minimum")]
    AtMinimum,
    /// The store failed; nothing changed.
    #[error("counter storage failed: {kind:?}")]
    Storage {
        /// What kind of storage failure.
        kind: StorageErrorKind,
    },
}

impl From<StorageError> for CounterError {
    fn from(error: StorageError) -> Self {
        Self::Storage { kind: error.kind }
    }
}

/// The counter's use cases: load, decide, save, and report a [`CounterView`].
///
/// One `CounterService` is shared by every command. Its lock is held across
/// load → decide → save, so two commands running at once cannot lose an update, and the
/// step runs through [`CounterStore::update`], so a store shared with another process
/// (the app and the helper CLI) keeps the other process's saves out of it too.
pub struct CounterService {
    lock: Mutex<()>,
    store: Arc<dyn CounterStore>,
    clock: Arc<dyn Clock>,
    tuning: Tuning,
}

impl CounterService {
    /// A service over the given store and clock.
    #[must_use]
    pub fn new(store: Arc<dyn CounterStore>, clock: Arc<dyn Clock>, tuning: Tuning) -> Self {
        Self {
            lock: Mutex::new(()),
            store,
            clock,
            tuning,
        }
    }

    /// The counter as it is now; a fresh counter when nothing was saved yet.
    ///
    /// # Errors
    /// [`CounterError::Storage`] when the store cannot be read.
    pub fn view(&self) -> Result<CounterView, CounterError> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let (counter, last_changed_at) = self.load()?;
        Ok(CounterView {
            value: counter.value(),
            last_changed_at,
        })
    }

    /// Add one and save.
    ///
    /// # Errors
    /// [`CounterError::AtMaximum`] at the bound (nothing is saved), or
    /// [`CounterError::Storage`].
    pub fn increment(&self) -> Result<CounterView, CounterError> {
        self.change(Counter::increment)
    }

    /// Subtract one and save.
    ///
    /// # Errors
    /// [`CounterError::AtMinimum`] at the bound (nothing is saved), or
    /// [`CounterError::Storage`].
    pub fn decrement(&self) -> Result<CounterView, CounterError> {
        self.change(Counter::decrement)
    }

    /// Return to the minimum and save.
    ///
    /// # Errors
    /// [`CounterError::Storage`].
    pub fn reset(&self) -> Result<CounterView, CounterError> {
        self.change(|counter| Ok(counter.reset()))
    }

    /// Load → decide → save under the lock, as one [`CounterStore::update`]. A rejected
    /// decision saves nothing.
    fn change(
        &self,
        decide: impl FnOnce(Counter) -> Result<Counter, CounterError>,
    ) -> Result<CounterView, CounterError> {
        // The guard protects no data (`()`), so a poisoned lock is still safe to take.
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut decide = Some(decide);
        let mut decided = None;
        self.store.update(&mut |stored| {
            let decide = decide.take()?;
            let decision = decide(self.counter_from(stored).0).map(|changed| StoredCounter {
                value: changed.value(),
                last_changed_at: Some(self.clock.now()),
            });
            let to_save = decision.as_ref().ok().cloned();
            decided = Some(decision);
            to_save
        })?;
        // A store that returns `Ok` without calling `change` broke the port's promise;
        // nothing was decided, so nothing can be reported as changed.
        let stored = decided.ok_or(CounterError::Storage {
            kind: StorageErrorKind::Unavailable,
        })??;
        Ok(CounterView {
            value: stored.value,
            last_changed_at: stored.last_changed_at,
        })
    }

    /// The saved counter (or a fresh one) and when it last changed.
    fn load(&self) -> Result<(Counter, Option<UnixMillis>), CounterError> {
        Ok(self.counter_from(self.store.load()?))
    }

    /// What the store held as a counter in range (a fresh one when it held nothing),
    /// and when it last changed.
    fn counter_from(&self, stored: Option<StoredCounter>) -> (Counter, Option<UnixMillis>) {
        match stored {
            Some(stored) => (
                Counter::new(stored.value, self.tuning),
                stored.last_changed_at,
            ),
            None => (Counter::new(self.tuning.min, self.tuning), None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TUNING: Tuning = match Tuning::new(0, 3) {
        Ok(tuning) => tuning,
        Err(TuningError::MinAboveMax) => panic!("0 to 3 is a valid range"),
    };

    #[test]
    fn default_tuning_is_zero_to_ninety_nine() {
        assert_eq!(Tuning::default(), Tuning::new(0, 99).unwrap());
    }

    #[test]
    fn tuning_keeps_its_bounds() {
        let tuning = Tuning::new(-4, 6).unwrap();
        assert_eq!((tuning.min(), tuning.max()), (-4, 6));
    }

    #[test]
    fn tuning_with_the_minimum_above_the_maximum_is_an_error() {
        assert_eq!(Tuning::new(3, 2), Err(TuningError::MinAboveMax));
        assert_eq!(
            Tuning::new(i64::MAX, i64::MIN),
            Err(TuningError::MinAboveMax)
        );
    }

    #[test]
    fn tuning_with_one_value_holds_a_counter_at_that_value() {
        let tuning = Tuning::new(5, 5).unwrap();
        assert_eq!(Counter::new(-1, tuning).value(), 5);
        assert_eq!(Counter::new(9, tuning).value(), 5);
    }

    #[test]
    fn new_keeps_a_value_inside_the_range() {
        assert_eq!(Counter::new(2, TUNING).value(), 2);
    }

    #[test]
    fn new_pulls_an_out_of_range_value_to_the_nearest_bound() {
        assert_eq!(Counter::new(-5, TUNING).value(), 0);
        assert_eq!(Counter::new(40, TUNING).value(), 3);
    }

    #[test]
    fn increment_adds_one_below_the_maximum() {
        assert_eq!(
            Counter::new(2, TUNING).increment().map(|c| c.value()),
            Ok(3)
        );
    }

    #[test]
    fn increment_at_the_maximum_is_an_error() {
        assert_eq!(
            Counter::new(3, TUNING).increment(),
            Err(CounterError::AtMaximum)
        );
    }

    #[test]
    fn decrement_subtracts_one_above_the_minimum() {
        assert_eq!(
            Counter::new(1, TUNING).decrement().map(|c| c.value()),
            Ok(0)
        );
    }

    #[test]
    fn decrement_at_the_minimum_is_an_error() {
        assert_eq!(
            Counter::new(0, TUNING).decrement(),
            Err(CounterError::AtMinimum)
        );
    }

    #[test]
    fn reset_returns_to_the_minimum() {
        let tuning = Tuning::new(5, 10).unwrap();
        assert_eq!(Counter::new(8, tuning).reset().value(), 5);
    }

    #[test]
    fn a_storage_error_becomes_a_counter_error_with_the_same_kind() {
        let error = StorageError::new(StorageErrorKind::Corrupt);
        assert_eq!(
            CounterError::from(error),
            CounterError::Storage {
                kind: StorageErrorKind::Corrupt
            }
        );
    }
}
