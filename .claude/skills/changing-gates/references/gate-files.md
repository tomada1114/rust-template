# The gate files, one by one

The detail behind `changing-gates`' "The gate files". Each section says what the file
enforces, the trap met here, and what a change to it owes. Read the file itself for its
current values.

## `Cargo.toml` `[workspace.lints]`

- `[workspace.lints.rust]`: `unsafe_code = "forbid"` and `missing_docs = "warn"`.
  `[workspace.lints.clippy]`: the `all` and `pedantic` groups at warn with
  `priority = -1`, then `unwrap_used` and `expect_used`. The priority puts the groups
  first, so a single lint listed with them can override its group's level
  (https://doc.rust-lang.org/cargo/reference/manifest.html#the-lints-section).
- `just lint` runs clippy with `-D warnings`, so every warning is an error there. The
  level in this table is only what an editor shows.
- A crate receives these lints only through its own `[lints] workspace = true`. A new
  crate without that line compiles with no lint at all, silently: add it in the same
  change that adds the crate.
- Removing a lint or lowering its level is weakening a gate; adding one (a new clippy
  lint at warn) is routine, and fixes what it finds in the same pull request.

## `clippy.toml` and `crates/myapp-core/clippy.toml`

- The root file lets tests `unwrap` and `expect` (a panic is how a Rust test fails).
- Core's file adds the bans that keep I/O, time, the environment, processes, and sleeping
  behind ports (`disallowed-macros`, `disallowed-methods`, `disallowed-types`, each with a
  `reason` clippy prints).
- clippy uses the first `clippy.toml` it finds walking up from the crate's directory and
  merges nothing (https://doc.rust-lang.org/clippy/configuration.html, checked
  2026-09-29), so a crate-local file replaces the root one entirely. That is why core's
  file repeats the two test settings; a new crate-local file must do the same.
- Core also denies `clippy::wildcard_enum_match_arm` in its source, so a `match` on a
  core enum names every variant and a new variant is a compile error wherever a decision
  is owed.
- Core's ban list and `AGENTS.md`'s description of it change together. Adding a ban is
  the routine direction; removing one is weakening a gate.
- A `path` clippy cannot resolve (a typo, an item a Rust release renamed or moved, a
  `std::os::unix` path on another target) is only a configuration warning, which
  `-D warnings` does not turn into an error, so the ban would silently do nothing.
  `just lint` and CI's clippy steps therefore run clippy through
  `cargo xtask clippy-guard`, which fails with `ERR_CLIPPY_BAN_UNRESOLVED` on such a path,
  and with `ERR_CLIPPY_CONFIG_INVALID` on any other diagnostic located in a `clippy.toml`
  (a deprecated key, which clippy also only warns about, or an unknown one). Clippy's
  suggested `allow-invalid = true` hides the warning, which makes it weakening a gate;
  fix the path instead. The `clippy-allow-invalid` harness check
  (`xtask/src/check_harness/clippy_allow_invalid.rs`, run by `just check-harness`)
  fails with `ERR_CHECK_CLIPPY_ALLOW_INVALID` on the key in any `clippy.toml`; an entry
  that genuinely needs it goes in that check's `EXCEPTIONS` with a human's sign-off.
  CI's Linux and macOS jobs both run the guard, so a path must resolve on both.

## `rustfmt.toml`

Stable options only (`edition`, `max_width`), so `cargo fmt` behaves the same on every
toolchain in the pin; an unstable option would need a nightly toolchain the repository
does not pin. Changing an option reformats the whole tree: land the option and the
`just fmt` output in one commit, so the reformat is reviewable as one mechanical diff.

## `deny.toml` and `osv-scanner.toml`

- `[graph] targets = ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]` defines what
  ships: the tool is built for Apple-silicon macOS and for x86-64 Linux. `Cargo.lock`
  lists every platform's dependencies, Windows' included, and carries advisories for code
  neither target builds; the targets select the shipped graph and ignore nothing inside
  it. Adding or dropping a target is a new target platform, an ADR.
- `[licenses] allow` and `.github/workflows/dependency-review.yml`'s `allow-licenses`
  hold one permissive policy, read for different graphs: `cargo deny` reads the crates,
  Dependency Review every ecosystem a pull request's dependency diff shows (crates and
  the actions a workflow uses). The workflow's list is `deny.toml`'s plus six permissive
  licences no crate uses yet (0BSD, BSD-2-Clause, BSD-3-Clause, CC0-1.0, ISC, MIT-0),
  which `cargo deny` would warn about as unused; a crate that needs one of them adds it
  to `deny.toml` in the same pull request. A per-crate exception (`exceptions`,
  `allow-dependencies-licenses`) goes into both files with its reason.
