---
name: managing-dependencies
description: >
  Covers whether a crate or an npm package may be added to this repository and how it
  is declared: the review record its pull request carries, [workspace.dependencies] as
  the one place a crate version is written, default-features = false and only the
  features used, which crate may depend on what (myapp-core stays platform-neutral),
  cargo deny licences, bans, and sources, pnpm-workspace.yaml's minimumReleaseAge,
  strictDepBuilds and allowBuilds, and trust settings, the typescript ceiling, and a
  Tauri plugin counting as a dependency and a capability. Use when adding, bumping, or
  removing a dependency by hand, editing Cargo.toml's dependencies or package.json,
  enabling a crate feature such as tauri's tray-icon, an install or cargo deny fails on
  a licence, a peer range, a build script, or the cooldown, or someone proposes raising
  typescript or tauri to a new major.
---

# Managing Dependencies

**Owns:** whether a crate or npm package may exist in this repository, how it is
declared, and what happens at build and install time. **Does not own:** landing a
Dependabot or Renovate pull request (`merging-dependency-prs`); the ADR the dependency
owes (`recording-architecture-decisions`); editing `deny.toml`, `osv-scanner.toml`, or
`pnpm-workspace.yaml` as gates (`changing-gates`); wiring a plugin's commands and
capability into the app (`designing-ipc`); tool pins in `mise.toml` and
`rust-toolchain.toml` (`.claude/rules/project.md` › Tool Pinning).

## A dependency is a sign-off change

A new crate or npm package, runtime or dev, direct or a Tauri plugin, needs a written
reason and a human's sign-off before it is added (`AGENTS.md` › "Security and human
approval"), and it owes an ADR. So an agent writes the review record below, proposes
the change, and stops; it runs `cargo` or `pnpm add` only once the owner has agreed.
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
- **Weight.** What it adds: `cargo tree -p <member> -e normal` before and after, or
  `pnpm why <package>`. Declare a crate with `default-features = false` and list only
  the features used: default features are how a small crate brings in a TLS stack or an
  async runtime nobody asked for. `cargo tree -e features` shows what is on.
- **Build-time code.** A crate's `build.rs` or a proc-macro runs on the developer's Mac
  at every build, with their permissions; an npm lifecycle script runs at install. Read
  what it does. A new `allowBuilds` entry in `pnpm-workspace.yaml` needs the owner's
  explicit approval (it ships as `{}`: no package may run one today).
- **Advisories.** `just deny` and OSV-Scanner report nothing against the version being
  added.
- **Where it goes.** Which crate or which `package.json` section, and why (below).
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

## Declaring an npm package

- `dependencies` are bundled into the UI that ships; `devDependencies` are tools and
  tests. The pnpm project publishes nothing, so it declares no `peerDependencies`.
- Add or bump with `pnpm add <package>` (or `pnpm add -D`), never by typing a version into
  `package.json`, and commit `pnpm-lock.yaml` with it; the lockfile is regenerated
  (`pnpm install --lockfile-only` when only it should change), never hand-edited. A caret
  or tilde range lets the cooldown resolve to an older, already-cooled release; an exact
  pin on a release younger than the cooldown fails the install outright.
- `pnpm-workspace.yaml` holds the supply-chain settings: `minimumReleaseAge` (a version
  younger than 7 days does not resolve, lockfiled or not), `trustPolicy: no-downgrade`,
  `blockExoticSubdeps`, `strictPeerDependencies`, `strictDepBuilds` with `allowBuilds`,
  and `verifyDepsBeforeRun: error`. Each failing install is the setting working: find
  out why, and never relax one to get past it (`changing-gates`).
- An urgent security fix younger than the cooldown may get one exact
  `package@version` entry in `minimumReleaseAgeExclude`, approved by a human, in a pull
  request that cites the advisory, says why waiting is riskier, and says when the entry
  comes out. Never a wildcard or an unversioned name. `trustPolicyExclude` takes the same
  shape: one exact `package@version`, its reason in a comment, and a human's approval.
- A peer or resolution failure is not answered with `peerDependencyRules` or
  `overrides` to quiet it. If one is genuinely needed, name the single `parent>child`
  edge, say why the package works against the version it did not declare, and say what
  lets the entry be dropped; it is a sign-off change like a new dependency.
- TypeScript is held below the version `typescript-eslint` supports, and
  `strictPeerDependencies` makes a bump past it fail the install. Read the real ceiling
  before proposing a TypeScript change:
  `node -p "require('typescript-eslint/package.json').peerDependencies.typescript"`.
  Raising it is a coordinated upgrade, never a routine bump.

## Tauri moves as one

The `tauri` crates and the `@tauri-apps/*` npm packages stay on the same minor (a harness
check under `just check-harness` fails on a mismatch), so the JavaScript API the UI calls
and the Rust runtime that answers it come from one release line. A Tauri major is a
migration issue and an ADR, never a batch merge.

A Tauri plugin is a dependency and a capability at once: its `tauri-plugin-*` crate in
`myapp`, usually its `@tauri-apps/plugin-*` package imported only from `ui/src/ipc/`, a
permission in `src-tauri/capabilities/` (a sign-off change), the `deny.toml` wrapper
entry, and an ADR. A crate feature of `tauri` itself (such as `tray-icon` for a
menu-bar agent) is declared in `src-tauri/Cargo.toml`'s `features` list, reviewed for
the crates it adds.

## Removing one

`mise exec -- cargo shear` reports a crate no member uses (CI runs it); remove it from
the member and, if nothing else uses it, from `[workspace.dependencies]`. `pnpm remove
<package>` for npm. Removing is routine and needs no sign-off.

## Verifying the change

```bash
just deny                   # advisories, licences, bans, sources
mise exec -- cargo shear    # no unused crate
just lint
just test
just check                  # the macOS build and the launch smoke, for a crate the shell uses
```

CI adds Dependency Review and OSV-Scanner on the pull request. **REQUIRED:**
`merging-dependency-prs` for landing a bot's bump against these rules.
