---
name: designing-clis
description: >
  Covers the myapp binary's command line in crates/myapp/src/main.rs: the clap derive
  declaration (a Subcommand enum per noun, doc comments as --help text), the thin
  handler that composes the real adapters, calls one core method, and prints a view,
  stdout for data and stderr for error: and warning: lines, exit codes (0 success, 1 the
  action failed, 2 a clap usage error) through ExitCode, a closed stdout pipe, the
  wording module crates/myapp/src/wording.rs, a --json form for output a script reads,
  config and environment precedence (flag, environment variable, config file,
  Tuning::default) with HOME and XDG_* read only in myapp-platform, and testing the
  built binary against a temporary HOME in crates/myapp/tests/cli.rs. Use when adding,
  renaming, or removing a subcommand, flag, or argument, changing what a command prints
  or its exit code, adding wording for an error variant, adding --json output, a
  setting, an environment variable, or a config file, or when a cli.rs test fails.
---

# Designing CLIs

**Owns:** the command line of the `myapp` binary: how subcommands are declared and
laid out, what a handler may do, which stream gets what, the exit codes, the wording
module, machine-readable output, where configuration is resolved, and how the binary is
tested. **Does not own:** the decision a subcommand runs (`designing-core-logic`); the
error enum behind a failure (`designing-errors`); the full-screen `tui` subcommand
(`building-tuis`); the body of a test (`writing-tests`) or its file (`placing-tests`);
seeing the binary run (`running-the-app`); a new crate or crate feature
(`managing-dependencies`).

