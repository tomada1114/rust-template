# Release impact

The line every pull request body carries, and how to choose its level. `create-pr`
Step 4 links here.

## The line

Every pull request says whether it changes what a user of the app gets, so a reviewer
can tell a deliberate "no release needed" from a decision nobody made.
`.github/PULL_REQUEST_TEMPLATE.md` carries the label `**Release impact:**` under the
Summary; replace the comment after it with one of these two forms, literally:

```text
**Release impact:** <MAJOR|MINOR|PATCH> -- <one line: what changes for a user, and why>.
**Release impact:** none -- <one line: why the shipped app does not change>.
```

A missing value is not `none`; ask for it before approving.

**none** fits a change that leaves the shipped `.app` and its bundled helper untouched:
CI workflows, docs, tests, repository scripts, skills, harness checks, a dev-only
dependency. A level fits everything that changes the bundle: Rust in any crate that
ships, the UI, `tauri.conf.json`, the entitlements, a runtime dependency.

## Choosing the level

Nothing here is a published library, so the level is judged against what a user's Mac
already depends on: the contract in `docs/architecture.md` › "What is contract and what
is private" (on-disk formats, the helper's command line, the bundle identifier), the
macOS versions the app runs on, and the behavior a user sees. Core's public API and the
IPC names change together with their callers in one pull request, so on their own they
never make a release breaking.

| Change | Level |
|---|---|
| A new version cannot read a file an earlier version wrote | MAJOR |
| The helper's command line loses or renames a subcommand, flag, or exit code a launchd job may call | MAJOR |
| `minimumSystemVersion` in `src-tauri/tauri.conf.json` goes up (a user on the older macOS loses the app) | MAJOR |
| A user-visible feature, a new helper subcommand, or a new on-disk format version that still reads the old one | MINOR |
| A new privacy (TCC) permission the user will be asked for | MINOR, and say so in the line |
| A fix, a performance change, or a user-visible wording change | PATCH |
| An internal refactor, or a runtime dependency bump, with no visible change | PATCH |

A pull request that touches several rows takes the highest: MAJOR over MINOR over PATCH.

Decide from the table first, then from the version the app is on (`version` in
`src-tauri/tauri.conf.json`). Below `1.0.0` a MAJOR change ships as a minor bump and
carries migration notes for the user in `CHANGELOG.md`; the line still names MAJOR, so a
reviewer sees the break rather than a minor bump that hides one.

The bundle identifier never changes in a release: to macOS a new identifier is a new
app, and the user's data and privacy grants stay behind under the old one. A pull
request that changes it stops for a human and an ADR.

## CHANGELOG.md

A user-visible change adds its entry under `[Unreleased]` in the same pull request, in
the Keep a Changelog section that fits (Added, Changed, Fixed, Removed, Security), in
terms of what a user observes rather than which files moved. `just release-prep` later
rolls `[Unreleased]` into a dated section; `releasing-the-app` owns that step and the
version number itself.
