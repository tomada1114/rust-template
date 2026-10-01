---
name: designing-core-logic
description: >
  Covers how logic in crates/myapp-core is shaped so it stays deterministic and
  tested: time, randomness, the environment, files, and processes reached only through
  ports or arguments (the Clock port and UnixMillis; core's clippy.toml bans on clock
  reads, env, std::fs and Path queries, sockets, standard streams, processes, exit,
  unscoped threads, sleep, and printing), when a new port is justified, tunable
  numbers in one Tuning struct, state transitions that take self and return a new
  value or a typed error, a service running load, decide, save, a ...View struct as
  the only thing that crosses IPC, no async in core, and the patterns not adopted. Use
  when adding a type, a rule, a use case, a timer, a debounce, a threshold, a limit,
  or anything random or time-dependent to core, when clippy reports a disallowed
  method or type in core, or when reaching for async, a repository trait, a DI
  container, an event bus, or a state library.
---

# Designing Core Logic

**Owns:** how code in `crates/myapp-core` is shaped — what it is handed rather than
reads, where a port is justified, where tunable numbers live, what its entry points and
state transitions look like, what crosses IPC, and which patterns are not adopted.
**Does not own:** the Rust idiom inside a function (`writing-rust`); error enums and
codes (`designing-errors`); an adapter that talks to macOS (`integrating-system-apis`);
the test-first loop (`tdd`); recording a decision to change any of this
(`recording-architecture-decisions`).

## Why this shape

Core's coverage floor only means something if a test can reach every branch without
waiting, and without depending on the machine's clock, files, environment, or luck.
Core also builds and tests on Linux with no window. So anything core would read from
the world is an input, and every decision the app makes lives here, where the floor
sees it; the shell, the adapters, and the CLI translate.

The dependency direction and the three layers that enforce the boundary are in
`AGENTS.md` › "Architecture"; this skill is about the code inside it.

## What core is handed rather than reads

Enforced by: `crates/myapp-core/clippy.toml` `disallowed-methods`, `disallowed-macros`,
and `disallowed-types` (run by `just lint`). The judgment is what to do instead:

| Core needs | It gets it as | Never |
|---|---|---|
| The current time | the `Clock` port (`crates/myapp-core/src/time.rs`), read as `UnixMillis` | `SystemTime::now`, `Instant::now`, and either type's `elapsed` |
| To wait (a delay, a debounce, a periodic tick) | nothing: core decides "is it due at this instant?" from a `UnixMillis` it is handed, and the shell schedules the call | `std::thread::sleep`, `std::thread::park_timeout`, a timer thread (`std::thread::spawn`, `std::thread::Builder::spawn`) |
| Configuration | an argument or a field of a struct the shell builds | `std::env::var`, `var_os`, `vars`, `vars_os`, `args`, `args_os` |
| A directory (the working, temporary, or data directory) | a path argument the shell resolves | `std::env::current_dir`, `temp_dir`, `home_dir`, `current_exe` |
| A fact about the process or the machine (its id, its parent's id, the CPU count) | an argument the shell reads | `std::process::id`, `std::os::unix::process::parent_id`, `std::thread::available_parallelism` |
| To change the process's environment or working directory | nothing: that is the shell's or the CLI's decision | `std::env::set_var`, `remove_var`, `set_current_dir`, `std::os::unix::fs::chroot` |
| Stored data, a file, standard input, the network | a port with a real adapter in `myapp-platform` | `std::fs::{File, OpenOptions, DirBuilder}`, every `std::fs` free function (`read`, `write`, `read_dir`, `metadata`, `copy`, …), `std::os::unix::fs::{symlink, chown, fchown, lchown}`, `Path`'s (and so `PathBuf`'s) `exists`, `try_exists`, `metadata`, `symlink_metadata`, `read_dir`, `read_link`, `canonicalize`, `is_file`, `is_dir`, `is_symlink`, `std::io::stdin`, `std::net::{TcpStream, TcpListener, UdpSocket}`, `std::os::unix::net::{UnixStream, UnixListener, UnixDatagram}`, `ToSocketAddrs::to_socket_addrs` (a DNS lookup) |
| Another process | a port whose adapter runs it | `std::process::Command` |
| To stop the process | an `Err` the shell or the CLI turns into an exit | `std::process::exit`, `std::process::abort` |
| Randomness | a seed or an already-drawn value as an argument, like time | a random-number crate in core (a new dependency) |
| "Today", a formatted date or number | nothing: core returns `UnixMillis` and numbers; the UI formats with the user's locale and time zone (`ui/src/copy/`) | a formatted string from Rust |
| To log | the `tracing` macros, which emit and never install a subscriber (the shell and the CLI do); core has no `tracing` dependency yet, so until one is added (`managing-dependencies`) core returns what happened and the shell logs it | `print!`, `println!`, `eprint!`, `eprintln!`, `dbg!`, `std::io::stdout`, `std::io::stderr` |

