# The bootstrap

The detail behind `starting-an-app`'s rename step: what `scripts/bootstrap.ts`
(`just bootstrap`) does, how it is proven, and what to do when a placeholder survives.
In an app cut from the template this page describes a step already taken: the script
removes itself as its last act.

## Why a script, and why an explicit list

Renaming an app by hand misses a site, and a global find-and-replace hits sites it
should not (a word that merely contains the slug, a URL to an upstream project). So the
script rewrites an **explicit list of placeholder sites**, never a global replace: each
site is a known file and a known spelling, and a site the list does not name is left
alone and caught by the leftover check below.

## What it asks for

It prompts for each value, or takes it as a flag for a non-interactive run, which is
how CI's smoke runs it:

| Value | Template placeholder | Where it shows up |
|---|---|---|
| Display name | `MyApp` | `productName` and the window title in `tauri.conf.json`, the `.app` bundle name, README's title |
| Slug | `myapp` | crate names (`myapp-core`), Rust identifiers (`myapp_core`), the environment variable prefix (`MYAPP_SMOKE`), binary and log file names |
| Bundle identifier | `com.example.myapp` | `identifier` in `tauri.conf.json`, `BUNDLE_IDENTIFIER` in `crates/myapp-platform/src/paths.rs`, `bundle_id` in the `justfile`, the data and log directories |
| GitHub `owner/repo` | this template's repository | the README badges, `SECURITY.md`'s advisory link, the attestation example in `docs/distribution.md` |
| Author | the template's author | the metadata sites on the script's list |
| Copyright holder | the template's owner | `LICENSE` |

The slug is used in three forms: hyphenated for crate and directory names, underscored
where Rust needs an identifier (a hyphen is not legal in one), and upper-case for
environment variables. A multi-word slug exercises all three, which is why CI tests the
rename with one. Choose the bundle identifier with care: once a build has left the
machine it is fixed, because macOS keys the app's data, logs, and privacy grants by it
(`docs/architecture.md` › "What is contract and what is private").

## What it does

1. Rewrites the placeholder sites with the values above.
2. Renames the crate directories under `crates/` to the new slug, and updates
   `Cargo.lock` offline, so no network fetch and no new crate version slips into the
   rename.
3. Removes every `<!-- template-only -->` … `<!-- /template-only -->` block, and the
   template's own design notes.
4. Resets `CHANGELOG.md` to a fresh history and the version at its three sites to
   `0.1.0`.
5. Removes the template-only CI job, `Template Bootstrap Smoke`, and its required
   context in `.github/rulesets/main.json`, so the app's ruleset waits only for jobs the
   app runs.
6. Deletes itself.
7. Prints the next steps: fill `AGENTS.md` › Product, fill
   `docs/architecture/roadmap.md` with `steering-the-roadmap`, `just install`,
   `just labels`, `just ruleset`, and the GitHub security settings.

## How it is proven

- `scripts/verify-bootstrap.ts` bootstraps a temporary copy of the tree and fails on
  any leftover placeholder or template-only marker, a dangling skill reference, or a
  mismatch between the names it produced.
- CI's `Template Bootstrap Smoke` job (macOS, `timeout-minutes: 60`) bootstraps a fresh
  `git clone` with a hyphenated multi-word slug, asserts that `just check-harness`
  **fails** with the Product-section code (the check must fire on an app nobody has
  described yet), then writes a stub Product section in that copy and runs `just check`
  there. It runs on every pull request, so the bootstrap cannot rot unnoticed.
- A change to the script, to a placeholder site, or to any file the script rewrites is
  proven by that job and by `just test-scripts`; a new mention of the app's name in a
  file the list does not cover fails the leftover check there.

## Running it, and running it again

Run it once, on a fresh clone of the new repository with a clean work tree, and commit
the result as one commit, so the rename is one reviewable diff. Because it deletes
itself, a second run in the same repository is not possible after it succeeds. If it
stops part-way, the clone is still a git checkout: `git status` shows what it touched,
and the clean retry is a fresh clone. Nothing here promises that a partial run resumes.

## A placeholder survived

A leftover is either a value you skipped at the prompt or a spelling the site list does
not cover (a different case, a joined form). Search the three slug forms and the display
name case-insensitively, fix what you find by hand, and add the site to the script's
list in the template so the next app does not inherit the same miss.