The command line is contract: a person, a script, or a scheduled job runs it, and an
old invocation must keep working (`docs/architecture.md` › "What is contract and what is
private"). Everything below follows from that, and from the rule that the binary
translates and decides nothing (`AGENTS.md` › "Architecture").

## The shape: parse, compose, call core, print

- One binary, `myapp`, declared with clap's derive API in `crates/myapp/src/main.rs`
  (<https://docs.rs/clap/latest/clap/_derive/index.html>). A `Parser` struct holds one
  `Subcommand` enum; a noun with several verbs gets its own nested enum, so the line
  reads `myapp <noun> <verb>`. In the sample: `Cli`, `Command::{Counter, Tui}`, and
  `CounterAction::{Show, Increment}` give `myapp counter show`.
- The `///` comment on a variant is its line in `--help`, so it says what the command
  does for its user, in one sentence ending with a period. `#[command(version)]` takes
  the version from `[workspace.package]`, and with no `about` key clap uses the `///` on
  the `Cli` struct as the first line of `myapp --help` (without its final period;
  `help_opens_with_the_tools_about_line` in `crates/myapp/tests/cli.rs` pins it). A bare
  `about` would take the crate's `Cargo.toml` `description` instead, which is written
  for maintainers, not for the tool's user.
- A handler is translation only: build the service, call one core method, print the
  result or the error. A `match` arm that holds an `if` about the domain is a decision
  in the wrong crate; move it into core, where the coverage floor sees it. In the
  sample, `counter(action)` maps each `CounterAction` to one `CounterService` call.
- One composition root. The real adapters are built in one function and nowhere else,
  so every subcommand and the TUI run against the same wiring. In the sample,
  `compose(echo_logs)` finds `HOME`, starts logging (best effort: a warning, then the
  action still runs), and returns the `CounterService` over `JsonFileCounterStore` and
  `SystemClock`.
- Rendering a view is one small function per view, so every subcommand that prints it
  prints the same line (`render(&CounterView)` in the sample).

Adding a subcommand, in order: the core method with its tests first (**REQUIRED:**
`tdd`); the variant with its `///`; the arm in the handler; wording for any new error
variant; the tests in `crates/myapp/tests/cli.rs`; then `docs/architecture.md` › "The
binary" and a `CHANGELOG.md` entry, because a user can now type something new.

## stdout is data, stderr is everything else

- **stdout** carries only the result, one value per line, nothing decorative, so
  `myapp counter show | …` works and a script never parses around a banner.
- **stderr** carries `error: <wording>` for a failed action, `warning: <wording>` for a
  degraded run, and, in a debug build only, a copy of each log line (`compose(true)`).
  A test reads the diagnostic as the last stderr line for that reason.
- Write stdout with `writeln!(io::stdout().lock(), …)` and handle the `Err`. `println!`
  panics when stdout is closed (`myapp counter show | true` once `true` has exited), and
  under the release profile's `panic = "abort"` the process then prints only the panic
  message and aborts: no `error: …` line and no exit 1 for a script to read. The sample
  maps the failure to `wording::STDOUT_UNAVAILABLE` and exit 1.
- No color and no terminal control in a subcommand's output: the workspace builds clap
  without its `color` feature (`Cargo.toml`'s `[workspace.dependencies]`), and logs are
  written with `with_ansi(false)`. Output that may land in a file or a pipe stays plain.
- A subcommand that owns the screen writes nothing to stdout or stderr while it does
  (`building-tuis`).

## Exit codes

| Code | Means | Who returns it |
|---|---|---|
| 0 | success, including `--help` and `--version` | the handler, `ExitCode::SUCCESS`; clap for help and version |
| 1 | the action failed: a bound, storage, no `HOME`, no terminal for `tui`, stdout unwritable | the handler, `ExitCode::FAILURE`, after printing `error: …` |
| 2 | a usage error: an unknown subcommand or flag, a missing one | clap, with its message and usage on stderr, before any adapter is touched |

- `main` returns `ExitCode`; nothing calls `std::process::exit`, which ends the process
  without running destructors (<https://doc.rust-lang.org/std/process/fn.exit.html>), so
  a lock file or a buffered log line could be left behind.
- A usage error touches nothing: parsing happens before `compose`, and
  `a_usage_error_touches_nothing` in `cli.rs` asserts the temporary `HOME` stays empty.
- A distinct code per error kind is a change to the contract, not a refactor: say so in
  `CHANGELOG.md` and `docs/architecture.md` › "The binary", and test each code.

## The wording module

`crates/myapp/src/wording.rs` holds every sentence `myapp` writes to stderr and the
error line the `tui` screen shows. Core returns a variant and never a sentence
(`designing-errors`), so the words live in one place:

- A fixed sentence is a `pub const` with a `///` saying when it prints
  (`HOME_MISSING`, `TERMINAL_MISSING`). An error enum gets one function that matches
  every variant with no `_ =>` arm (`counter_error`, `storage_error`); `main.rs` denies
  `clippy::wildcard_enum_match_arm`, so a new core variant does not compile until it
  has its words.
- The style the sample keeps: lowercase, no final period, what failed and what it means
  for the user ("the counter file holds data this version cannot read"). No path, no
  file content, nothing the user typed: the line can be pasted into a public bug report.
- Each variant's wording has its own test in the module's `#[cfg(test)] mod tests`, and
  `cli.rs` asserts the full `error: …` line for each failure a user can reach.

## `--json`, when a script reads the output

The sample has no `--json`; add one only when a tool's output is consumed by a program.

- A flag on the subcommand that prints a view: one JSON document on stdout, the same
  exit codes, and diagnostics still on stderr. A failure stays `error: <wording>` on
  stderr with exit 1; if a script must branch on why, print the core error's code too,
  since core's error enums already serialize as `{ "code": … }`
  (`crates/myapp-core/tests/serialization.rs` pins the sample's).
- Decide which fields are promised. A field that only means something inside one
  process stays out of the output (in the sample, `CounterView::revision` counts this
  process's saves), which may mean an output type of its own.
- The JSON is contract from its first release: pin it with a literal `json!({ … })` or
  string test in `cli.rs`, and add a field rather than rename one.
- `myapp` does not depend on `serde_json` today; adding it to `crates/myapp/Cargo.toml`
  is a dependency change even though the workspace already pins a version.
  **REQUIRED:** `managing-dependencies`.

## Configuration and the environment

- Core reads no environment (`crates/myapp-core/clippy.toml` bans it). The binary
  reads `HOME` through `myapp_platform::home_dir`, and on Linux `XDG_DATA_HOME` and
  `XDG_STATE_HOME` through `app_data_dir` and `log_dir`; every file location hangs off
  them, which is what lets a test redirect all of it with one variable.
- When a tool grows a setting, resolve it once, in the composition root, highest first:
  a flag on the command line, then an environment variable, then a config file, then
  the shipped default (`Tuning::default()` in the sample). Hand core the result as a
  value, a `Tuning` field. The narrowest scope wins: a flag is this run, a variable this
  shell, a file this user.
- Name a variable `MYAPP_<SETTING>`, so the bootstrap renames it with the app.
- clap's `#[arg(env = "…")]` needs clap's `env` feature
  (<https://docs.rs/clap/latest/clap/_features/index.html>, checked 2026-10-01), which
  the workspace does not enable; turning it on is a dependency change.
- A config file is persistence: where it lives and its format are an ADR decision
  (`AGENTS.md` › "Before changing the architecture"), and reading it belongs in
  `myapp-platform`. A value that does not parse fails the run with exit 1 and wording
  that names the setting and where it came from, never silently falls back.

## Testing the binary

`crates/myapp/tests/cli.rs` runs the built executable (`env!("CARGO_BIN_EXE_myapp")`)
with `HOME` set to a `tempfile::tempdir()` and the `XDG_*` variables removed, on the
child process only, so nothing touches the developer's data or logs. Each test asserts
the exit code, stdout exactly, and the last stderr line; failures use
`assert_runtime_error`. Cover per subcommand: success, each runtime error a user can
reach, a usage error, and that a failure prints no data. `just test-core` and
`just test-platform` both run it. A cheap check of the declaration itself is a unit test
calling `Cli::command().debug_assert()` (`clap::CommandFactory`), which panics on a
contradictory argument definition
(<https://docs.rs/clap/latest/clap/struct.Command.html#method.debug_assert>, clap 4.6.7,
checked 2026-10-01); the sample has none yet. **REQUIRED:** `writing-tests` for the
assertions.
