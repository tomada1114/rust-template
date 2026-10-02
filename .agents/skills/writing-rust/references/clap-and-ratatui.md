# clap and ratatui, as the binary uses them

The idioms `crates/myapp` uses from its two front-end crates, and the traps a reader new
to Rust meets in them. Both crates are linked, not taught: clap's derive tutorial
(https://docs.rs/clap/latest/clap/_derive/_tutorial/index.html) and ratatui's
documentation (https://docs.rs/ratatui/latest/ratatui/). Where code goes and what it may
decide is `designing-clis` and `building-tuis`; this file is only the language side.

- A subcommand enum derives `Subcommand`; a fieldless one also derives `Clone, Copy`
  so a handler can pass it by value and log it with `?action` (`CounterAction`). The
  `///` on each variant is the user-facing `--help` line, not a note for developers:
  write it for the person typing the command.
- `main` returns `std::process::ExitCode` and each handler returns one, rather than
  calling `std::process::exit`, so destructors run (`designing-clis`).
- `if let … && let …` (a let chain, in `event_loop`) needs edition 2024, which the
  workspace uses ("Let chains are only available in the Rust 2024 edition",
  https://blog.rust-lang.org/2025/06/26/Rust-1.88.0/, checked 2026-10-01).
- `Layout::vertical([...]).areas(rect)` returns a fixed-size array whose length the
  pattern decides, so `let [value_area, error_area, _, help_area] = …` must name
  exactly one binding per constraint. A different count compiles and then panics at
  draw time ("Panics if the number of constraints is not equal to the length of the
  returned array",
  https://docs.rs/ratatui/latest/ratatui/layout/struct.Layout.html#method.areas,
  ratatui 0.30.2, checked 2026-10-02); a `TestBackend` test of every screen catches it.
- A widget style that never changes is a `const` (`ERROR_STYLE: Style =
  Style::new().add_modifier(Modifier::BOLD)` in `tui/view.rs` compiles because both
  calls are `const fn`); `draw` and its tests then share one value.
- crossterm is reached only through `ratatui::crossterm`, never as a direct
  dependency, so the backend and the event types always come from the version ratatui
  was built with (`building-tuis`).
- A test draws with `Terminal::new(TestBackend::new(w, h))`, which returns a
  `Result`; in a `#[test]` `unwrap` is allowed, in a helper outside one it is not
  (`writing-tests` › "Rejected in review").

