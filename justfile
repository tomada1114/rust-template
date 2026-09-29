# Task runner (design D10). Every recipe is a thin call into cargo, pnpm, or scripts/.
# `just --list` shows them all.
#
# Never taking over the developer's Mac (design D22): recipes that open the app (dev, run,
# install-app) and recipes a human starts on purpose (test-local, reset-permissions,
# logs-follow) are never part of `just check`, and an agent runs them only when the human
# asks. Local builds make the app bundle only (`--bundles app`): building a disk image
# drives Finder through AppleScript, so only the release workflow on a CI runner does it.
# Recipes that build unset every APPLE_* variable, so a local build never signs as a
# developer.

set shell := ["bash", "-euo", "pipefail", "-c"]

bundle_id := "com.example.myapp"
app_name := "MyApp"
log_dir := env("HOME", "") / "Library/Logs" / bundle_id
no_signing := "env -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD -u APPLE_SIGNING_IDENTITY -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH"

# List the recipes
default:
    @just --list

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
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack enable pnpm
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
    lefthook install
    node scripts/verify-hooks.ts

# Fail when lefthook's pre-commit hook is not installed (ALLOW_MISSING_GIT_HOOKS=1 opts out)
verify-hooks:
    node scripts/verify-hooks.ts

# Run the app with hot reload (opens a window: a human's recipe, never part of `just check`)
dev: sidecar
    {{ no_signing }} pnpm tauri dev

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
lint: sidecar
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    pnpm typecheck
    pnpm lint
    pnpm format:check

# Every test that runs anywhere: the Rust core and the UI, each with its coverage floors
test: test-core test-ui

# The Rust core with its coverage floors (lines 80, functions 80), its doctests, and the Linux-buildable crates' tests
test-core:
    cargo llvm-cov nextest --locked -p myapp-core --fail-under-lines 80 --fail-under-functions 80
    cargo test --doc --locked -p myapp-core
    cargo nextest run --locked -p myapp-test-support -p myapp-platform -p myapp-cli

# UI tests with the ui/src coverage floors (lines 80, functions 80)
test-ui:
    pnpm test:ui

# One core test or a group of them, fast: `just test-fast increment`
test-fast filter:
    cargo nextest run --locked -p myapp-core {{ filter }}

# Platform and shell tests that need macOS but no human (tauri::test commands, real adapters)
test-macos: sidecar
    cargo nextest run --locked -p myapp-platform -p myapp

# The #[ignore]d tests that need a logged-in Mac, a TCC grant, or the Keychain (a human's recipe)
test-local: sidecar
    cargo nextest run --locked --workspace --run-ignored ignored-only --no-tests=pass

# Regenerate ui/src/ipc/generated/ from core's ts-rs types (commit the result; CI fails on drift)
bindings:
    rm -rf ui/src/ipc/generated
    cargo test --locked -p myapp-core --lib export_bindings --quiet

# Build the myapp-cli helper into src-tauri/binaries/ (Tauri's externalBin needs it before the Tauri crate compiles)
sidecar *args:
    node scripts/build-sidecar.ts {{ args }}

# Build the debug app bundle (target/debug/bundle/macos/); no disk image
build: sidecar
    {{ no_signing }} pnpm tauri build --debug --bundles app

# Build, quit any running copy, and open the debug app (shows a window: a human's recipe)
run: build
    -pkill -x myapp
    open "target/debug/bundle/macos/{{ app_name }}.app"

# The launch smoke: release bundle, signature, entitlements, bundled helper, and a windowless smoke-mode run
smoke:
    node scripts/smoke.ts

# Print the end of the newest app log and exit
logs:
    #!/usr/bin/env bash
    set -euo pipefail
    newest="$(ls -t "{{ log_dir }}"/*.log 2>/dev/null | head -n 1 || true)"
    if [[ -z "$newest" ]]; then echo "no log files in {{ log_dir }}"; exit 0; fi
    echo "==> $newest"
    tail -n 50 "$newest"

# Follow the newest app log (never ends: a human's recipe)
logs-follow:
    tail -F "$(ls -t "{{ log_dir }}"/*.log | head -n 1)"

# Reset the app's privacy (TCC) permissions so macOS asks again (a human's recipe)
reset-permissions:
    tccutil reset All {{ bundle_id }}

# Build the release app and copy it to ~/Applications, quitting an older copy first (a human's recipe)
install-app:
    {{ no_signing }} pnpm tauri build --bundles app
    -pkill -x myapp
    mkdir -p "$HOME/Applications"
    rm -rf "$HOME/Applications/{{ app_name }}.app"
    cp -R "target/release/bundle/macos/{{ app_name }}.app" "$HOME/Applications/"

# Supply-chain checks for crates: advisories, licences, bans, sources
deny:
    cargo deny check

# Remove build output
clean:
    cargo clean
    rm -rf dist coverage src-tauri/binaries

# Repository script tests with the scripts/** coverage floors (85/90; scripts/lib/guard/** 90/100)
test-scripts:
    pnpm test:scripts

# Create or update the repository's labels from .github/labels.yml (a GitHub write: a human's step)
labels:
    node scripts/sync-labels.ts

# Create or update the "main" branch ruleset from .github/rulesets/main.json (repository admin; a human's step)
ruleset:
    node scripts/apply-ruleset.ts

# Bump the three version sites, refresh Cargo.lock, and roll CHANGELOG.md: `just release-prep 0.2.0`
release-prep version *flags:
    node scripts/release-prep.ts {{ flags }} {{ version }}
