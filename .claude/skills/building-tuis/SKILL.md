---
name: building-tuis
description: >
  Covers the full-screen terminal UI behind myapp tui: the screen's model and update in
  myapp-core (a ...Screen value, a ScreenAction per user intent, a ScreenKey that names
  no terminal library, update(self, action, service) returning the next screen), the
  binary's crates/myapp/src/tui/ (mod.rs enters raw mode and the alternate screen, runs
  the event loop, translates crossterm KeyEvent into ScreenKey, and restores the
  terminal on exit, on an error, and from a panic hook; view.rs draws with ratatui
  widgets and Style, words from wording.rs, a help line built from core's key table),
  testing the view with ratatui's TestBackend (assert_buffer_lines, assert_buffer with
  styles), keys as values, and never taking over the developer's terminal in a check.
  Use when adding or changing a screen, a key binding, a widget, a style, or the event
  loop, when touching ratatui, crossterm, raw mode, the alternate screen, or the panic
  hook, when a TestBackend test fails, or when asked to run or look at myapp tui.
---

# Building TUIs

**Owns:** how a full-screen terminal view is split between core and the binary, the
terminal's lifecycle, how a screen is drawn and styled, how it is tested without a
terminal, and what no check may do to a terminal. **Does not own:** the domain rules a
screen calls (`designing-core-logic`); the wording of an error (`designing-clis` ›
"The wording module"); the error enums (`designing-errors`); the body of a test
(`writing-tests`); a human's run of the screen (`running-the-app`); a ratatui or
crossterm upgrade or feature (`managing-dependencies`).

The view is immediate-mode: each pass draws the whole frame from one value, and a key
turns that value into the next one. The split below keeps every decision in a place a
test reaches, because the one part no check runs is the loop that owns a real terminal.

## What lives where

| Piece | Where | In the sample |
|---|---|---|
| The screen's state, and what an action does to it | core, a `…Screen` type | `CounterScreen` in `crates/myapp-core/src/counter/screen.rs` |
| The user's intents, and the keys bound to each | core, an action enum with its key table | `ScreenAction` with `keys()`, `for_key`, and `ALL` |
| A key as the screen sees it | core, an enum that names no terminal library | `ScreenKey::{Char, Up, Down, Esc, Interrupt}` |
| Entering, reading events, translating keys, leaving | the binary, `crates/myapp/src/tui/mod.rs` | `run`, `enter`, `leave`, `install_panic_hook`, `event_loop`, `screen_key` |
| Drawing one state | the binary, `crates/myapp/src/tui/view.rs` | `draw(frame, &screen)` |

- Core never names ratatui or crossterm. No gate stops it (the core boundary's lists
  in `AGENTS.md` › "Architecture" name OS bindings and platform adapters), so review holds
  the line: with a key type of core's own, the whole state machine is tested inside the
  coverage floor with plain values, and a second front end could drive the same screen.
- A screen's `update` takes `self` and returns the next screen: success shows the new
  view and clears the error; failure keeps the last view and holds the error; quitting
  only marks it finished. In the sample, `CounterScreen::update(self, action, &service)`
  calls one `CounterService` method per action.
- The key table is data in core, and the help line is built from it
  (`ScreenAction::ALL` and `keys()`), so the line on screen cannot drift from what the
  keys do. Every action has a key and is named on screen: nothing is reachable only by
  a mouse or a hidden chord.
- Control-C arrives as a key in raw mode, not as a signal, so it must map to quit
  (`ScreenKey::Interrupt`); otherwise the user cannot leave.

## The terminal's lifecycle

`tui::run` is the pattern; copy its order rather than rewriting it.

1. **Refuse before touching anything.** `main.rs`'s `tui()` checks that stdin and
   stdout are both terminals (`IsTerminal`) and otherwise prints `error: …` and exits 1,
   before it opens the store or the log. Without the check, a script or CI job would
   hang waiting for a key.
2. **Log to the file only.** A line written to stdout or stderr while the screen owns
   the terminal corrupts the frame, so the TUI composes with `compose(false)`.
3. **Install the panic hook first**, then enter raw mode and the alternate screen. The
   release profile's `panic = "abort"` never unwinds back to `run`, so the hook is the
   only code that can restore the terminal before the panic message prints.
