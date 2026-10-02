---
name: managing-dependencies
description: >
  Covers whether a crate may be added to this repository and how it is declared: the
  review record its pull request carries, [workspace.dependencies] as the one place a
  crate version is written, default features off for a new crate unless needed, and
  only the features used, which crate may depend on what (myapp-core stays
  platform-neutral), cargo deny licences, bans, and sources, the 7-day cooldown applied
  by eye to a crate added by hand, and a Tauri plugin counting as a dependency and a
  capability. Use when adding, bumping, or removing a dependency by hand, editing
  Cargo.toml's dependencies, enabling a crate feature such as tauri's tray-icon, cargo
  deny fails on a licence, a ban, a source, or an advisory, or someone proposes raising
  tauri to a new major.
---

# Managing Dependencies

**Owns:** whether a crate may exist in this repository, how it is declared, and what
happens at build time. **Does not own:** landing a
Dependabot or Renovate pull request (`merging-dependency-prs`); the ADR the dependency
owes (`recording-architecture-decisions`); editing `deny.toml` or `osv-scanner.toml` as
gates (`changing-gates`); tool pins in `mise.toml` and
`rust-toolchain.toml` (`.claude/rules/project.md` › Tool Pinning).

## A dependency is a sign-off change

A new crate, runtime or dev, direct or a Tauri plugin, needs a written
reason and a human's sign-off before it is added (`AGENTS.md` › "Security and human
approval"), and it owes an ADR. So an agent writes the review record below, proposes
the change, and stops; it runs `cargo` only once the owner has agreed.
A declined request ends the change there. Enabling a new feature of an existing crate
is the same kind of change when the feature brings in new crates: `cargo tree` shows
whether it does.

## The review record

The pull request records each item. A missing one means the review has not happened
yet, not that a detail is left for later.

- **Need.** Why the standard library, a dependency already in the tree, or a small
  hand-written function cannot do it. `clap` already parses the helper's arguments; a
  second parser needs a reason beyond taste.
- **Continuity.** Recent releases, and more than one maintainer or an organization
  behind it.
- **Licence.** In the allow-list `deny.toml`'s `[licenses]` and
  `.github/workflows/dependency-review.yml`'s `allow-licenses` enforce. A per-crate
  exception goes into both files, with its reason (`changing-gates`).
- **Weight.** What it adds: `cargo tree -p <member> -e normal` before and after. Declare a new crate with `default-features = false` and list
  only the features used, unless a default feature is needed. The review record says
  which defaults stay on and why. Default features are how a small crate brings in a
  TLS stack or an async runtime nobody asked for; `cargo tree -e features` shows what is
  on. This judges a new declaration. It is not a retrofit: `tauri` and the existing
  entries in `[workspace.dependencies]` keep their defaults.
- **Build-time code.** A crate's `build.rs` or a proc-macro runs on the developer's Mac
  at every build, with their permissions. Read what it does.
- **Advisories.** `just deny` and OSV-Scanner report nothing against the version being
  added.
- **Where it goes.** Which crate, and why (below).
- **Its `rust-version`.** A crate needing a newer Rust than the workspace's
  `rust-version` narrows what the app can build with. `resolver = "3"` prefers releases
  whose `rust-version` fits, falling back when none does
  (https://doc.rust-lang.org/cargo/reference/resolver.html, checked 2026-09-29).

## Where a crate goes

- `myapp-core` takes only platform-neutral crates: never `tauri`, an OS binding crate
  (`objc2*`, `core-foundation*`, `security-framework*`), or `myapp-platform`. Core
  builds and tests on Linux in CI, and the boundary is enforced three times (core's
  manifest, `deny.toml`'s `wrappers`, and the closure check `just check-harness` runs),
  so a crate that pulls a macOS binding into core fails there even when it builds on
  the Mac.
- An OS-facing crate belongs in `myapp-platform`, behind a port
  (`integrating-system-apis`).
- `tauri` and any `tauri-plugin-*` crate are direct dependencies of `myapp` (the shell)
  only. Enforced by: `deny.toml` `[bans]` "wrappers"; a plugin crate is added to that
  rule in the same change.
- A crate only tests use goes under `[dev-dependencies]`, and `myapp-test-support` is
  reached only that way.

## Declaring a crate

- The version is written once, in the root `Cargo.toml`'s `[workspace.dependencies]`,
  with any `default-features = false`. The member says `name = { workspace = true }`
  and may add `features = [...]` of its own. One place to read and review each version,
  and no two members drifting apart.
- A caret requirement (`"4.6"`, `"2"`) is enough: `Cargo.lock` holds the exact version,
  and an `=` pin removes the room a security update needs. `tauri` stays on `"2"` until
  a migration ADR moves it.
- `Cargo.lock` is committed with the manifest change and never hand-edited: cargo
  writes it on the next build, or `cargo update -p <crate>` when only that crate should
  move. A hand edit states a checksum nobody verified.
- Nothing here applies a release-age cooldown to a crate added by hand (Dependabot's
  `cooldown` covers only its own bumps). Apply the 7-day policy by eye: if the newest
  matching release is younger than 7 days, hold an older one with
  `cargo update -p <crate> --precise <version>`, as the bot would.

## Tauri moves as one

The `tauri` crates and the `@tauri-apps/*` npm packages stay on the same minor (a harness
check under `just check-harness` fails on a mismatch), so the JavaScript API the UI calls
and the Rust runtime that answers it come from one release line. A Tauri major is a
migration issue and an ADR, never a batch merge.

A Tauri plugin is a dependency and a capability at once: its `tauri-plugin-*` crate in
`myapp`, usually its `@tauri-apps/plugin-*` package imported only from `ui/src/ipc/`, a
permission in `src-tauri/capabilities/` (a sign-off change), the `deny.toml` wrapper
entry, and an ADR. Its crate and its npm package are locked to the same exact version:
`tauri-plugin-<x>` in `Cargo.lock` equals `@tauri-apps/plugin-<x>` in
`pnpm-lock.yaml`, and `just check-harness` fails with
`ERR_CHECK_TAURI_PLUGIN_VERSIONS_DIVERGED` otherwise. The manifests keep caret
requirements, so `cargo update -p tauri-plugin-<x> --precise <version>`, or a bump of
the npm package, brings them together. A plugin with no JavaScript side has no npm
package to match. A crate feature of `tauri` itself (such as `tray-icon` for a
menu-bar agent) is declared in `src-tauri/Cargo.toml`'s `features` list, reviewed for
the crates it adds.

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
