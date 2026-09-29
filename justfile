# Task runner (design D10). Every recipe is a thin call into cargo, pnpm, or scripts/.
# Run `just --list` for the list. Recipes that open the app (dev, run, install-app) and
# recipes a human starts on purpose (test-local, reset-permissions, logs-follow) are never
# part of `just check` (design D22).

set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments := false

# Build the myapp-cli helper into src-tauri/binaries/ (Tauri's externalBin needs it before the Tauri crate compiles)
sidecar *args:
    node scripts/build-sidecar.ts {{ args }}

# Regenerate ui/src/ipc/generated/ from core's ts-rs types (commit the result; CI fails on drift)
bindings:
    rm -rf ui/src/ipc/generated
    cargo test --locked -p myapp-core --lib export_bindings --quiet