4. **Restore on every way out.** `leave()` turns raw mode off, leaves the alternate
   screen, and shows the cursor; each step runs even if the one before failed, and it
   is harmless when nothing was entered. `run` calls it after a normal exit and after an
   error, then returns the first error.
5. **Report after restoring.** An `io::Error` from the loop becomes
   `wording::TERMINAL_FAILED` on stderr and exit 1, printed on the restored screen.

The loop draws, blocks on `event::read()`, translates a key press with `screen_key`,
and hands the action to `update`. A resize or any other event just redraws. Only a
press counts (`KeyEventKind::Press`), so a terminal that also reports releases or
repeats never acts twice on one key. ratatui reaches crossterm only as
`ratatui::crossterm`, so the two never disagree on a version; the API is ratatui's
(<https://docs.rs/ratatui/latest/ratatui/>).

A timer, a tick, or watching a file for another process's change is not in the sample.
Add it as an action the loop produces (a tick becomes a `ScreenAction`), with the time
handed to core as a value; core still never sleeps or reads the clock
(`designing-core-logic`).

## Drawing

- `draw(frame, &screen)` reads the state and draws; it decides nothing and changes
  nothing. A condition that is about the domain (is this an error? is it at the
  bound?) is a method on the core screen that `draw` asks.
- Lay out with `Layout` and `Constraint`, and draw the whole frame each pass.
  A terminal smaller than the layout clips; it must not panic
  (`a_terminal_too_small_for_the_screen_clips_it_without_panicking`).
- Words: labels a screen owns are private `const`s at the top of `view.rs`; an error's
  wording comes from `wording.rs`, the same sentence the subcommand prints, so the CLI
  and the TUI never describe one failure two ways.
- Style: the terminal's own foreground and background, with `Style` modifiers for
  emphasis, kept as `const`s beside the labels (`ERROR_STYLE` is bold). No color carries
  meaning alone: the error line says "Error:" as well as being bold, so it reads in a
  light or dark terminal and in a monochrome one.

## Testing without a terminal

| Question | Test | In the sample |
|---|---|---|
| What an action does to the screen | core tests over the fakes, keys and actions as values | `crates/myapp-core/tests/counter_screen.rs`, `screen.rs`'s unit tests |
| Which key event becomes which `ScreenKey` | unit tests of the translation, `KeyEvent` built with `KeyEvent::new_with_kind` | `tui/mod.rs`'s tests |
| What a state looks like | `draw` into ratatui's `TestBackend` and compare the buffer | `tui/view.rs`'s tests |

- `Terminal::new(TestBackend::new(width, height))` and `terminal.draw(|frame| draw(frame,
  &screen))` render into memory; no real terminal is opened.
- `backend().assert_buffer_lines([...])` compares the text of every cell with default
  styles; when a cell is styled (the bold error line), build the expected
  `Buffer::with_lines`, `set_style` on the styled run, and use `assert_buffer`, which
  compares styles too (<https://docs.rs/ratatui/latest/ratatui/backend/struct.TestBackend.html>,
  ratatui 0.30.2, checked 2026-10-01).
- Draw each state the user can reach: the normal view, each error, a value that cannot
  be read, the error cleared by the next success, and a terminal too small. The expected
  lines are written out by hand, border included.
- No test calls `run`, `enter`, or `event::read`: the loop is the gap, kept small for
  that reason, and a human running `myapp tui` is its check.

## Never taking over the developer's terminal

`AGENTS.md` › "Never taking over the developer's Mac" holds for terminals too. No check,
hook, or step an agent runs on its own enables raw mode, enters the alternate screen,
reads a key from a real terminal, or runs `myapp tui`. Running the screen is a human's
step: when a change shows only in a real terminal (the restore after a crash, a resize,
how it looks), ask the human once to run it and say what to press and what to look for
(**REQUIRED:** `running-the-app`). The real-terminal loop has no automated test, not
even an `#[ignore]`d one: `just test-local` runs under nextest, which gives a test no
interactive terminal, so such a test could never pass there. It stays a human's manual
run, which is why the loop is kept small and everything else is tested above.
