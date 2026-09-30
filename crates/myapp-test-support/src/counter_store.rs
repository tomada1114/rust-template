use std::sync::{Mutex, PoisonError};

use myapp_core::{CounterStore, StorageError, StorageErrorKind, StoredCounter, UnixMillis};

/// A store that keeps the counter in memory.
#[derive(Debug, Default)]
pub struct InMemoryCounterStore {
    saved: Mutex<Option<StoredCounter>>,
}

impl InMemoryCounterStore {
    /// A store that already holds `counter`.
    #[must_use]
    pub fn holding(counter: StoredCounter) -> Self {
        Self {
            saved: Mutex::new(Some(counter)),
        }
    }

    /// What was saved last, for a test to inspect.
    #[must_use]
    pub fn saved(&self) -> Option<StoredCounter> {
        self.saved
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl CounterStore for InMemoryCounterStore {
    fn load(&self) -> Result<Option<StoredCounter>, StorageError> {
        Ok(self.saved())
    }

    fn save(&self, counter: &StoredCounter) -> Result<(), StorageError> {
        *self.saved.lock().unwrap_or_else(PoisonError::into_inner) = Some(counter.clone());
        Ok(())
    }
}

/// A store whose loads or saves fail with a chosen kind, for testing error paths.
#[derive(Debug, Default)]
pub struct FailingCounterStore {
    /// When set, every `load` fails with this kind.
    pub load_fails_with: Option<StorageErrorKind>,
    /// When set, every `save` fails with this kind.
    pub save_fails_with: Option<StorageErrorKind>,
    inner: InMemoryCounterStore,
}

impl FailingCounterStore {
    /// A store whose every load fails with `kind`.
    #[must_use]
    pub fn load_fails(kind: StorageErrorKind) -> Self {
        Self {
            load_fails_with: Some(kind),
            ..Self::default()
        }
    }

    /// A store whose every save fails with `kind`; loads return what it was given.
    #[must_use]
    pub fn save_fails(kind: StorageErrorKind, holding: Option<StoredCounter>) -> Self {
        let inner =
            holding.map_or_else(InMemoryCounterStore::default, InMemoryCounterStore::holding);
        Self {
            save_fails_with: Some(kind),
            inner,
            ..Self::default()
        }
    }

    /// What the store holds (saves never change it while they fail).
    #[must_use]
    pub fn saved(&self) -> Option<StoredCounter> {
        self.inner.saved()
    }
}

impl CounterStore for FailingCounterStore {
    fn load(&self) -> Result<Option<StoredCounter>, StorageError> {
        match self.load_fails_with {
            Some(kind) => Err(StorageError::new(kind)),
            None => self.inner.load(),
        }
    }

    fn save(&self, counter: &StoredCounter) -> Result<(), StorageError> {
        match self.save_fails_with {
            Some(kind) => Err(StorageError::new(kind)),
            None => self.inner.save(counter),
        }
    }
}

/// The behaviour every [`CounterStore`] must have. Each call to `make` must return a new,
/// empty store.
///
/// # Panics
/// When the store breaks the contract; that is how the calling test fails.
pub fn counter_store_contract(mut make: impl FnMut() -> Box<dyn CounterStore>) {
    let store = make();
    assert_eq!(store.load(), Ok(None), "a new store holds nothing");

    let store = make();
    let saved = StoredCounter {
        value: 7,
        last_changed_at: Some(UnixMillis(1_700_000_000_000)),
    };
    assert_eq!(store.save(&saved), Ok(()));
    assert_eq!(
        store.load(),
        Ok(Some(saved.clone())),
        "load returns what save wrote"
    );
    assert_eq!(
        store.load(),
        Ok(Some(saved.clone())),
        "load does not consume the value"
    );

    let store = make();
    assert_eq!(store.save(&saved), Ok(()));
    let newer = StoredCounter { value: 8, ..saved };
    assert_eq!(store.save(&newer), Ok(()));
    assert_eq!(store.load(), Ok(Some(newer)), "the last save wins");

    let store = make();
    let never_changed = StoredCounter {
        value: -3,
        last_changed_at: None,
    };
    assert_eq!(store.save(&never_changed), Ok(()));
    assert_eq!(
        store.load(),
        Ok(Some(never_changed)),
        "a missing timestamp and a negative value round-trip"
    );

    let store = make();
    let mut seen = Vec::new();
    assert_eq!(
        store.update(&mut |stored| {
            seen.push(stored);
            Some(saved.clone())
        }),
        Ok(())
    );
    assert_eq!(
        seen,
        vec![None],
        "update on a new store is handed nothing, once"
    );
    assert_eq!(
        store.load(),
        Ok(Some(saved.clone())),
        "update saves what the change returns"
    );

    let mut seen = Vec::new();
    assert_eq!(
        store.update(&mut |stored| {
            seen.push(stored);
            None
        }),
        Ok(())
    );
    assert_eq!(
        seen,
        vec![Some(saved.clone())],
        "update is handed what was saved, once"
    );
    assert_eq!(
        store.load(),
        Ok(Some(saved)),
        "a change that returns nothing saves nothing"
    );
}
