//! The `CounterStore` port: where the counter lives between launches.

use serde::{Deserialize, Serialize};

use crate::time::UnixMillis;

/// What the store persists. Its JSON form is contract (docs/architecture.md): add a field
/// with `#[serde(default)]`; never rename or remove one without a format version bump.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCounter {
    /// The saved value.
    pub value: i64,
    /// When it last changed, if ever.
    pub last_changed_at: Option<UnixMillis>,
}

/// Where the counter lives between launches. Synchronous on purpose: the
/// shell moves calls onto a blocking thread.
pub trait CounterStore: Send + Sync {
    /// The saved counter, or `Ok(None)` when nothing was saved yet — not an error.
    ///
    /// # Errors
    /// [`StorageError`] when the storage cannot be read or holds something unreadable.
    fn load(&self) -> Result<Option<StoredCounter>, StorageError>;

    /// Replace the saved counter.
    ///
    /// # Errors
    /// [`StorageError`] when the storage cannot be written.
    fn save(&self, counter: &StoredCounter) -> Result<(), StorageError>;

    /// Load, let `change` decide, and save what it returns, as one step: `change` is
    /// called once with what [`load`](Self::load) returns, and a `None` from it saves
    /// nothing. A store that another process also writes (the app and the helper CLI
    /// share one file) overrides this to hold a lock from the load to the save, so no
    /// other writer's save lands in between and neither update is lost. The default
    /// runs `load` then `save` with no lock, which is enough for a store only one
    /// process uses and whose caller serializes its own updates.
    ///
    /// # Errors
    /// [`StorageError`] when the load or the save fails; `change` is not called when
    /// the load fails.
    fn update(
        &self,
        change: &mut dyn FnMut(Option<StoredCounter>) -> Option<StoredCounter>,
    ) -> Result<(), StorageError> {
        if let Some(next) = change(self.load()?) {
            self.save(&next)?;
        }
        Ok(())
    }
}

/// Why storage failed, as a code the binary maps to wording. A kind, not an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageErrorKind {
    /// The storage could not be read or written (missing permission, full disk, …).
    Unavailable,
    /// The storage holds data this version cannot read.
    Corrupt,
}

/// A failed store operation. Carries no path and no file contents: no user data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("counter storage failed: {kind:?}")]
pub struct StorageError {
    /// What kind of failure.
    pub kind: StorageErrorKind,
}

impl StorageError {
    /// A failure of the given kind.
    #[must_use]
    pub const fn new(kind: StorageErrorKind) -> Self {
        Self { kind }
    }
}
