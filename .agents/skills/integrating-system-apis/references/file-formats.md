# On-disk file formats

The files the tool leaves on a user's disk. They are contract (`AGENTS.md` › "What is
contract and what is private"): a new version still reads what an earlier one wrote.
Where the directories come from is `myapp-platform`'s `paths.rs` (the table in the
skill body); this page is what goes in them.

## `counter.json`

In `~/Library/Application Support/<bundle id>/` on macOS and `$XDG_DATA_HOME/myapp/`
(default `~/.local/share/myapp/`) on Linux, shared by every `myapp` process:

```json
{
  "version": 1,
  "counter": {
    "value": 3,
    "lastChangedAt": 1759017600000
  }
}
```

`lastChangedAt` is milliseconds since the Unix epoch, or `null` before the first change.
`crates/myapp-core/tests/serialization.rs` pins the `counter` object with literal JSON.

How `JsonFileCounterStore` reads and writes it (its rustdoc in
`crates/myapp-platform/src/counter_store.rs` states the same):

- **A save is atomic.** It writes a temporary file named for its process and that save
  (`counter.json.<pid>-<n>-<random>.tmp`) in the same directory, syncs it, renames it
  over the old file, and syncs the directory, so a crash or a concurrent save leaves
  the old file or the new one, never half of each. A save also removes temporary files
  a crashed save left, including the fixed `counter.json.tmp` of earlier builds.
- **Writers take turns.** Every save holds an advisory lock (`std::fs::File::lock`) on
  `counter.json.lock` beside it, which is created once, stays empty, and is never
  removed. An increment or decrement (`CounterStore::update`) holds it from the load to
  the save, so when two `myapp` processes change the counter at once, neither change is
  lost. A load takes no lock: the rename replaces the file in one step.
- **A bad file is never overwritten silently.** A missing file is a fresh counter; an
  unreadable file or an unknown `version` is a `corrupt` storage error: showing,
  incrementing, and decrementing fail and leave it untouched, and only a reset — the
  user's explicit request to start over, `r` in `myapp tui` — replaces it.
- **Versioning.** A field is added with `#[serde(default)]`; renaming or removing one
  bumps `version` (`FORMAT_VERSION`), and the reader keeps accepting the old version,
  with a test that reads a sample of it.

An app replacing the sample writes its own file's section here, in the same shape:
where it lives, an example, how a save and a concurrent writer behave, and how its
version moves.

## Log files

`myapp.YYYY-MM-DD.log` from the binary, in `~/Library/Logs/<bundle id>/` on macOS and
`$XDG_STATE_HOME/myapp/logs/` on Linux, dated in UTC, one per day, the newest 14 kept.
Each line is `tracing-subscriber`'s plain text format: an RFC 3339 timestamp, the level,
the target, the message, and its fields. The message wording is private; how and why
the binary logs is `designing-clis`' `references/logging.md`.
