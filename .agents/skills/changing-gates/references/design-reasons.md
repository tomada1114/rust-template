# Why the gates are shaped this way

The reasons behind the tooling every app starts with. What each gate file holds is
[gate-files.md](gate-files.md); a change that replaces one of these choices rewrites its
paragraph here, in the present tense, rather than leaving the old reason beside the new
one.

## Every tool pinned in exactly one place

A version written twice drifts. Rust is pinned in `rust-toolchain.toml` and every other
CLI in `mise.toml`, preferring prebuilt binaries to the `cargo:` backend, which compiles
from source. Nothing is `latest`; bumps arrive as Renovate or Dependabot pull requests
after a 7-day release age (`.claude/rules/project.md` › "Tool Pinning").

## Just as the one entry point

One command, `just check`, runs locally what CI runs. Just is a task runner rather than
a build system, and each recipe is a thin call into cargo (`cargo xtask` included) or a
pinned tool, so every recipe also works without it (`CONTRIBUTING.md`'s "Without Just").
`cargo xtask` alone is not the entry point because it cannot naturally drive mise, which
provides the pinned tools a recipe calls.

## lefthook, and a hook that only checks

lefthook gives per-language staged-file globs and parallel jobs from one YAML file. Why
the hook only checks, and never compiles, runs tests, or re-stages, is the skill body's
"The pre-commit hook stays check-only and fast". JSON, YAML, and Markdown have no
formatter here: a Prettier check over them left with the Node toolchain, to keep the
toolchain to Rust plus the pinned CLIs.

## The harness checks itself

Documentation that lists what is enforced goes stale, so the claims are checks instead:
`just check-harness` runs one module per claim under `xtask/src/check_harness/`
([gate-files.md](gate-files.md) › "The harness checks").

## Most CI runs on Ubuntu

macOS runners queue longer. Core, the Linux-buildable crates, the platform tests on
Linux, the scripts, and the repository lint all run on Ubuntu; one macOS job runs
workspace clippy and the platform tests against macOS.

## This much supply-chain control, scoped to the built targets

A tool that runs on its user's machine with their permissions deserves the same
scrutiny as a server: CodeQL, OSV-Scanner, OpenSSF Scorecard, zizmor, Dependency Review
with a licence allow-list, `cargo deny`, a 7-day cooldown on every automated bump, a
weekly full-history gitleaks scan, and the branch ruleset as code. `Cargo.lock` lists
every platform's dependencies, Windows-only crates included, so `cargo deny` evaluates
the graphs `deny.toml`'s `[graph] targets` names — defining what is built rather than
ignoring anything. When an advisory may be ignored, and with what, is
[gate-files.md](gate-files.md) › "`deny.toml` and `osv-scanner.toml`".
