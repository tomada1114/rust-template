---
name: releasing-the-app
description: >
  Covers cutting a release of the app: choosing the version (MAJOR, MINOR, PATCH) from
  what is contract, curating CHANGELOG.md's [Unreleased] section, just release-prep and
  its three version sites (Cargo.toml [workspace.package], src-tauri/tauri.conf.json,
  package.json) and Cargo.lock, the release pull request, the release.yml
  workflow_dispatch dry run, the v* tag a human pushes, ad-hoc versus Developer ID
  signing and notarization and the APPLE_* secrets docs/distribution.md names,
  Gatekeeper and quarantine for an ad-hoc build, and verifying the built .app and .dmg
  (codesign, entitlements, spctl, SHA256SUMS, gh attestation verify). Use when
  preparing or tagging a release, an ERR_RELEASE_* code from scripts/release-prep.ts,
  a tag that does not match the version, a failed signing or notarization step, a user
  who cannot open a downloaded build, or deciding whether a change needs a release.
---

# Releasing the App

**Owns:** turning `main` into a published release: the version, the changelog roll,
`just release-prep`, the release pull request, the dry run, the tag, the signing paths,
and verifying what was built. **Does not own:** the `CHANGELOG.md` entry each pull
request adds and which document a change lands on (`updating-docs`); the pull request
body's Release impact line (`create-pr`); changing `release.yml` or any gate
(`changing-gates`); a distribution decision such as notarization, an updater, or a
universal build (`recording-architecture-decisions`); the facts and their sources,
which live in `docs/distribution.md`.

`docs/distribution.md` is the reference for the release: what is built for which Macs,
the workflow's steps, both signing paths and their secrets, what a user sees when they
open a build, and the verification commands, each external fact with its source. This
skill is the order of work and the decisions around it; it does not copy that page.

## Who does what

- **An agent** may curate the changelog, run `just release-prep` when asked (it writes
  files, so it waits to be asked), open the release pull request (`create-pr`), and
  read runs (`gh run list`, `gh run view`, `gh run watch`).
- **A human** starts the dry run (a remote write that runs a workflow), creates and
  pushes the tag (`AGENTS.md` › "Security and human approval" lists a release tag), and
  adds or changes any `APPLE_*` secret. An agent never reads, prints, or asks for a
  secret's value; it names the secret and where it goes.
- No `.dmg` is built locally, by anyone's routine: building one drives Finder through
  AppleScript (`AGENTS.md` › "Never taking over the developer's Mac"). The release
  workflow on a CI runner is the only place one is made.

## 1. Choose the version

Judge the diff since the last release against what is contract, the table in
`docs/architecture.md` › "What is contract and what is private", not against the code:

| Change since the last release | Level |
|---|---|
| A user's data or integration stops working: an on-disk format the new build cannot read, a helper command line or exit code changed incompatibly, a raised `minimumSystemVersion` | MAJOR |
| A new user-visible capability: a screen, a setting, a helper subcommand, a format version that still reads the old one | MINOR |
| A fix, a wording change, a runtime dependency bump with no visible change | PATCH |

A change that leaves the shipped `.app` and its helper untouched (documentation, CI,
tests, repository scripts, skills, a dev-only dependency) has no level and does not call
for a release on its own (`create-pr` › `references/release-impact.md`).

The level is the highest row any change touches. While the app is below `1.0.0`, a
MAJOR change ships as a minor bump; its changelog entry says what a user must do and
names it as breaking, so the minor number does not hide it.
Read the current version from `Cargo.toml` rather than assuming which period applies.
A new bundle identifier is not a version at all: to macOS it is a different app, and it
is an ADR.

## 2. Curate `[Unreleased]`

Each pull request added its own entry; before the release, read the whole section as
one user would. Merge duplicates, move entries to the right Keep a Changelog heading,
and write each as behaviour a user sees. An ad-hoc release says in its notes how to
open a quarantined download (`docs/distribution.md` › "Opening an ad-hoc build").

## 3. `just release-prep <version>`

```bash
just release-prep 0.2.0 --dry-run   # every check, nothing written
just release-prep 0.2.0             # writes the three version sites, Cargo.lock, CHANGELOG.md
```

`scripts/release-prep.ts` sets `version` in `Cargo.toml`'s `[workspace.package]`,
`src-tauri/tauri.conf.json`, and `package.json`, refreshes `Cargo.lock` offline, and
moves the `[Unreleased]` entries under `## [<version>] - <date>`, leaving an empty
`[Unreleased]` above. It creates no commit, tag, or push, so the result is one
reviewable diff. It refuses, each with a code and a `Next:` line:

