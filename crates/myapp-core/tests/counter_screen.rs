//! `CounterScreen` against the fakes: what `myapp tui` shows after each key, with no
//! terminal anywhere. Keys are built as values; the expected screens are written out.

use std::sync::Arc;

use myapp_core::{
    CounterError, CounterScreen, CounterService, CounterView, ScreenAction, ScreenKey,
    StorageErrorKind, StoredCounter, Tuning, TuningError, UnixMillis,
};
use myapp_test_support::{FailingCounterStore, FixedClock, InMemoryCounterStore};

const T0: UnixMillis = FixedClock::DEFAULT;
const TUNING: Tuning = match Tuning::new(0, 2) {
    Ok(tuning) => tuning,
    Err(TuningError::MinAboveMax) => panic!("0 to 2 is a valid range"),
};

fn service_holding(value: i64) -> CounterService {
    let store = InMemoryCounterStore::holding(StoredCounter {
        value,
        last_changed_at: None,
    });
    CounterService::new(Arc::new(store), Arc::new(FixedClock::default()), TUNING)
}

fn service_over(store: FailingCounterStore) -> CounterService {
    CounterService::new(Arc::new(store), Arc::new(FixedClock::default()), TUNING)
}

/// What the screen shows, as one comparable value.
fn shown(screen: &CounterScreen) -> (Option<CounterView>, Option<CounterError>, bool) {
    (screen.view().cloned(), screen.error(), screen.is_finished())
}

fn changed_to(value: i64, revision: u64) -> CounterView {
    CounterView {
        value,
        last_changed_at: Some(T0),
        revision,
    }
}

/// The screen after each key in turn, the way the binary's loop drives it.
fn after_keys(service: &CounterService, keys: &[ScreenKey]) -> CounterScreen {
    keys.iter()
        .filter_map(|key| ScreenAction::for_key(*key))
        .fold(CounterScreen::load(service), |screen, action| {
            screen.update(action, service)
        })
}

#[test]
fn opening_shows_the_saved_counter_and_no_error() {
    let screen = CounterScreen::load(&service_holding(1));
    assert_eq!(
        shown(&screen),
        (
            Some(CounterView {
                value: 1,
                last_changed_at: None,
                revision: 0
            }),
            None,
            false
        )
    );
}

#[test]
fn opening_over_an_unreadable_store_shows_no_value_and_the_error() {
    let service = service_over(FailingCounterStore::load_fails(StorageErrorKind::Corrupt));
    assert_eq!(
        shown(&CounterScreen::load(&service)),
        (
            None,
            Some(CounterError::Storage {
                kind: StorageErrorKind::Corrupt
            }),
            false
        )
    );
}

#[test]
fn increment_shows_and_saves_the_new_value() {
    let store = Arc::new(InMemoryCounterStore::default());
    let service = CounterService::new(store.clone(), Arc::new(FixedClock::default()), TUNING);
    let screen = CounterScreen::load(&service).update(ScreenAction::Increment, &service);
    assert_eq!(shown(&screen), (Some(changed_to(1, 1)), None, false));
    assert_eq!(
        store.saved(),
        Some(StoredCounter {
            value: 1,
            last_changed_at: Some(T0)
        })
    );
}

#[test]
fn decrement_shows_the_new_value() {
    let service = service_holding(2);
    let screen = CounterScreen::load(&service).update(ScreenAction::Decrement, &service);
    assert_eq!(shown(&screen), (Some(changed_to(1, 1)), None, false));
}

#[test]
fn reset_shows_the_minimum() {
    let service = service_holding(2);
    let screen = CounterScreen::load(&service).update(ScreenAction::Reset, &service);
    assert_eq!(shown(&screen), (Some(changed_to(0, 1)), None, false));
}

#[test]
fn increment_at_the_maximum_keeps_the_value_and_shows_the_error() {
    let service = service_holding(2);
    let opened = CounterScreen::load(&service);
    let screen = opened.clone().update(ScreenAction::Increment, &service);
    assert_eq!(
        shown(&screen),
        (opened.view().cloned(), Some(CounterError::AtMaximum), false)
    );
}