clippy enforces the `std` paths and macros named in the last column in core's library
and its unit and integration tests. It does not lint doctests, so a `///` example that
calls one passes, and review is what catches it, as it does the rest of that column (a
random-number crate, a formatted string). A `Path` or `PathBuf` is data in core:
joining, comparing, and reading its components are allowed, asking the file system
about it is not.

Core never starts a thread that outlives the call. `std::thread::scope` is allowed, in
production core and tests alike, since a scope joins every thread it started before it
returns and so cannot outlive the call; a core test that drives a service from several
threads uses it.

In the sample, `CounterService` is handed an `Arc<dyn Clock>` and stamps a change with
`self.clock.now()`; a test hands it `FixedClock` and moves time with `advance`.

A duration held in core is a `std::time::Duration` or a number of milliseconds; only
reading the clock is banned, not representing time.

## When a port is justified

- A port exists only where something outside the process answers: the file system, the
  clock, and later an OS API. It then has two implementations, the real adapter and the
  fake. A pure rule is never a port; test the function directly. A trait added "for
  testability" around code that has no outside dependency is indirection with nothing
  behind it.
- A port is a synchronous `Send + Sync` trait with `&self` methods, over types core
  owns. A new one comes with its adapter, its fake, and its `<port>_contract` function
  in the same change, and it is an architecture decision (`AGENTS.md` › "Before
  changing the architecture"). **REQUIRED:** `recording-architecture-decisions`.
- No `async` in core. Ports are plain calls; the shell moves a slow one onto a blocking
  thread (`tauri::async_runtime::spawn_blocking` in `src-tauri/src/commands.rs`). This
  keeps an async runtime out of the crate every decision lives in, and keeps core
  readable for someone new to Rust. A port that is inherently a stream is modelled as a
  callback or a channel the shell drives.
- A dependency core does not have yet — `tracing`, a random-number crate, anything —
  is a dependency decision before it is a design one (`managing-dependencies`).

## One `Tuning`

- Every number someone might want to tweak — a bound, a limit, a delay, a retry count —
  is a field of one `Tuning` struct, never a literal in a method body. It derives
  `Debug, Clone, Copy, PartialEq, Eq`, implements `Default` with the shipped values,
  and each field's `///` says why it has that value.
- The shell builds it and passes it in, so a test passes a tiny one to reach a boundary
  in one step. In the sample, `Tuning` lives in
  `crates/myapp-core/src/counter/mod.rs`, `src-tauri/src/lib.rs` and
  `crates/myapp-cli/src/main.rs` pass `Tuning::default()`, and
  `crates/myapp-core/tests/counter_service.rs` uses `Tuning::new(0, 2)`.
- When fields only make sense together, keep them private and let a constructor refuse
  an inconsistent set with a typed error. In the sample, `Tuning::new(min, max)`
  returns `TuningError::MinAboveMax` when `min > max`, so every `Tuning` holds a range
  with a value in it.
- A domain invariant is not a tunable. Ask: would changing it be a product tweak
  (`Tuning`) or change what the type means (a constant or a parameter of the type)?
- A value from outside is never trusted to be well formed: code that receives stored
  data or input from the UI handles an inconsistent one without panicking. In the
  sample, `Counter::new` pulls a stored value into range with `clamp`, which cannot
  panic because `Tuning::new` refuses `min > max`, and `UiLogEntry::loggable_message`
  escapes and cuts whatever message the UI sends before it reaches the log.
- When a second feature needs tunables, give `Tuning` one nested struct per feature and
  keep one root type, so there is one place to look.

## State transitions and use cases

- A domain value is a struct with private fields and a constructor that establishes its
  invariant. A state transition is a method that takes `self` and returns the new value
  or a typed error, never a `&mut self` setter that returns nothing. In the sample,
  `Counter::increment` takes `self` and returns `Result<Self, CounterError>`. A rejected
  transition then leaves nothing half-changed, and a test of it is one `assert_eq!`.
- A use case is a method on a service named for what the user did (`increment`,
  `reset`), not a setter and not a generic `dispatch(action)`: each is typed,
  discoverable, and tested on its own. It runs **load → decide → save**: load the
  state, call the pure decision, save only if the decision succeeded, return the view.
  In the sample, `CounterService::change` does this under one `Mutex`, so two commands
  running at once cannot lose an update; the clock is read only when there is a change
  to stamp.
- Construction has no side effects: `new` stores what it is handed and reads nothing.
  The first load happens when a use case runs.

## What crosses IPC

- The UI receives one `…View` struct per model: the data it renders, in plain numbers,
  strings, `Option`s, and `UnixMillis` — never wording, never an internal type. It
  derives `Serialize` and `ts_rs::TS` with
  `#[cfg_attr(feature = "export-bindings", ts(export))]` and
  `#[serde(rename_all = "camelCase")]`. In the sample, `CounterView { value,
  last_changed_at, revision }` is the only counter type that crosses; `Counter` itself
  does not. `revision` counts the saves the service has made (raised only after a save
  succeeds), so a UI that receives views out of order, from a command's reply and from
  the event, keeps the one with the higher revision; it is not stored.
- What goes to disk is its own type (in the sample, `StoredCounter`), separate from the
  view, so the file format and the IPC shape can change independently. Both are
  contract (`docs/architecture.md` › "What is contract and what is private").
- Input from the UI is a `Deserialize + TS` type declared in core, with enums rather
  than strings for closed sets, so a malformed payload is rejected before any code runs
  (`UiLogEntry`, whose `level` is `UiLogLevel`).
- A failure crosses as a code, never a sentence (`designing-errors`).

## Deliberately not adopted

Each is a pattern an implementer may reach for out of habit. Adopting one needs an ADR
naming the problem the current shape cannot solve (**REQUIRED:**
`recording-architecture-decisions`).

| Pattern | Why not |
|---|---|
| `async` in core, or an async runtime as a core dependency | ports are synchronous; the shell owns threads and scheduling |
| A trait per type "for testability", or a mocking crate | a port exists only at an outside boundary; fakes are real implementations |
| A repository per entity, entity classes, per-layer DTO copies | one store port per persisted thing; the view is the one outward shape |
| Use-case or interactor structs, one per action | a method on the service already is the use case |
| A generic `dispatch(action)` reducer | named methods are typed and tested one at a time |
| A DI container or service locator | `src-tauri/src/lib.rs` is the composition root; constructor arguments suffice |
| Global mutable state (`static mut`, a lazily built singleton) | state lives in the service the shell holds in `tauri::State` |
| An event bus or channels between core types | direct calls; the shell turns a change into a Tauri event |
| A state-management library in the UI | one hook per Rust-owned model |

The reasoning behind this shape is in `README.md` › "Design Philosophy" (the sections on
ports, synchronous ports, and the coverage floor).

## Testing the shape

A value type's transitions get unit tests beside it; a use case runs against the fakes
in `crates/myapp-core/tests/`; every port's fake and adapter run its contract.
**BACKGROUND:** `placing-tests` for where, `writing-tests` for how.