- `[bans] deny` with `wrappers` says which crate may depend on `myapp-platform`
  directly: only `myapp`, the binary. It changes together with `AGENTS.md`'s boundary
  list and the closure check, and `just check-harness` fails when they differ.
- `[sources]` allows crates.io only. A git dependency is a new source: an ADR and a
  sign-off, never a quiet `allow-git` line.
- An advisory is fixed by updating. Only when no fixed release exists may it be
  ignored, with its reason, an `ignoreUntil` (OSV) or dated comment (`deny.toml`) at
  most 90 days out, and a tracking issue. An OSV ignore for a crate absent from
  `cargo tree --target <target>` for both `[graph] targets` needs only the reason and
  the expiry.

## `rust-toolchain.toml` and `mise.toml`

Each tool is pinned exactly once: Rust in `rust-toolchain.toml` (rustup reads it;
`mise.toml` lists no `rust` tool), every CLI tool in `mise.toml`. Never `latest`, never
a range, and prefer the prebuilt-binary backends over `cargo:`, which compiles from
source. Renovate opens the bumps for both after its 7-day minimum release age; its
`enabledManagers` in `.github/renovate.json` are `mise` and `rust-toolchain`, and every
crate and action is Dependabot's (`.github/dependabot.yml`).

A bump of Rust or clippy can fire a finding the old version did not. The fix goes into
the code on that pull request; skipping the bump or suppressing the finding is
weakening a gate. A tool added to `mise.toml` that a CI job needs is added to that job's
`jdx/mise-action` `install_args` too: CI installs only what each job names.

## `lefthook.yml`

- `skip: [merge, rebase]` sits on the two style jobs only, never on the hook: the
  commit that concludes a conflicted merge carries a resolution no hook has seen, so the
  staged guard and the skills mirror run for it, while the style jobs, which CI reruns
  over the whole tree, skip re-linting everything the other side changed. A `reword` or
  a `git commit --amend` at an `edit` stop runs the guard and the mirror too, over what
  is staged against HEAD at that stop. `xtask/tests/lefthook.rs` drives a real
  conflicted merge and a conflicted rebase stop through the real lefthook.
- `parallel: true`: every job is check-only, so none depends on another's output. A
  job that wrote files would break that and would need ordering; that is one more
  reason jobs never write.
- The staged guard has no `glob`: it must see every staged path whatever its extension.
  Adding a glob narrows it without anything reporting the gap.
- `just verify-hooks` (`cargo xtask verify-hooks`) fails at `just install` and
  `just check` time when the hook is not installed; `ALLOW_MISSING_GIT_HOOKS=1` is the
  one opt-out, and CI is skipped. Its tests (`xtask/src/verify_hooks.rs`) pin that
  behaviour.
- The hook's xtask jobs run `cargo xtask`, which builds the xtask crate from the working
  tree: a commit made while `xtask/` does not compile is refused until it does.

## `typos.toml`

An ignore entry takes a path out of the gate for good; the list excludes build output,
the lockfile, and the generated `.claude/skills/` mirror, and `just check-harness` fails
unless it excludes that mirror and not `.agents/skills/`. A real technical term goes
in `[default.extend-words]` with the reason it is spelled that way.

## The harness checks, `xtask/src/check_harness/`

`cargo xtask check-harness` re-asserts what the harness says about itself, one module
per claim, each listed by name in `mod.rs`'s `CHECKS` (`--check <name>` runs one).
They read with real parsers (YAML, TOML, JSON), never a regex over structured text, and
report each violation as an `ERR_CHECK_<WHAT>` with `Expected:`, `Actual:`, and `Next:`
lines. Several keep two lists equal that a human would let drift: the core boundary
(`AGENTS.md`'s sentence, `deny.toml`'s wrappers, the dependency closure), the bots'
cooldowns, the advisory ignores of OSV-Scanner and Dependency Review, the bundle
identifier in `paths.rs` and the justfile, and the ignore lists' treatment of the
skills mirror.

