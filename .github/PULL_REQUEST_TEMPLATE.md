## Summary

<!-- What does this pull request do, and why? Link the issue it closes with "Closes #…". -->
<!-- The title follows Conventional Commits, e.g. "fix: keep the counter at its maximum". -->

**Release impact:** <!-- none | PATCH | MINOR | MAJOR, and why: what a user of the tool depends on (the command line: subcommands, flags, stdout and stderr, exit codes; on-disk formats; the data and log locations; rust-version) that this changes. -->

## Test Plan

<!-- How was this verified? Which commands did you run, and what did they print? -->

## Checklist

- [ ] `just check` passes
- [ ] New logic lives in `myapp-core` and is covered by tests (happy and error path)
- [ ] New public items have `///` comments saying why
- [ ] Adapter change with an `#[ignore]`d test: `just test-local` was run and its output is in the Test Plan (CI cannot run it)
- [ ] Change to the TUI's terminal loop: a human ran `myapp tui` and the Test Plan says what they saw (no check runs it)
- [ ] No new dependency, or its reason is stated here for sign-off
- [ ] No gate weakened (a lint suppression, a lowered floor, a coverage exclusion, an `#[ignore]` on a failing test)
- [ ] Documentation updated (if applicable)
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (if user-visible)
