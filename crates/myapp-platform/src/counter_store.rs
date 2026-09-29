use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

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

/// Keeps the counter in a JSON file. Saves are atomic: the new contents go to a
/// temporary file in the same directory, which is then renamed over the old one, so a
/// crash mid-save leaves either the old file or the new one, never half of each.
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

    fn temp_path(&self) -> PathBuf {
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(".tmp");
        self.path.with_file_name(name)
    }

    fn write_atomically(&self, bytes: &[u8]) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temp = self.temp_path();
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &self.path).inspect_err(|_| {
            // Best effort: a leftover temp file is harmless, the next save replaces it.
            let _ = fs::remove_file(&temp);
        })
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

    fn save(&self, counter: &StoredCounter) -> Result<(), StorageError> {
        let file = CounterFile {
            version: FORMAT_VERSION,
            counter: counter.clone(),
        };
        let mut bytes = serde_json::to_vec_pretty(&file).map_err(|_| unavailable())?;
        bytes.push(b'\n');
        self.write_atomically(&bytes).map_err(|_| unavailable())
    }
}
