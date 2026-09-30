//! `CounterService` against the fakes: every use case, both bounds, and every storage
//! failure. The expected values are written out, not computed with core's own code.

use std::sync::{Arc, Mutex, PoisonError};

use myapp_core::{
    CounterError, CounterService, CounterStore, CounterView, StorageError, StorageErrorKind,
    StoredCounter, Tuning, TuningError, UnixMillis,
};
use myapp_test_support::{FailingCounterStore, FixedClock, InMemoryCounterStore};

const T0: UnixMillis = FixedClock::DEFAULT;
const TUNING: Tuning = match Tuning::new(0, 2) {
    Ok(tuning) => tuning,
    Err(TuningError::MinAboveMax) => panic!("0 to 2 is a valid range"),
};

fn service_over(store: Arc<InMemoryCounterStore>, clock: Arc<FixedClock>) -> CounterService {
    CounterService::new(store, clock, TUNING)
}

#[test]
fn a_fresh_counter_shows_the_minimum_and_no_change_time() {
    let service = service_over(Arc::default(), Arc::default());
    assert_eq!(
        service.view(),
        Ok(CounterView {
            value: 0,
            last_changed_at: None
        })
    );
}

#[test]
fn view_shows_the_saved_counter() {
    let store = Arc::new(InMemoryCounterStore::holding(StoredCounter {
        value: 1,
        last_changed_at: Some(UnixMillis(5)),
    }));
    let service = service_over(store, Arc::default());
    assert_eq!(
        service.view(),
        Ok(CounterView {
            value: 1,
            last_changed_at: Some(UnixMillis(5))
        })
    );
}

#[test]
fn view_pulls_a_saved_value_outside_the_range_back_inside() {
    let store = Arc::new(InMemoryCounterStore::holding(StoredCounter {
        value: 50,
        last_changed_at: None,
    }));
    let service = service_over(store, Arc::default());
    assert_eq!(service.view().map(|view| view.value), Ok(2));
}

#[test]
fn increment_saves_the_new_value_with_the_clock_time() {
    let store = Arc::new(InMemoryCounterStore::default());
    let service = service_over(store.clone(), Arc::default());
    assert_eq!(
        service.increment(),
        Ok(CounterView {
            value: 1,
            last_changed_at: Some(T0)
        })
    );
    assert_eq!(
        store.saved(),
        Some(StoredCounter {
            value: 1,
            last_changed_at: Some(T0)
        })
    );
}

#[test]
fn each_change_takes_the_time_the_clock_reads_then() {
    let clock = Arc::new(FixedClock::default());
    let service = service_over(Arc::default(), clock.clone());
    assert_eq!(service.increment().map(|v| v.last_changed_at), Ok(Some(T0)));
    clock.advance(1_000);
    assert_eq!(
        service.increment().map(|v| v.last_changed_at),
        Ok(Some(UnixMillis(T0.0 + 1_000)))
    );
}

#[test]
fn increment_at_the_maximum_fails_and_saves_nothing() {
    let stored = StoredCounter {
        value: 2,
        last_changed_at: Some(UnixMillis(9)),
    };
    let store = Arc::new(InMemoryCounterStore::holding(stored.clone()));
    let service = service_over(store.clone(), Arc::default());
    assert_eq!(service.increment(), Err(CounterError::AtMaximum));
    assert_eq!(store.saved(), Some(stored));
}

#[test]
fn decrement_saves_the_new_value() {
    let store = Arc::new(InMemoryCounterStore::holding(StoredCounter {
        value: 2,
        last_changed_at: None,
    }));
    let service = service_over(store.clone(), Arc::default());
    assert_eq!(
        service.decrement(),
        Ok(CounterView {
            value: 1,
            last_changed_at: Some(T0)
        })
    );
    assert_eq!(
        store.saved(),
        Some(StoredCounter {
            value: 1,
            last_changed_at: Some(T0)
        })
    );
}

#[test]
fn decrement_at_the_minimum_fails_and_saves_nothing() {
    let store = Arc::new(InMemoryCounterStore::default());
    let service = service_over(store.clone(), Arc::default());
    assert_eq!(service.decrement(), Err(CounterError::AtMinimum));
    assert_eq!(store.saved(), None);
}

