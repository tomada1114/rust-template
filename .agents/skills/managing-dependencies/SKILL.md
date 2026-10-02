---
name: managing-dependencies
description: >
  Covers whether a crate may be added to this repository and how it is declared: the
  review record its pull request carries, [workspace.dependencies] as the one place a
  crate version is written, default features off for a new crate unless needed, and
  only the features used, which crate may depend on what (myapp-core stays
  platform-neutral, clap and ratatui stay in the myapp binary, xtask's crates never
  ship), cargo deny licences, bans, and sources, Dependency Review's licence list, the
  7-day cooldown applied by eye to a crate added by hand, and removing an unused crate
  with cargo shear. Use when adding, bumping, or removing a dependency by hand, editing
  a Cargo.toml's dependencies or a crate's features, cargo deny fails on a licence, a
  ban, a source, or an advisory, or someone proposes replacing clap or ratatui or moving
  either to a new major.
---

# Managing Dependencies

**Owns:** whether a crate may exist in this repository, how it is declared, and what
happens at build time. **Does not own:** landing a Dependabot or Renovate pull request,
a ratatui minor included (`merging-dependency-prs`); the ADR the dependency owes
(`recording-architecture-decisions`); editing `deny.toml` or `osv-scanner.toml` as gates
(`changing-gates`); tool pins in `mise.toml` and `rust-toolchain.toml`
(`.claude/rules/project.md` › Tool Pinning).

## A dependency is a sign-off change

A new crate, runtime or dev, in any member (`xtask` included), needs a written reason
and a human's sign-off before it is added (`AGENTS.md` › "Security and human
approval"), and it owes an ADR. So an agent writes the review record below, proposes the
change, and stops; it runs `cargo` only once the owner has agreed. A declined request
ends the change there. Enabling a new feature of an existing crate is the same kind of
change when the feature brings in new crates: `cargo tree` shows whether it does.

## The review record

The pull request records each item. A missing one means the review has not happened
yet, not that a detail is left for later.

- **Need.** Why the standard library, a dependency already in the tree, or a small
  hand-written function cannot do it. `clap` already parses the command line; a second
  parser needs a reason beyond taste.
- **Continuity.** Recent releases, and more than one maintainer or an organization
  behind it.
- **Licence.** In the allow-list `deny.toml`'s `[licenses]` and
  `.github/workflows/dependency-review.yml`'s `allow-licenses` enforce (below). A
  per-crate exception goes into both files, with its reason (`changing-gates`).
- **Weight.** What it adds: `cargo tree -p <member> -e normal` before and after. Declare
  a new crate with `default-features = false` and list only the features used, unless a
  default feature is needed. The review record says which defaults stay on and why.
  Default features are how a small crate brings in a TLS stack or an async runtime
  nobody asked for; `cargo tree -e features` shows what is on. This judges a new
  declaration. It is not a retrofit: the entries in `[workspace.dependencies]` that keep
  their defaults today (`serde`, `thiserror`, `tracing`, and others) stay as they are.
- **Build-time code.** A crate's `build.rs` or a proc-macro runs on the developer's
  machine at every build, with their permissions. Read what it does.
- **Advisories.** `just deny` and OSV-Scanner report nothing against the version being
  added.
