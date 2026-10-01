# Task runner. Every recipe is a thin call into cargo, pnpm, or scripts/.
# `just --list` shows them all.
#
# Never taking over the developer's Mac: recipes a human starts on purpose (test-local,
# logs-follow, install-cli) are never part of `just check`, and an agent runs them only
# when the human asks.

set shell := ["bash", "-euo", "pipefail", "-c"]

bundle_id := "com.example.myapp"
log_dir := env("HOME", "") / "Library/Logs" / bundle_id
log_prefix := "myapp"

# List the recipes
default:
    @just --list

# Everything a Mac runs without a human, in CI's order (opens no window; see the note above)
check: verify-hooks fmt lint lint-repo agents-check test-scripts check-harness test test-macos

# Repository lints beside the code: spelling everywhere (typos) and the workflow files (actionlint)
lint-repo:
    typos
    actionlint

# Re-assert the harness's claims about itself (scripts/checks/, one module per claim)
check-harness:
    node scripts/check-harness.ts

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
    pnpm install --frozen-lockfile
    lefthook install
    node scripts/verify-hooks.ts

# Fail when lefthook's pre-commit hook is not installed (ALLOW_MISSING_GIT_HOOKS=1 opts out)
verify-hooks:
    node scripts/verify-hooks.ts

# Format every Rust and TypeScript file
fmt:
    cargo fmt --all
    pnpm format

# Apply every automatic fix (formatters and lint autofixes)
fix:
    cargo fmt --all
    pnpm exec eslint . --fix
    pnpm format

# Check formatting, lints, and types in both languages
lint:
    cargo fmt --all --check
    node scripts/clippy-guard.ts cargo clippy --workspace --all-targets --locked -- -D warnings
    pnpm typecheck
    pnpm lint
    pnpm format:check

# Every test that runs anywhere: the Rust core with its coverage floors
test: test-core

# The Rust core with its coverage floors (lines 80, functions 80), its doctests, and the Linux-buildable crates' tests
test-core:
    cargo llvm-cov nextest --locked -p myapp-core --fail-under-lines 80 --fail-under-functions 80
    cargo test --doc --locked -p myapp-core
    cargo nextest run --locked -p myapp-test-support -p myapp-platform -p myapp

# One core test or a group of them, fast: `just test-fast increment`
test-fast filter:
    cargo nextest run --locked -p myapp-core {{ filter }}

# Platform adapter and binary tests against the real macOS, needing no human
test-macos:
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

# Remove stale verify-bootstrap-* temp dirs and this checkout's idle Claude Code scratchpads: `just prune-temp --dry-run`
prune-temp *args:
    node scripts/prune-temp.ts {{ args }}

# Repository script tests with the scripts/** coverage floors (85/90; scripts/lib/guard/** 90/100), plus shipping-issues' bundled Python suite and shellcheck
test-scripts:
    pnpm test:scripts
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .agents/skills/shipping-issues/scripts/tests -t .agents/skills/shipping-issues/scripts/tests -p 'test_*.py'
    shellcheck .agents/skills/shipping-issues/scripts/*.sh

# Regenerate .claude/skills/ as a byte-for-byte copy of .agents/skills/
agents-sync:
    node scripts/sync-agents.ts

# Fail when .claude/skills/ differs from .agents/skills/, listing each path (writes nothing)
agents-check:
    node scripts/sync-agents.ts --check

# Create or update the repository's labels from .github/labels.yml (a GitHub write: a human's step)
labels:
    node scripts/sync-labels.ts

# Create or update every ruleset in .github/rulesets/ (main, release-tags) by name; never deletes (repository admin; a human's step)
ruleset:
    node scripts/apply-ruleset.ts

# Turn the template into a new app: rename its placeholders and remove the template-only material (a human's step, run once)
[positional-arguments]
bootstrap *args:
    node scripts/bootstrap.ts "$@"

# Bootstrap a scratch clone in a temp directory and fail on any placeholder, template-only text, or dangling reference left behind (`--keep` keeps the clone)
verify-bootstrap *args:
    node scripts/verify-bootstrap.ts {{ args }}