#[test]
fn reset_saves_the_minimum_with_the_clock_time() {
    let store = Arc::new(InMemoryCounterStore::holding(StoredCounter {
        value: 2,
        last_changed_at: None,
    }));
    let service = service_over(store.clone(), Arc::default());
    assert_eq!(
        service.reset(),
        Ok(CounterView {
            value: 0,
            last_changed_at: Some(T0)
        })
    );
    assert_eq!(
        store.saved(),
        Some(StoredCounter {
            value: 0,
            last_changed_at: Some(T0)
        })
    );
}

#[test]
fn a_failed_load_is_a_storage_error_for_every_use_case() {
    let service = CounterService::new(
        Arc::new(FailingCounterStore::load_fails(StorageErrorKind::Corrupt)),
        Arc::new(FixedClock::default()),
        TUNING,
    );
    let expected = Err(CounterError::Storage {
        kind: StorageErrorKind::Corrupt,
    });
    assert_eq!(service.view(), expected.clone());
    assert_eq!(service.increment(), expected.clone());
    assert_eq!(service.decrement(), expected.clone());
    assert_eq!(service.reset(), expected);
}

#[test]
fn a_failed_save_is_a_storage_error_and_the_old_value_stays() {
    let stored = StoredCounter {
        value: 1,
        last_changed_at: None,
    };
    let store = Arc::new(FailingCounterStore::save_fails(
        StorageErrorKind::Unavailable,
        Some(stored.clone()),
    ));
    let service = CounterService::new(store.clone(), Arc::new(FixedClock::default()), TUNING);
    let expected = Err(CounterError::Storage {
        kind: StorageErrorKind::Unavailable,
    });
    assert_eq!(service.increment(), expected.clone());
    assert_eq!(service.decrement(), expected.clone());
    assert_eq!(service.reset(), expected);
    assert_eq!(store.saved(), Some(stored));
}

#[test]
fn concurrent_increments_lose_no_update() {
    let store = Arc::new(InMemoryCounterStore::default());
    let service = Arc::new(CounterService::new(
        store.clone(),
        Arc::new(FixedClock::default()),
        Tuning::new(0, 1_000).unwrap(),
    ));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let service = service.clone();
            std::thread::spawn(move || {
                for _ in 0..25 {
                    service.increment().unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(store.saved().map(|s| s.value), Some(200));
}

/// A store that records which of its methods the service called. Its `update` hands the
/// change nothing and ignores the answer, or, when `skips_change` is set, returns `Ok`
/// without calling the change at all (breaking the port's promise).
#[derive(Default)]
struct RecordingStore {
    calls: Mutex<Vec<&'static str>>,
    skips_change: bool,
}

impl RecordingStore {
    fn record(&self, call: &'static str) {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(call);
    }
}

impl CounterStore for RecordingStore {
    fn load(&self) -> Result<Option<StoredCounter>, StorageError> {
        self.record("load");
        Ok(None)
    }

    fn save(&self, _: &StoredCounter) -> Result<(), StorageError> {
        self.record("save");
        Ok(())
    }

    fn update(
        &self,
        change: &mut dyn FnMut(Option<StoredCounter>) -> Option<StoredCounter>,
    ) -> Result<(), StorageError> {
        self.record("update");
        if !self.skips_change {
            change(None);
        }
        Ok(())
    }
}

#[test]
fn every_change_is_one_store_update_so_another_process_cannot_interleave() {
    let store = Arc::new(RecordingStore::default());
    let service = CounterService::new(store.clone(), Arc::new(FixedClock::default()), TUNING);
    assert_eq!(service.increment().map(|v| v.value), Ok(1));
    assert_eq!(service.decrement(), Err(CounterError::AtMinimum));
    assert_eq!(service.reset().map(|v| v.value), Ok(0));
    assert_eq!(*store.calls.lock().unwrap(), ["update"; 3]);
}

#[test]
fn a_store_that_never_runs_the_change_is_a_storage_error() {
    let store = Arc::new(RecordingStore {
        skips_change: true,
        ..RecordingStore::default()
    });
    let service = CounterService::new(store, Arc::new(FixedClock::default()), TUNING);
    assert_eq!(
        service.increment(),
        Err(CounterError::Storage {
            kind: StorageErrorKind::Unavailable
        })
    );
}
