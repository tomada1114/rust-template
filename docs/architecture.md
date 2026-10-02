# Architecture

This page describes the layers every app cut from this template starts with, how they
talk, and what is contract. What an app decides on top of them — where it keeps state,
its dependencies, the platforms it targets, the permissions it asks for, whether it
ever ships releases — is recorded as ADRs under [`docs/architecture/`](architecture/README.md), whose
`README.md` is the index. The reasoning behind the layers themselves is the README's
[Design Philosophy](../README.md#design-philosophy).

## Layers

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ crates/myapp  the `myapp` binary: the tool and the composition root.         │
│ Arguments in; data on stdout, diagnostics on stderr, an exit code out.       │
│ It translates; it decides nothing.                                           │
└──────────────────────────────────────────────────────────────────────────────┘
      │ constructs the adapters, hands them to core
      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ crates/myapp-platform  adapters: the real OS and filesystem, behind ports    │
└──────────────────────────────────────────────────────────────────────────────┘
      │ implement core's ports; call core's use cases
      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ crates/myapp-core  rules, state, ports (traits), and the views and screens   │
│ the binary shows. No OS API, no terminal, no direct I/O. Builds on Linux.    │
│ Coverage floor: 80% of lines, 80% of functions.                              │
└──────────────────────────────────────────────────────────────────────────────┘
  crates/myapp-test-support  fakes and one contract function per port
                             (a [dev-dependencies] entry only; never ships)
```

Dependencies point one way, toward core: `myapp-platform` → core; `myapp` (the binary)
→ platform and core. Core depends on neither, and platform does not know the binary
exists. Everything runs in one process: the subcommands and the full-screen view call
core directly, so there is no IPC layer and no serialized boundary between them.

### How the boundaries are enforced

| Layer | What fails |
|---|---|
| Compile time | `crates/myapp-core/Cargo.toml` names no OS, terminal, or platform crate, so code in core cannot call one. |
| Dependency closure | A harness check (`just check-harness`) reads `cargo metadata` and fails if core's normal and build dependency closure contains a crate the boundary sentence in `AGENTS.md` › Architecture forbids — the macOS binding crates, the desktop-GUI crates, and `myapp-platform` — or if a non-dev edge points at `myapp-test-support`. `deny.toml`'s `[bans]` adds the direct-edge rule: `myapp-platform` may be a direct dependency of `myapp` only. |
| clippy in core | `crates/myapp-core/clippy.toml` bans `print!`/`println!`/`eprint!`/`eprintln!`/`dbg!`, `std::io::{stdin, stdout, stderr}`, `std::fs::{File, OpenOptions, DirBuilder}` and every `std::fs` free function, `std::os::unix::fs::{symlink, chown, fchown, lchown, chroot}`, `std::path::Path`'s file-system queries (`exists`, `metadata`, `read_dir`, `is_file`, …), `std::net::{TcpStream, TcpListener, UdpSocket}`, `std::os::unix::net::{UnixStream, UnixListener, UnixDatagram}`, and `ToSocketAddrs::to_socket_addrs`, `std::process::{Command, exit, abort, id}`, `std::os::unix::process::parent_id`, `SystemTime::now`, `Instant::now`, both types' `elapsed`, `std::env`'s argument, variable, and directory functions (including `current_exe` and `home_dir`), and `std::thread::{spawn, sleep, park_timeout, available_parallelism}` and `Builder::spawn`; `std::thread::scope` is allowed, since it joins its threads before it returns and so cannot outlive the call. `clippy::wildcard_enum_match_arm` is denied, so every `match` on a core enum names each variant. A ban whose path clippy cannot resolve would only warn and do nothing, so `just lint` and CI run clippy through `cargo xtask clippy-guard`, which fails with `ERR_CLIPPY_BAN_UNRESOLVED` instead. |

The forbidden-crate lists in `AGENTS.md`, the closure check, and `deny.toml` are kept
equal by a harness check. No gate stops core from naming clap, ratatui, or crossterm;
review holds that line, so a screen's state machine stays testable with plain values.

## Ports and adapters

Anything outside the process — the filesystem, the clock, and later the OS APIs an app
needs — reaches core through a port. It is always the same four pieces, and the sample
has two worked examples:

| Piece | Where | `CounterStore` | `Clock` |
|---|---|---|---|
| The port: a `Send + Sync` trait over types core owns | `crates/myapp-core` | `counter::store::CounterStore` | `time::Clock` |
| The adapter: translates OS results into core's types and OS failures into core's error kinds, and decides nothing | `crates/myapp-platform` | `JsonFileCounterStore` | `SystemClock` |
| The fake: a real implementation answering from memory | `crates/myapp-test-support` | `InMemoryCounterStore`, `FailingCounterStore` | `FixedClock` |
| The contract: the behaviour every implementation must have | `crates/myapp-test-support` | `counter_store_contract` | `clock_contract` |

`crates/myapp-core/tests/contracts.rs` runs each contract against the fake, on Linux,
inside the coverage floor. `crates/myapp-platform/tests/contracts.rs` runs the same
function against the real adapter, on the Linux and macOS CI runners when it needs only
a filesystem (each test gets its own temporary directory). An adapter test that needs a
logged-in GUI session, a TCC grant, or the Keychain is marked
`#[ignore = "local machine: <what it needs>"]` and runs only in `just test-local`, which
a human starts; the sample has none. Core's integration tests live in
`crates/myapp-core/tests/`, never in its inline `#[cfg(test)]` modules, because there
test-support's types would come from a second copy of core.

Ports are **synchronous**. Core is plain functions and state, so nothing in it is
`async`, and the binary calls a port directly. A port that is inherently a stream is
modelled as a callback or a channel the binary drives, never as async trait methods.

Errors are one `thiserror` enum per port or per core module, with a variant per failure
the caller can act on and no user data: `CounterError::{AtMaximum, AtMinimum, Storage {
kind }}`, where `kind` is `Unavailable` or `Corrupt`. The binary maps each variant to
wording in `crates/myapp/src/wording.rs`, one `match` per enum with no wildcard arm and
a test per variant, prints it on stderr, and exits 1; `myapp tui` shows the same wording
on its error line. Core never produces a user-facing sentence. An error that leaves the
process as data also serializes as a typed code: `CounterError` already does
(`{ "code": "atMaximum" }`, `{ "code": "storage", "kind": "corrupt" }`), ready for a
`--json` form.

`crates/myapp/src/main.rs` is the composition root: the only place that constructs an
adapter and hands it to core (`CounterService::new(store, clock, Tuning::default())`).

The platform crate and the binary are outside the coverage floor. That is a
constraint, not a licence: they translate, so they have no branch worth a numeric gate.
The moment one needs a decision, the decision moves into core behind the port.

## The binary

`crates/myapp` builds `myapp`, the tool itself. `just install-cli` installs it into
`~/.cargo/bin` with `cargo install --locked --path crates/myapp`; that writes outside the
checkout, so it is a human's recipe. The command-line contract, which
`crates/myapp/tests/cli.rs` runs against the built binary with a temporary `HOME`:

- **Streams.** Data — the counter's value — goes to stdout, one line; diagnostics go to
  stderr: `error: <wording>` for a failed action, `warning: <wording>` for a degraded run
  (logging unavailable), and, in a debug build, a copy of each log line.
- **Exit codes.** 0 on success (including `--help` and `--version`), 1 when the action
  failed (at a bound, storage, no `HOME`), 2 on a usage error (clap's own code, with its
  message and usage on stderr).
- **`--version`** prints `myapp <version>`, the workspace version from `Cargo.toml`'s
  `[workspace.package]`.

`myapp tui` is the full-screen view of the same counter, drawn with ratatui over its
crossterm backend (reached only as `ratatui::crossterm`). The screen's state and what a
key does are core's `CounterScreen`, `ScreenAction`, and `ScreenKey`, tested against the
fakes; `crates/myapp/src/tui/` only enters and leaves the terminal, translates its key
events, and draws (`view.rs`, tested against ratatui's `TestBackend`). It refuses with
exit 1 unless standard input and standard output are both a terminal, logs to the file
only while it owns the screen, and restores the terminal — raw mode off, the main screen
back, the cursor shown — on a normal exit, on an error, and from a panic hook. No check
runs the loop itself; a human running `myapp tui` is its test.

## Logging

The binary and `myapp-platform` log through the `tracing` macros; `myapp-core` has no
`tracing` dependency and logs nothing. Only the binary installs a subscriber
(`myapp_platform::init_logging`). Its files go to `~/Library/Logs/com.example.myapp/`
on macOS and `$XDG_STATE_HOME/myapp/logs/` (default `~/.local/state/myapp/logs/`) on
Linux, as `myapp.YYYY-MM-DD.log`, one per day, and the newest 14 are kept; retention counts
every file in that directory whose name starts with the writer's prefix, so a second
writer gets its own directory. The writer is synchronous: the volume is low, and an
early `process::exit` would drop a background writer's last lines. A debug build of a
plain subcommand also writes to stderr; `myapp tui` writes to the file only, since a
line on the terminal it owns would corrupt the frame. Logging is best effort: when the directory cannot be used, the binary
prints a warning and still runs the action. No log line carries user data. `just logs`
prints the newest file's last lines and exits.

## Where new code goes

| You are adding… | It goes in… | Tested by… |
|---|---|---|
| A rule, a state change, a view a front end shows | `crates/myapp-core` | unit tests and `crates/myapp-core/tests/` (coverage-gated, Linux) |
| Access to the OS or the filesystem | an adapter in `crates/myapp-platform`, behind a port in core, with a fake and a contract function in `crates/myapp-test-support` | the contract against the fake (core) and against the adapter (`just test-platform`, or `just test-local` when a human is needed) |
| A subcommand, or the wording for a new error variant | `crates/myapp` (wording in `src/wording.rs`) | `crates/myapp/tests/cli.rs` (the built binary, a temporary `HOME`) and a test per variant in `wording.rs` |
| A screen's state, an action, a key | core, beside the model it drives (`CounterScreen`, `ScreenAction`, `ScreenKey`) | core tests with keys and actions as values, over the fakes |
| How a screen is drawn | `crates/myapp/src/tui/view.rs` | ratatui's `TestBackend` tests in the same file |
| The terminal loop, wiring | `crates/myapp/src/tui/mod.rs`, `crates/myapp/src/main.rs` (`compose`) | no check runs the loop; a human runs `myapp tui` |

## What is contract and what is private

Nothing here is published as a library, so the contract is what something outside a
change can observe: another crate, a machine that ran an earlier build, a script or a
scheduled job that runs `myapp`, or the user. These are contract; everything else is
private.

| Contract | What depends on it | What changing it requires |
|---|---|---|
| **Core's public API** — every `pub` item re-exported from `crates/myapp-core/src/lib.rs` (`Counter`, `CounterService`, `CounterView`, `CounterError`, `CounterScreen`, `ScreenAction`, `ScreenKey`, `CounterStore`, `StoredCounter`, `StorageError`, `StorageErrorKind`, `Tuning`, `TuningError`, `Clock`, `UnixMillis`) | `myapp-platform`, `myapp-test-support`, `myapp`, and their tests | Update every caller in the same pull request; the compiler finds them. A new port is an ADR. |
| **The data and log locations** — the bundle identifier `com.example.myapp` (`BUNDLE_IDENTIFIER` in `crates/myapp-platform/src/paths.rs` and `bundle_id` in the justfile) and the XDG directory name `myapp` (`XDG_APP_NAME`) | Where the tool's files are on a machine that ran it: on macOS `~/Library/Application Support/com.example.myapp/` and `~/Library/Logs/com.example.myapp/` (and any privacy grant, keyed by the identifier); on Linux `$XDG_DATA_HOME/myapp/` and `$XDG_STATE_HOME/myapp/logs/` | Fixed once the tool has run anywhere but your checkout: a new name leaves the user's data behind under the old one. Changing it is a human's decision, recorded as an ADR; the bootstrap sets both once. |
| **On-disk file formats** — see below | Files already on a user's disk; `just logs` and anyone reading the logs | A new version still reads the old format: a format version and a migration, with a test that reads a sample of the previous format. |
| **The command line** — `myapp counter show`, `myapp counter increment`, `myapp tui`, `--help`, `--version`, what goes to stdout and what to stderr, and the exit codes (0 success, 1 the action failed, 2 a usage error) — see [The binary](#the-binary) | A person, a script, or a scheduled job that runs `myapp` | Keep the old form working, or treat the change as breaking and say so in `CHANGELOG.md`. |

### On-disk file formats

**`counter.json`**, in `~/Library/Application Support/com.example.myapp/` on macOS and
`$XDG_DATA_HOME/myapp/` on Linux, shared by every `myapp` process:

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
A save writes a temporary file named for its process and that save
(`counter.json.<pid>-<n>-<random>.tmp`) in the same directory, syncs it, renames it over
the old file, and syncs the directory, so a crash or a concurrent save leaves the old
file or the new one, never half of each. Every save holds an advisory lock
(`std::fs::File::lock`) on `counter.json.lock` beside it, which is created once, stays
empty, and is never removed; an increment or decrement (`CounterStore::update`) holds it
from the load to the save, so when two `myapp` processes change the counter at once,
neither change is lost. A load takes no lock. A save removes temporary files a crashed save left,
including the fixed `counter.json.tmp` of earlier builds. A missing file is a
fresh counter; an unreadable file or an unknown `version` is a `corrupt` storage error:
showing, incrementing, and decrementing fail and leave it untouched, and only a reset
— the user's explicit request to start over, `r` in `myapp tui` — replaces it. A field
is added with `#[serde(default)]`; renaming or removing one bumps `version`, and the
reader keeps accepting the old version.

**Log files**: `myapp.YYYY-MM-DD.log` from the binary in
`~/Library/Logs/com.example.myapp/` on macOS and `$XDG_STATE_HOME/myapp/logs/` on Linux,
dated in UTC, one per day, the newest 14 kept. Each line is `tracing-subscriber`'s plain
text format: an RFC 3339 timestamp, the level, the target, the message, and its fields.
The message wording is private.

**Private** is everything else: `pub(crate)` and private items, how an adapter talks to
the OS behind its port, the full-screen view's layout and styling, file and module
layout, test helpers, and log wording. Changing any of it needs only the gates that
already run.

No gate notices every broken contract item. The compiler guards core's public API, and
`crates/myapp/tests/cli.rs` guards the command line; a changed file format or a renamed
identifier passes every check and fails on the user's machine, so review is what
catches it, and a user-visible change to any contract item owes a
`CHANGELOG.md` entry.
