---
paths:
  - "Cargo.toml"
  - "crates/*/Cargo.toml"
  - "xtask/Cargo.toml"
  - "xtask/guard/Cargo.toml"
  - "Cargo.lock"
  - "mise.toml"
  - "rust-toolchain.toml"
  - "deny.toml"
  - "osv-scanner.toml"
  - "clippy.toml"
  - "crates/*/clippy.toml"
  - "rustfmt.toml"
  - "lefthook.yml"
  - "typos.toml"
  - ".github/dependabot.yml"
  - ".github/renovate.json"
---

## Dependency Policy

- Every new crate — runtime or dev, for a shipped crate or for `xtask` — needs a
  written reason and a human's sign-off before it is added (`AGENTS.md` › Security and
  human approval). It also owes an ADR (`recording-architecture-decisions`)
- The pull request records why the dependency passes each of these (the
  `managing-dependencies` skill has the full review record):
  - **Need** — why the standard library, an existing dependency, or a small
    hand-written function cannot do the job
  - **Continuity** — recent releases, and more than one maintainer or an organization
    behind it
  - **License** — in the allow-list `deny.toml`'s `[licenses]` and
    `.github/workflows/dependency-review.yml`'s `allow-licenses` enforce; a per-crate
    exception goes in both, with its reason
  - **Weight** — the crates `cargo tree` adds, and `default-features = false` with only
    the features used
  - **Build-time code** — a crate's `build.rs` or proc-macro runs on the developer's
    machine at build time
  - **Advisories** — `just deny` and OSV-Scanner report nothing against the version
    being added
- A crate's version is written once, in the root `Cargo.toml`'s
  `[workspace.dependencies]`; a member says `name = { workspace = true }`. `myapp-core`
  takes only platform-neutral crates — never an OS binding crate or `myapp-platform`
  (`just deny` and `just check-harness` fail otherwise), and never clap, ratatui, or
  crossterm, which belong to the binary
- ratatui and crossterm are pre-1.0, so their minor versions are breaking: such a bump
  is a migration reviewed on its own pull request (`merging-dependency-prs`), not an
  ADR; replacing clap or ratatui, a clap major, or ratatui 1.0 and its later majors owes
  an ADR
- `Cargo.lock` is committed with the manifest change that moved it, never hand-edited:
  `cargo add`/`cargo update -p <crate>` write it. Verify with `just deny`,
  `mise exec -- cargo shear`, and `just check`

## Tool Pinning

- Rust is pinned once, in `rust-toolchain.toml` (rustup reads it; `mise.toml` lists no
  `rust` tool); every CLI tool in `mise.toml`. Never pin one tool in two places
- Never `latest`, and never a range, in `mise.toml` or `rust-toolchain.toml`: an exact
  version, preferring the prebuilt-binary (aqua/github) backends over `cargo:`, which
  compiles from source
- Pins are bumped by bots, not by hand: Dependabot (`.github/dependabot.yml`) for cargo
  and GitHub Actions, Renovate (`.github/renovate.json`) for `mise.toml` and
  `rust-toolchain.toml`. Each waits 7 days after a release before opening a PR
  (Dependabot's `cooldown`, Renovate's `minimumReleaseAge`), so a compromised fresh
  release has time to be pulled. The two values stay equal (a harness check)
- CI on the bot's PR is the gate; landing those PRs is the `merging-dependency-prs`
  skill. A clippy or Rust toolchain bump that fires a new finding is fixed in the
  code on that PR, never skipped. A major (or a pre-1.0 minor) of a crate the binary is
  built around is a migration, never a batch merge
- After changing `mise.toml`, run `mise install`; after changing `rust-toolchain.toml`,
  the next `cargo` call installs the new toolchain through rustup (`RUSTUP_AUTO_INSTALL`,
  on by default: https://rust-lang.github.io/rustup/environment-variables.html, checked 2026-09-30).
  Then `just check`

## Gates

- These files enforce rather than implement; changing one is the `changing-gates`
  skill. NEVER lower a coverage floor (the `test-core` and
  `test-xtask` recipes), relax a lint level, add to an ignore or exclude list, or loosen
  `deny.toml` or `osv-scanner.toml` without a human's explicit approval
- An `osv-scanner.toml` ignore needs its reason and an `ignoreUntil` at most 90 days
  out, and only for a crate that does not ship (absent from `cargo tree --target` for
  every target `deny.toml`'s `[graph] targets` names) or with no fixed release