- a version that is not plain `MAJOR.MINOR.PATCH` (`ERR_RELEASE_VERSION_INVALID`), or
  not greater than the current one, compared as numbers (`ERR_RELEASE_VERSION_NOT_NEWER`);
- a work tree with uncommitted changes (`ERR_RELEASE_DIRTY`) or no work tree
  (`ERR_RELEASE_NOT_A_REPO`);
- three sites that already disagree (`ERR_RELEASE_VERSIONS_DIFFER`): fix that in its
  own commit first;
- a missing or empty `[Unreleased]` (`ERR_RELEASE_CHANGELOG_MISSING`,
  `ERR_RELEASE_CHANGELOG_EMPTY`), and a `cargo update` that fails (`ERR_RELEASE_LOCKFILE`).

Why three sites: Cargo, Tauri's bundle, and pnpm each read their own, and the release
workflow refuses a tag that differs from any of them, but only after the tag is pushed.
The script checks the same agreement while it is still cheap.

## 4. The release pull request

Branch, commit the five files, open the pull request, and let a human merge it once CI
is green: `docs/distribution.md` › "Preparing the version" has the exact commands.
Nothing else rides in a release pull request, so its diff is the release. Its body is
the pull request template filled in like any other, with the level chosen in step 1 on
its Release impact line, never a body filled from the commit message (`--fill`).
**REQUIRED:** `create-pr`.

## 5. The dry run (a human starts it)

`.github/workflows/release.yml` also runs by hand with `dry_run: true`: it builds the
`.dmg` exactly as a release would, runs the verification, and uploads the `.dmg` as a
workflow artifact without creating a release. Run it from `main` after the merge when
anything about the release path changed since the last release (the workflow, signing,
`tauri.conf.json`'s `bundle`, the Tauri version, the secrets), and before the first
release of an app. From the Actions tab, or:

```bash
gh workflow run release.yml -f dry_run=true   # a human's step: it starts a workflow
```

A failure there costs nothing; the same failure after a tag push leaves a tag with no
release.

## 6. The tag (a human pushes it)

On the merge commit on `main`, `git tag v<version>` and `git push origin v<version>`.
The workflow then checks the tag against the three sites, re-runs the core and UI tests,
builds `pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg -- --locked`
without the Rust build cache, verifies, and publishes the `.dmg`, a `SHA256SUMS` file, and a
build-provenance attestation with notes from `.github/release.yml`'s categories. A tag
that fails the version check is deleted and re-pushed by the human after the fix, never
moved silently.

## Signing and notarization

Two paths, chosen by which secrets exist, with no workflow edit
(`docs/distribution.md` › "The two signing paths"):

- **Ad hoc**, the default: `signingIdentity: "-"`, the hardened runtime, and
  `Entitlements.plist`. No Apple Developer Program membership. A downloaded build is
  blocked by Gatekeeper until the user allows it.
- **Developer ID**: when `APPLE_CERTIFICATE` exists, the job imports it into a
  temporary keychain and signs with `APPLE_SIGNING_IDENTITY`; when `APPLE_ID`,
  `APPLE_PASSWORD`, and `APPLE_TEAM_ID` exist too, Tauri notarizes and staples. The
  secrets are `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`, set by a
  human under the repository's Actions secrets. The App Store Connect API key variables
  are an alternative that needs a workflow change.

A step without its secrets is skipped by an `if:` on a step-level check, never by
`continue-on-error`, so a missing secret yields a plainly ad-hoc release rather than a
signing step that failed quietly. Local builds unset every `APPLE_*` variable, so they
are always ad hoc and never contact Apple; a build made on the same Mac is never
quarantined, which is why `just install-app` (a human's recipe) is enough for personal
use.

## Verifying what was built

The workflow fails before upload unless the built app passes: `codesign --verify --deep
--strict`, its entitlements equal `src-tauri/Entitlements.plist`, the bundled helper is
signed and runs, the launch smoke passes on it, and, for Developer ID only, `spctl
--assess` accepts it. An agent's local evidence for all but the last is `just smoke`,
which runs them on a local release `.app` without a window.

A downloaded release is checked with `shasum -a 256 -c SHA256SUMS` and
`gh attestation verify` (`docs/distribution.md` › "Verifying a build"). Opening one is a
human's step, because a quarantined download raises a Gatekeeper prompt: "Opening an
ad-hoc build" there has the Privacy & Security path and the `xattr` alternative.

## After the release

`main` carries the new version and an empty `[Unreleased]`; the next user-visible pull
request starts it again. A problem found after publishing is a new PATCH release, never
an edit to the published one.
