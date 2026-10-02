# Task runner. Every recipe is a thin call into cargo (`cargo xtask` included) or a pinned tool.
# `just --list` shows them all.
#
# Never taking over the developer's Mac: recipes a human starts on purpose (test-local,
# logs-follow, install-cli) are never part of `just check`, and an agent runs them only
# when the human asks.

set shell := ["bash", "-euo", "pipefail", "-c"]

bundle_id := "com.example.myapp"
log_prefix := "myapp"
# Must match myapp-platform's paths.rs: ~/Library/Logs/<bundle_id> on macOS, and on Linux
# $XDG_STATE_HOME/myapp/logs, an unset, empty, or relative XDG_STATE_HOME meaning ~/.local/state.
xdg_state_home := env("XDG_STATE_HOME", "")
log_dir := if os() == "macos" { env("HOME", "") / "Library/Logs" / bundle_id } else if xdg_state_home =~ '^/' { xdg_state_home / "myapp/logs" } else { env("HOME", "") / ".local/state/myapp/logs" }

# List the recipes
default:
    @just --list

# Everything a Mac runs without a human, in CI's order (opens no window; see the note above)
check: verify-hooks fmt lint lint-repo agents-check test-scripts check-harness test test-platform

# Repository lints beside the code: spelling everywhere (typos) and the workflow files (actionlint)
lint-repo:
    typos
    actionlint

# Re-assert the harness's claims about itself (xtask/src/check_harness/, one module per claim)
check-harness:
    cargo xtask check-harness

# Install the pinned toolchain and dependencies (no sudo, no installer windows)
install:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ "$(uname -s)" == "Darwin" ]] && ! xcode-select -p >/dev/null 2>&1; then
        echo "ERR_INSTALL_XCODE_CLT: the Xcode Command Line Tools are missing" >&2
        echo "Expected: xcode-select -p to print a developer directory" >&2
        echo "Actual: none installed" >&2
        echo "Next: run \`xcode-select --install\` yourself, then \`just install\` again" >&2
        exit 1
    fi
    mise install
    lefthook install
    cargo xtask verify-hooks

# Fail when lefthook's pre-commit hook is not installed (ALLOW_MISSING_GIT_HOOKS=1 opts out)
verify-hooks:
    cargo xtask verify-hooks

# Format every Rust file
fmt:
    cargo fmt --all

# Apply every automatic fix (rustfmt's; clippy's findings are fixed by hand)
fix:
    cargo fmt --all

# Check formatting and lints
lint:
    cargo fmt --all --check
    cargo xtask clippy-guard cargo clippy --workspace --all-targets --locked -- -D warnings

# Every test that runs anywhere: the Rust core and the xtask crate, each with its coverage floors
test: test-core test-xtask

# The Rust core with its coverage floors (lines 80, functions 80), its doctests, and the Linux-buildable crates' tests
test-core:
    cargo llvm-cov nextest --locked -p myapp-core --fail-under-lines 80 --fail-under-functions 80
    cargo test --doc --locked -p myapp-core
    cargo nextest run --locked -p myapp-test-support -p myapp-platform -p myapp

# The xtask crate with its coverage floors: lines 85, functions 90 over xtask and its guard; the guard's rules alone (xtask/guard/) lines 90, functions 100
test-xtask:
    cargo llvm-cov nextest --locked --no-report -p xtask -p xtask-guard
    cargo llvm-cov report --locked -p xtask -p xtask-guard --fail-under-lines 85 --fail-under-functions 90
    cargo llvm-cov report --locked -p xtask -p xtask-guard --ignore-filename-regex '/xtask/src/' --fail-under-lines 90 --fail-under-functions 100

# One core test or a group of them, fast: `just test-fast increment`
test-fast filter:
    cargo nextest run --locked -p myapp-core {{ filter }}

# Platform adapter and binary tests against the real OS (macOS or Linux), needing no human
test-platform:
    cargo nextest run --locked -p myapp-platform -p myapp

# The #[ignore]d tests that need a logged-in Mac, a TCC grant, or the Keychain (a human's recipe)
test-local:
    cargo nextest run --locked --workspace --run-ignored ignored-only --no-tests=pass

# Install the myapp binary into ~/.cargo/bin from this checkout (writes outside the working tree: a human's recipe)
install-cli:
    cargo install --locked --path crates/myapp

# Print the end of the newest app log and exit
logs:
    #!/usr/bin/env bash
    set -euo pipefail
    newest="$(ls -t "{{ log_dir }}"/{{ log_prefix }}.*.log 2>/dev/null | head -n 1 || true)"
    if [[ -z "$newest" ]]; then echo "no {{ log_prefix }}.*.log files in {{ log_dir }}"; exit 0; fi
    echo "==> $newest"
    tail -n 50 "$newest"

# Follow the newest app log (never ends: a human's recipe)
logs-follow:
    #!/usr/bin/env bash
    set -euo pipefail
    newest="$(ls -t "{{ log_dir }}"/{{ log_prefix }}.*.log 2>/dev/null | head -n 1 || true)"
    if [[ -z "$newest" ]]; then echo "no {{ log_prefix }}.*.log files in {{ log_dir }}"; exit 0; fi
    tail -F "$newest"

# Supply-chain checks for crates: advisories, licences, bans, sources
deny:
    cargo deny --locked check

# Remove build output
clean:
    cargo clean
    rm -rf coverage

# Remove temp dirs a bootstrap check left behind (`verify-bootstrap-*`) and this checkout's idle Claude Code scratchpads: `just prune-temp --dry-run`
prune-temp *args:
    cargo xtask prune-temp {{ args }}

# The skills' bundled scripts: shipping-issues' and merging-dependency-prs' Python suites (no floor), and shellcheck
test-scripts:
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .agents/skills/shipping-issues/scripts/tests -t .agents/skills/shipping-issues/scripts/tests -p 'test_*.py'
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .agents/skills/merging-dependency-prs/scripts/tests -t .agents/skills/merging-dependency-prs/scripts/tests -p 'test_*.py'
    shellcheck .agents/skills/shipping-issues/scripts/*.sh

# Regenerate .claude/skills/ as a byte-for-byte copy of .agents/skills/
agents-sync:
    cargo xtask sync-agents

# Fail when .claude/skills/ differs from .agents/skills/, listing each path (writes nothing)
agents-check:
    cargo xtask sync-agents --check

# Create or update the repository's labels from .github/labels.yml (a GitHub write: a human's step)
labels:
    cargo xtask sync-labels

# Create or update every ruleset in .github/rulesets/ (main, release-tags) by name; never deletes (repository admin; a human's step)
ruleset:
    cargo xtask apply-ruleset

# Turn the template into a new app: rename its placeholders and remove the template-only material (a human's step, run once)
[positional-arguments]
bootstrap *args:
    cargo xtask bootstrap "$@"

# Bootstrap a scratch clone in a temp directory and fail on any placeholder, template-only text, or dangling reference left behind (`--keep` keeps the clone)
verify-bootstrap *args:
    cargo xtask verify-bootstrap {{ args }}
