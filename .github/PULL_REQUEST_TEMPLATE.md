## Summary

<!-- What does this pull request do, and why? Link the issue it closes with "Closes #…". -->
<!-- The title follows Conventional Commits, e.g. "fix: keep the counter at its maximum". -->

## Test Plan

<!-- How was this verified? Which commands did you run, and what did they print? -->

## Checklist

- [ ] `just check` passes
- [ ] New logic lives in `myapp-core` and is covered by tests (happy and error path)
- [ ] IPC change: `just bindings` was run and `ui/src/ipc/` was updated to match
- [ ] Adapter change with an `#[ignore]`d test: `just test-local` was run and its output is in the Test Plan (CI cannot run it)
- [ ] UI-to-Rust wiring change: evidence from `just run` and `just logs` is in the Test Plan
- [ ] No new dependency, or its reason is stated here for sign-off
- [ ] No gate weakened (a lint suppression, a lowered floor, a coverage exclusion, an `#[ignore]` on a failing test)
- [ ] Documentation updated (if applicable)
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (if user-visible)