- **Where it goes.** Which crate, and why (below).
- **Its `rust-version`.** A crate needing a newer Rust than the workspace's
  `rust-version` narrows what the tool can build with. `resolver = "3"` prefers releases
  whose `rust-version` fits, falling back when none does
  (https://doc.rust-lang.org/cargo/reference/resolver.html, checked 2026-09-29).

## The licence lists

`cargo deny` reads `deny.toml`'s `[licenses] allow` against the crates of the shipped
graph (`[graph] targets`: Apple-silicon macOS and x86-64 Linux). Dependency Review reads
`allow-licenses` against what a pull request's dependency diff adds, in every ecosystem
the workflow's comment names: crates, and the actions a workflow uses. The
workflow's list is `deny.toml`'s plus six permissive licences no crate uses today
(0BSD, BSD-2-Clause, BSD-3-Clause, CC0-1.0, ISC, MIT-0); `deny.toml` leaves them out
because `cargo deny` warns about an allowed licence nothing uses. A crate under one of
those six passes Dependency Review and fails `just deny`: add the licence to `deny.toml`
in the same pull request, and say so in the review record. A licence outside both lists
is a gate change for a human, never a quiet addition.

## Where a crate goes

- `myapp-core` takes only platform-neutral crates: never an OS binding crate
  (`objc2*`, `core-foundation*`, `security-framework*`) or `myapp-platform`. Core builds
  and tests on Linux in CI, and the boundary is enforced three times (core's manifest,
  `deny.toml`'s `wrappers`, and the closure check `just check-harness` runs), so a crate
  that pulls a macOS binding into core fails there even when it builds on the Mac.
- An OS-facing crate belongs in `myapp-platform`, behind a port
  (`integrating-system-apis`), gated by `cfg(target_os)` when only one target has it.
- `myapp-platform` is a direct dependency of `myapp` only. Enforced by: `deny.toml`
  `[bans]` "wrappers".
- The binary's frameworks, `clap` and `ratatui`, are dependencies of `myapp` only: core
  hands the binary a view and never parses arguments or draws (`designing-core-logic`).
  No check enforces this; review does. `crossterm` is reached only as
  `ratatui::crossterm` and never declared, so its version is always the one ratatui was
  built against.
- A crate only `xtask` or `xtask-guard` uses (`regex`, `toml`, `yaml-rust2` today) stays
  in their manifests: repository automation never ships in the tool, but it runs on
  every commit and in CI, so it is reviewed like any other.
- A crate only tests use goes under `[dev-dependencies]`, and `myapp-test-support` is
  reached only that way.

## Declaring a crate

- The version is written once, in the root `Cargo.toml`'s `[workspace.dependencies]`,
  with any `default-features = false`. The member says `name = { workspace = true }`
  and may add `features = [...]` of its own. One place to read and review each version,
  and no two members drifting apart. The one exception is a path to a crate of the
  workspace that is not one of the tool's crates under `crates/`: `xtask-guard`'s path
  sits in `xtask/Cargo.toml`, whose comment says why.
- A caret requirement (`"4.6"`, `"1"`) is enough: `Cargo.lock` holds the exact version,
  and an `=` pin removes the room a security update needs. For a crate below `1.0`, the
  caret already stops at the next minor (`"0.30"` admits `0.30.x`, never `0.31`), which
  is what keeps a ratatui migration out of a routine `cargo update`
  (https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html#default-requirements,
  checked 2026-10-02).
- `deny.toml`'s `[sources]` allows crates.io only. A git dependency or another registry
  is a new source: an ADR and a sign-off, never a quiet `allow-git` line
  (`changing-gates`).
- `Cargo.lock` is committed with the manifest change and never hand-edited: cargo
  writes it on the next build, or `cargo update -p <crate>` when only that crate should
  move. A hand edit states a checksum nobody verified.
- Nothing here applies a release-age cooldown to a crate added by hand (Dependabot's
  `cooldown` covers only its own bumps). Apply the 7-day policy by eye: if the newest
  matching release is younger than 7 days, hold an older one with
  `cargo update -p <crate> --precise <version>`, as the bot would.

## The frameworks: clap and ratatui

Replacing `clap` or `ratatui` with another framework, or moving either to a new major
version, is an ADR (`AGENTS.md` › "Before changing the architecture"), never a batch
merge: every subcommand, or every screen, is written against it. `ratatui` is below
`1.0`, so a minor bump of it is a breaking change by semver; it is a migration
`merging-dependency-prs` lands against ratatui's changelog, with the `TestBackend` tests
showing any rendering change, and it owes no ADR. A new feature of either crate is
reviewed for the crates it adds, like any other declaration.

## Removing one

`mise exec -- cargo shear` reports a crate no member uses (CI runs it); remove it from
the member and, if nothing else uses it, from `[workspace.dependencies]`. Removing is
routine and needs no sign-off.

## Verifying the change

```bash
just deny                   # advisories, licences, bans, sources
mise exec -- cargo shear    # no unused crate
just lint
just test
just check                  # the whole local gate, test-platform included
```

CI adds Dependency Review and OSV-Scanner on the pull request. **REQUIRED:**
`merging-dependency-prs` for landing a bot's bump against these rules.
