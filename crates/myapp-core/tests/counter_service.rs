//! `CounterService` against the fakes: every use case, both bounds, and every storage
//! failure. The expected values are written out, not computed with core's own code.

use std::sync::Arc;

use myapp_core::{
    CounterError, CounterService, CounterView, StorageErrorKind, StoredCounter, Tuning, UnixMillis,
};
use myapp_test_support::{FailingCounterStore, FixedClock, InMemoryCounterStore};

const T0: UnixMillis = FixedClock::DEFAULT;
const TUNING: Tuning = Tuning { min: 0, max: 2 };

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
        Tuning { min: 0, max: 1_000 },
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
