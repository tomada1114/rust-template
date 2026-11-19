#!/usr/bin/env bash
# Provisions this checkout on a Claude Code cloud VM (Ubuntu 24.04 x86_64, root).
#   setup    called by the environment's setup script (cached snapshot, time budget)
#   session  called by the SessionStart hook; cloud only, fast when nothing changed
#   warm     background build `session` starts when the build directories are cold
# Always exits 0: a failed step prints WARN(provision) and the session starts anyway.
# Keep this file free of the app's name, so the bootstrap never has to rewrite it.
set -uo pipefail
mode="${1:-session}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 0
cd "$root" || exit 0
failed=0
warn() { printf 'WARN(provision): %s\n' "$*" >&2; failed=1; }

if [ "$mode" != setup ] && [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  # A local session: `just install` is the path. One line of context when the hook is missing.
  hook="$(git rev-parse --git-path hooks 2>/dev/null)/pre-commit"
  grep -q lefthook "$hook" 2>/dev/null \
    || echo "lefthook's pre-commit hook is not installed in this checkout: run \`just install\`."
  exit 0
fi

export PATH="$HOME/.local/share/mise/shims:$HOME/.cargo/bin:$PATH"
budget="${PROVISION_BUDGET_SECONDS:-240}"
left() { local s=$(( budget - SECONDS )); [ "$s" -gt 5 ] && echo "$s" || echo 5; }
stamp=target/.cloud-provision.sha256
inputs=(.claude/cloud/provision.sh .claude/cloud/apt-packages.txt mise.toml mise.lock rust-toolchain.toml Cargo.lock)
current() { sha256sum "${inputs[@]}" 2>/dev/null | sha256sum | cut -d' ' -f1; }

tools() {
  if [ "$(id -u)" = 0 ] && [ -s .claude/cloud/apt-packages.txt ]; then
    local missing=() pkg
    while read -r pkg; do
      case "$pkg" in '' | '#'*) continue ;; esac
      dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
    done < .claude/cloud/apt-packages.txt
    if [ "${#missing[@]}" -gt 0 ]; then
      (apt-get update -qq && DEBIAN_FRONTEND=noninteractive \
        apt-get install -y -qq --no-install-recommends "${missing[@]}") \
        || warn "apt-get could not install: ${missing[*]}"
    fi
  fi
  if command -v mise >/dev/null 2>&1; then
    mise trust mise.toml >/dev/null 2>&1 || warn "mise trust failed"
    if [ -f mise.lock ]; then
      mise install --locked || warn "mise install --locked failed"
    else
      mise install || warn "mise install failed (no mise.lock: it needs a release-metadata host)"
    fi
  else
    warn "mise is missing: the environment's setup script did not run"
  fi
  if command -v rustup >/dev/null 2>&1; then
    # rustup >= 1.28 installs rust-toolchain.toml's toolchain with no argument; older ones on `show`.
    rustup toolchain install >/dev/null 2>&1 || rustup show active-toolchain >/dev/null 2>&1 \
      || warn "the pinned Rust toolchain was not installed"
  else
    warn "rustup is missing: cargo will not follow rust-toolchain.toml"
  fi
  cargo fetch --locked --quiet || warn "cargo fetch --locked failed"
}

warm() {
  # The hooks' own target directory first: the format hook and the commit guard use it.
  CARGO_TARGET_DIR=target/xtask timeout "$(left)" cargo build --locked --quiet -p xtask \
    || warn "the xtask pre-build did not finish"
  timeout "$(left)" cargo build --locked --quiet --workspace --all-targets --all-features \
    || warn "the warm build stopped at its time budget (what it built is kept)"
}

case "$mode" in
  warm) warm; exit 0 ;;
  setup) tools ;;
  *) if [ "$(cat "$stamp" 2>/dev/null)" != "$(current)" ] || ! command -v just >/dev/null 2>&1; then tools; fi ;;
esac

# Every start: a fresh clone has no hook, and a lefthook bump moves the path the hook bakes in.
lefthook install >/dev/null 2>&1 || warn "lefthook install failed: commits here skip the staged guard"
if [ "$failed" = 0 ]; then mkdir -p target && current > "$stamp"; fi

if [ "$mode" = setup ]; then warm; exit 0; fi

# Hooks do not read ~/.bashrc; this file is what later Bash commands evaluate.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"\$HOME/.local/share/mise/shims:\$HOME/.cargo/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
warming="ready"
if [ ! -x target/xtask/debug/xtask ]; then
  log="${TMPDIR:-/tmp}/cloud-provision-warm.log"
  PROVISION_BUDGET_SECONDS=1500 setsid nohup bash "${BASH_SOURCE[0]}" warm >"$log" 2>&1 </dev/null &
  warming="warming in the background (log: $log); the first cargo command may wait on its lock"
fi
missing_tools="$(mise ls --current --missing 2>/dev/null | awk '{print $1}' | paste -sd' ' -)"
# stdout of a SessionStart hook becomes context for Claude.
echo "cloud provision: $(cargo --version 2>/dev/null || echo 'cargo MISSING'); tools missing: ${missing_tools:-none}; build: $warming"
exit 0
