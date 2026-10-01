use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::hash::{BuildHasher, RandomState};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use myapp_core::{CounterStore, StorageError, StorageErrorKind, StoredCounter};
use serde::{Deserialize, Serialize};

/// The file format version this build writes and reads. Bump it — and teach `load` to
/// read the old one — when a change cannot be made with `#[serde(default)]`.
const FORMAT_VERSION: u32 = 1;

/// `counter.json` on disk: `{ "version": 1, "counter": { "value": …, "lastChangedAt": … } }`.
#[derive(Serialize, Deserialize)]
struct CounterFile {
    version: u32,
    counter: StoredCounter,
}

/// Saves made by this process so far: part of each temporary file's name, so two saves
/// from one process never share one.
static SAVES: AtomicU64 = AtomicU64::new(0);

/// Keeps the counter in a JSON file.
///
/// Saves are atomic: the new contents go to a temporary file in the same directory, named
/// for this process and this save, which is then renamed over the old file, so a crash or
/// a concurrent save leaves either the old file or the new one, never half of each.
/// Every save and every [`update`](CounterStore::update) holds an advisory lock on
/// `<file>.lock` beside it, so writers in any process take turns and an update's load
/// and save have no other save between them. A load takes no lock: the rename replaces
/// the file in one step, so a reader sees one whole file.
#[derive(Debug, Clone)]
pub struct JsonFileCounterStore {
    path: PathBuf,
}

impl JsonFileCounterStore {
    /// A store at `path`. Nothing is read or created until the first `load` or `save`.
    #[must_use]
    pub const fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The file this store uses.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The directory the file lives in; `.` for a bare file name.
    fn dir(&self) -> &Path {
        match self.path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        }
    }

    /// `<file name><suffix>`, beside the file.
    fn sibling(&self, suffix: &str) -> PathBuf {
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(suffix);
        self.dir().join(name)
    }

    /// `<file>.<pid>-<save>-<random>.tmp`: the pid and the save count keep it unique among
    /// live writers, and the random part keeps it clear of one a crashed process left.
    fn temp_path(&self) -> PathBuf {
        let save = SAVES.fetch_add(1, Ordering::Relaxed);
        let random = RandomState::new().hash_one(save);
        self.sibling(&format!(".{}-{save}-{random:016x}.tmp", std::process::id()))
    }

    /// Whether `name` is one of this store's temporary files, from any build: the current
    /// `<file>.<…>.tmp` names and the fixed `<file>.tmp` earlier builds used.
    fn is_temp_name(&self, name: &OsStr) -> bool {
        let mut prefix = self.path.file_name().unwrap_or_default().to_os_string();
        prefix.push(".");
        let name = name.as_encoded_bytes();
        name.len() > prefix.len()
            && name.starts_with(prefix.as_encoded_bytes())
            && name.ends_with(b".tmp")
    }

    /// Waits for, then holds, the writers' lock until the returned file is dropped. The
    /// lock is on `<file>.lock`, never on the file itself: a save replaces the file, so a
    /// lock on it would be left behind on the old one.
    fn lock_writers(&self) -> io::Result<File> {
        fs::create_dir_all(self.dir())?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.sibling(".lock"))?;
        lock.lock()?;
        Ok(lock)
    }

    fn read(&self) -> Result<Option<StoredCounter>, StorageError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(unavailable()),
        };
        let file: CounterFile = serde_json::from_slice(&bytes).map_err(|_| corrupt())?;
        if file.version != FORMAT_VERSION {
            return Err(corrupt());
        }
        Ok(Some(file.counter))
    }

    /// Writes `counter`. The caller holds the writers' lock.
    fn write(&self, counter: &StoredCounter) -> Result<(), StorageError> {
        let file = CounterFile {
            version: FORMAT_VERSION,
            counter: counter.clone(),
        };
        let mut bytes = serde_json::to_vec_pretty(&file).map_err(|_| unavailable())?;
        bytes.push(b'\n');
        self.remove_stale_temps();
        self.write_atomically(&bytes).map_err(|_| unavailable())
    }

    /// Removes the temporary files a crashed save left. The caller holds the writers'
    /// lock, so no temporary file here belongs to a save still running.
    fn remove_stale_temps(&self) {
        let Ok(entries) = fs::read_dir(self.dir()) else {
            return; // The save that follows reports an unreadable directory.
        };
        for entry in entries.flatten() {
            if self.is_temp_name(&entry.file_name()) {
                // Best effort: a stale temporary file takes space but is never read.
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    fn write_atomically(&self, bytes: &[u8]) -> io::Result<()> {
        let temp = self.temp_path();
        // `create_new`: a name some other writer holds is an error, never truncated.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .and_then(|()| fs::rename(&temp, &self.path))
            .inspect_err(|_| {
                // Best effort: the next save removes a temporary file this one leaves.
                let _ = fs::remove_file(&temp);
            })?;
        // The rename changed the directory, not the file: sync the directory too, or a
        // power loss can bring the old file back after a save reported success.
        File::open(self.dir())?.sync_all()
    }
}

const fn unavailable() -> StorageError {
    StorageError::new(StorageErrorKind::Unavailable)
}

const fn corrupt() -> StorageError {
    StorageError::new(StorageErrorKind::Corrupt)
}

impl CounterStore for JsonFileCounterStore {
    fn load(&self) -> Result<Option<StoredCounter>, StorageError> {
        self.read()
    }

    fn save(&self, counter: &StoredCounter) -> Result<(), StorageError> {
        let _lock = self.lock_writers().map_err(|_| unavailable())?;
        self.write(counter)
    }

    fn update(
        &self,
        change: &mut dyn FnMut(Option<StoredCounter>) -> Option<StoredCounter>,
    ) -> Result<(), StorageError> {
        let _lock = self.lock_writers().map_err(|_| unavailable())?;
        match change(self.read()?) {
            Some(next) => self.write(&next),
            None => Ok(()),
        }
    }
}
