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

## Before it runs

`just install` first: the script imports its TOML and YAML parsers from `node_modules`
and fails with `ERR_BOOTSTRAP_NO_DEPS` without them, and it formats with Prettier from
there too. In a git work tree it refuses uncommitted or untracked changes
(`ERR_BOOTSTRAP_DIRTY`), so the rewrite is the only change to review; outside one it
still runs, without that check and without the closing scan for placeholders outside
the site list.

## What it asks for

Each value comes from its flag, else from a prompt on a terminal, else from its default:

| Value | Flag | Template placeholder | Where it shows up |
|---|---|---|---|
| Display name | `--name` | `MyApp` | `productName` and the window title in `tauri.conf.json`, the `.app` bundle name, README's title |
| Slug | `--slug` | `myapp` | crate names (`myapp-core`), Rust identifiers (`myapp_core`), the environment variable prefix (`MYAPP_SMOKE`), binary and log file names |
| Bundle identifier | `--bundle-id` | `com.example.myapp` | `identifier` in `tauri.conf.json`, `BUNDLE_IDENTIFIER` in `crates/myapp-platform/src/paths.rs`, `bundle_id` in the `justfile`, the data and log directories |
| GitHub `owner/repo` | `--repo` | this template's repository | the README badges, `SECURITY.md`'s advisory link, the attestation example in `docs/distribution.md` |
| Author | `--author` | the template's author | the metadata sites on the script's list |
| Copyright holder | `--copyright` | the template's owner | `LICENSE` |

A flag takes its value as the next argument or after `=` (`--name="Tide Pool"`); quote a
value with spaces, through `just` or `node` alike. `--yes` (`-y`) skips the prompts and
the confirmation, and so does a run whose standard input is not a terminal: then the
slug defaults to one derived from the name (`Tide Pool` becomes `tide-pool`), the
copyright holder to the author, and any other missing value fails with
`ERR_BOOTSTRAP_MISSING_VALUE`. On a terminal it shows every value and asks before it
changes anything. `--help` prints the usage line; an unknown, repeated, or valueless
flag fails with `ERR_BOOTSTRAP_USAGE`.

Every value is trimmed and validated before anything is written, each failure with its
own `ERR_BOOTSTRAP_INVALID_<FIELD>` code:

- **Name**: 1-50 letters, digits, spaces, hyphens, or periods, starting and ending with
  a letter or digit, no double space.
- **Slug**: lower-case letters and digits in words joined by single hyphens, starting
  with a letter, at most 40 characters; not a Rust keyword, a built-in crate, or a name
  Cargo reserves, and not a package name a dependency already uses.
- **Bundle identifier**: reverse-DNS, two or more dot-separated parts of letters,
  digits, and hyphens, at most 155 characters; not under `com.apple.`, not ending in
  `.app`.
- **Repository**: `OWNER/REPO` as GitHub spells it, without `.git`.
- **Author and copyright holder**: 1-100 printable characters on one line.
- **Every value**: none may contain the placeholder `myapp` or the template's
  repository name, because the leftover scan looks for them.

The slug is used in three forms: hyphenated for crate and directory names, underscored
where Rust needs an identifier (a hyphen is not legal in one), and upper-case for
environment variables. A multi-word slug exercises all three, which is why CI tests the
rename with one. Choose the bundle identifier with care: once a build has left the
machine it is fixed, because macOS keys the app's data, logs, and privacy grants by it
(`docs/architecture.md` › "What is contract and what is private").

## What it does

Every edit is computed and checked in memory first, so a drifted site list fails
(`ERR_BOOTSTRAP_SITE_MISSING`) with nothing written. Then:

1. Runs `cargo fetch --locked`, which needs the network once: it downloads the versions
   `Cargo.lock` already pins, and nothing is written if it fails (`ERR_BOOTSTRAP_FETCH`).
2. Writes the planned edits in one pass: the placeholder sites with the values above;
   every `<!-- template-only -->` … `<!-- /template-only -->` block, the `bootstrap`
   recipe, and every passage that names it, removed; the passages outside a block that
   hold only in the template (`TEXT_EDITS`: the Product section's introduction, the
   README's first sentence, the checks' exclusion of `docs/template/`) rewritten; the template-only CI job,
   `Template Bootstrap Smoke`, removed with its required context in
   `.github/rulesets/main.json`, so the app's ruleset waits only for jobs the app runs;
   `CHANGELOG.md` reset to an empty `[Unreleased]` and the version at its three sites to
   `0.1.0`; the author written into `package.json` and the copyright line into
   `LICENSE`.
3. Renames the crate directories under `crates/` to the new slug, and updates
   `Cargo.lock` with `cargo update --workspace --offline`, so no new crate version slips
   into the rename (`ERR_BOOTSTRAP_LOCKFILE`).
4. Formats what it rewrote: `cargo fmt --all`, then Prettier on the rewritten files
   that are neither Markdown nor Rust (`ERR_BOOTSTRAP_FORMAT`).
5. Deletes the template's own material: `docs/template/`, this page in both skill
   trees, `scripts/bootstrap.ts` and `scripts/verify-bootstrap.ts`, and their tests.
6. Scans for a placeholder left outside the site list and warns about it, then prints
   the next steps: fill `AGENTS.md` › Product, fill `docs/architecture/roadmap.md` with
   `steering-the-roadmap`, `just install`, commit and push to `main`, `just labels`, the
   GitHub security settings, and `just ruleset`.

A failure from step 3 on leaves a half-rewritten clone; see "Running it, and running it
again" below.

## How it is proven

- `scripts/verify-bootstrap.ts` bootstraps a temporary copy of the tree and fails on
  any leftover placeholder or template-only marker, text that holds only in the
  template (`ERR_VERIFY_BOOTSTRAP_TEMPLATE_TEXT`), a dangling skill reference, a
  mismatch between the names it produced, or a Product section that filling its four
  bullets does not make pass (`ERR_VERIFY_BOOTSTRAP_PRODUCT_SECTION`).
- CI's `Template Bootstrap Smoke` job (macOS, `timeout-minutes: 60`) runs
  `scripts/verify-bootstrap.ts` first — the bootstrap itself only warns about a
  placeholder outside its site list, so this is the step that fails on one. It then
  bootstraps a fresh `git clone` with a hyphenated multi-word slug, asserts that
  `just check-harness` **fails** with the Product-section code (the check must fire on
  an app nobody has described yet), runs `just test-scripts` on that unfilled app,
  fills in only the Product section's four bullets, and runs `just check` there. It runs on every pull request, so the bootstrap cannot rot unnoticed.
- The generated tree, not this checkout, is what a bootstrap change is tested against.
  Build the temporary copy from the tracked files (`git ls-files`), never the working
  directory, so ignored build output (`target/`, `node_modules/`) cannot change a
  verdict; and a test that survives the bootstrap never asserts a literal that is only
  true before it runs.
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