- **Adding a claim** is routine: a new module, its entry in `CHECKS`, tests in the
  module, and, for a check that reads a tree, a fixture root under
  `xtask/tests/fixtures/` per failure mode, so a test points `--root` at it instead of
  at the real checkout. Its row in `AGENTS.md` › "Enforcement layers" changes with it.
- **Removing a check, or narrowing what it reads** (a file it skips, a pattern it no
  longer matches) is weakening a gate.
- **An `EXCEPTIONS` entry** (`just_check_matches_ci.rs`, `workflow_write_scopes.rs`,
  `clippy_allow_invalid.rs`) exempts one named case with its reason in the entry. Each
  is a human's decision; an agent proposes it in the pull request and never adds one to
  get a check green. An entry that no longer applies fails as stale, so the list only
  holds live exceptions.
- `clippy-guard` (`xtask/src/clippy_guard.rs`) wraps every clippy run (the `clippy.toml`
  section above); `just lint` and CI's clippy steps call it with the full
  `cargo clippy … --locked` command, so the workflow check still sees `--locked`.

How a check's code is written, and its coverage floor, is `writing-repo-scripts`.

## The `justfile` recipes that are gates

`test-core` carries the core floor flags, `test-xtask` the xtask floors (lines 85 and
functions 90 over `xtask` and `xtask-guard`, then lines 90 and functions 100 over
`xtask/guard/` alone, from one test run), `lint` runs clippy through `clippy-guard` with
`-D warnings`, and `check` lists the local gate. Recipe names are contract
for `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, the skills, and a committed
`.claude/settings.json` if one is added, all of which `just check-harness` reads.

## `.github/workflows/*.yml`

What every workflow follows, checked by `actionlint`, `zizmor`, and `just check-harness`:

- every remote `uses:` pinned to a full commit SHA with a `# vX.Y.Z` comment;
- a top-level `permissions:` of at most `contents: read`, and each job's own
  least-privilege block; widening one, or adding a workflow that writes, needs sign-off;
- `timeout-minutes` on every job, `persist-credentials: false` on every checkout;
- `concurrency` that cancels a superseded pull-request run but never a push to `main`,
  which is the only CI record a merged commit gets;
- no `pull_request_target` (it runs fork code with a writable token);
- a fail-closed shell (`defaults.run.shell` with `-euo pipefail`), so a failure before
  a `|` or an unset variable stops the step instead of passing it, no `|| true`-style
  fallback or `continue-on-error`, and `--locked` on every cargo command that resolves
  the lockfile, so a lockfile drift fails instead of resolving silently (the same rule
  reads every justfile recipe line);
- no `npm install` in a step: a tool a job needs is pinned in `mise.toml` and named in
  that job's `jdx/mise-action` `install_args`;
- no job whose token holds a write scope checks out or runs repository code
  (`workflow-write-scopes`), apart from its reasoned `EXCEPTIONS`;
- the tool has no release workflow. Adding one is a sign-off change and an ADR
  (distribution), and it would use no Rust build cache, where a poisoned cache would
  reach a shipped binary.

A new workflow file is warranted only by a different trigger or a separate permission
footprint; otherwise the step joins a job in `ci.yml`. A pull request that deletes or
narrows a security-relevant step says why the protection no longer applies.

## `.github/rulesets/main.json` and `release-tags.json`

Each required context is a job `name:` in a `pull_request` workflow that runs on every
pull request, and `just check-harness` fails when one names no job, or only a job whose
workflow filters `paths` or `branches` or whose `if:` (or a `needs` job's) can be false on
a pull request: such a check never reports, or is skipped and passes unrun. Renaming or
splitting a required job, or adding one, edits this file in the same pull request; `just
ruleset` then applies it to the live repository, which is a human's step. A new job is not
required until the owner decides it is: adding one never adds its context here on its own.
`bypass_actors` stays empty: a bypass lets an admin token merge without the checks the
ruleset exists to require. `release-tags.json` is the other way round on purpose: only
a repository admin may create, move, or delete a `v*` tag, so it keeps its admin bypass,
and removing that restriction is weakening a gate.

The check needs the default branch's name only when a required job's `pull_request`
trigger filters branches. It reads it offline from the one literal branch in `ci.yml`'s
`on: push: branches:` (patterns aside), checked against the clone's `origin/HEAD`, or
from `origin/HEAD` alone when `ci.yml` names no single literal branch, so those push
branches are a gate input: renaming the default branch renames it there too.
