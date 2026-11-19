#!/usr/bin/env bash
# PostToolUse hook: format the one .rs file an edit touched (cargo xtask format-edited-file).
# Exit 2 feeds stderr back to Claude; a machine without cargo is a silent skip.
set -uo pipefail
payload="$(cat)"
case "$payload" in *'.rs"'*) ;; *) exit 0 ;; esac
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
export PATH="$HOME/.local/share/mise/shims:$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null 2>&1 || exit 0
run=(cargo xtask format-edited-file)
if command -v mise >/dev/null 2>&1; then run=(mise exec -- "${run[@]}"); fi
printf '%s' "$payload" | CARGO_TARGET_DIR=target/xtask "${run[@]}"