#[test]
fn decrement_at_the_minimum_keeps_the_value_and_shows_the_error() {
    let service = service_holding(0);
    let opened = CounterScreen::load(&service);
    let screen = opened.clone().update(ScreenAction::Decrement, &service);
    assert_eq!(
        shown(&screen),
        (opened.view().cloned(), Some(CounterError::AtMinimum), false)
    );
}

#[test]
fn a_failed_save_keeps_the_value_and_shows_the_storage_error() {
    let holding = StoredCounter {
        value: 1,
        last_changed_at: None,
    };
    let service = service_over(FailingCounterStore::save_fails(
        StorageErrorKind::Unavailable,
        Some(holding),
    ));
    let opened = CounterScreen::load(&service);
    for action in [
        ScreenAction::Increment,
        ScreenAction::Decrement,
        ScreenAction::Reset,
    ] {
        let screen = opened.clone().update(action, &service);
        assert_eq!(
            shown(&screen),
            (
                opened.view().cloned(),
                Some(CounterError::Storage {
                    kind: StorageErrorKind::Unavailable
                }),
                false
            ),
            "{action:?}"
        );
    }
}

#[test]
fn the_next_successful_action_clears_the_error() {
    let service = service_holding(2);
    let screen = CounterScreen::load(&service)
        .update(ScreenAction::Increment, &service)
        .update(ScreenAction::Decrement, &service);
    assert_eq!(shown(&screen), (Some(changed_to(1, 1)), None, false));
}

#[test]
fn reset_recovers_a_screen_opened_over_unreadable_data() {
    let store = Arc::new(InMemoryCounterStore::default());
    let service = CounterService::new(store, Arc::new(FixedClock::default()), TUNING);
    let unreadable = service_over(FailingCounterStore::load_fails(StorageErrorKind::Corrupt));
    // Opened while the data could not be read; a reset replaces it whatever it held.
    let screen = CounterScreen::load(&unreadable).update(ScreenAction::Reset, &service);
    assert_eq!(shown(&screen), (Some(changed_to(0, 1)), None, false));
}

#[test]
fn quit_finishes_the_screen_and_changes_nothing() {
    let store = Arc::new(InMemoryCounterStore::default());
    let service = CounterService::new(store.clone(), Arc::new(FixedClock::default()), TUNING);
    let opened = CounterScreen::load(&service);
    let screen = opened.clone().update(ScreenAction::Quit, &service);
    assert_eq!(shown(&screen), (opened.view().cloned(), None, true));
    assert_eq!(store.saved(), None, "quitting saves nothing");
}

#[test]
fn quit_keeps_an_error_on_screen() {
    let service = service_holding(2);
    let screen = CounterScreen::load(&service)
        .update(ScreenAction::Increment, &service)
        .update(ScreenAction::Quit, &service);
    assert_eq!(screen.error(), Some(CounterError::AtMaximum));
    assert!(screen.is_finished());
}

#[test]
fn a_sequence_of_keys_drives_the_counter_and_ignores_unbound_keys() {
    let service = service_holding(0);
    let screen = after_keys(
        &service,
        &[
            ScreenKey::Char('+'),
            ScreenKey::Up,
            ScreenKey::Char('x'),
            ScreenKey::Down,
            ScreenKey::Char('+'),
        ],
    );
    assert_eq!(shown(&screen), (Some(changed_to(2, 4)), None, false));
}

#[test]
fn each_quit_key_finishes_the_screen() {
    for key in [ScreenKey::Char('q'), ScreenKey::Esc, ScreenKey::Interrupt] {
        let screen = after_keys(&service_holding(1), &[key]);
        assert!(screen.is_finished(), "{key:?}");
    }
}

#[test]
fn r_resets_the_counter() {
    let screen = after_keys(&service_holding(2), &[ScreenKey::Char('r')]);
    assert_eq!(shown(&screen), (Some(changed_to(0, 1)), None, false));
}
