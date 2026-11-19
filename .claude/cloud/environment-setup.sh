#!/bin/bash
# Shared Rust environment for Claude Code cloud sessions. Generic on purpose: it names no
# repository. Anything one repository needs lives in its own .claude/cloud/provision.sh.
set -uo pipefail                      # no -e: a non-zero exit fails the session start
export HOME="${HOME:-/root}"
LOG=/var/log/rust-cloud-setup.log     # the session can `cat` this
exec > >(tee -a "$LOG") 2>&1
warn() { echo "WARN(setup): $*"; }
BUDGET=285                            # seconds; past ~300 the snapshot is not cached

# Bootstrap pins. No repo file to match: this script installs the tools that read the
# repo's pins. Keep MISE_VERSION equal to ci.yml's mise-action `version:` (>= 7 days old).
MISE_VERSION=2026.11.6
MISE_SHA256=5fb74f80aab81e0a5ca20eb6414cc69b78ae0cab1deaeb521572ed26d8d4a6e3   # mise-v2026.11.6-linux-x64, from SHASUMS256.txt
RUSTUP_VERSION=1.29.3
RUSTUP_SHA256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55 # x86_64-unknown-linux-gnu/rustup-init

# The Bash tool is not a login shell; its snapshot sources ~/.bashrc, which returns early
# when PS1 is empty, so the PATH line must be the first line. Shims, not `mise activate`:
# a shim picks the version from the mise.toml of the directory it runs in.
PATH_LINE="export PATH=\"\$HOME/.local/share/mise/shims:\$HOME/.cargo/bin:\$PATH\""
echo "$PATH_LINE" > /etc/profile.d/zz-rust-dev.sh
if ! grep -qF '.local/share/mise/shims' "$HOME/.bashrc" 2>/dev/null; then
  tmp="$(mktemp)"
  { echo "$PATH_LINE"; cat "$HOME/.bashrc" 2>/dev/null; } > "$tmp" && cat "$tmp" > "$HOME/.bashrc"
fi
export PATH="$HOME/.local/share/mise/shims:$HOME/.cargo/bin:$PATH"

install_mise() {   # from the GitHub release: mise.run is not on the Trusted list
  [ "$(mise --version 2>/dev/null | cut -d' ' -f1)" = "$MISE_VERSION" ] && return 0
  local f; f="$(mktemp)"
  curl -fsSL --retry 3 -o "$f" \
    "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64" \
    && echo "${MISE_SHA256}  ${f}" | sha256sum -c --quiet - \
    && install -m 0755 "$f" /usr/local/bin/mise   # /usr/local/bin: on PATH for hooks too
}
install_rustup() { # only when the image's cargo is not rustup-managed (unverified)
  command -v rustup >/dev/null 2>&1 && return 0
  local f; f="$(mktemp)"
  curl -fsSL --retry 3 -o "$f" \
    "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
    && echo "${RUSTUP_SHA256}  ${f}" | sha256sum -c --quiet - \
    && chmod +x "$f" \
    && "$f" -y --no-modify-path --profile minimal --default-toolchain none
}
install_mise & install_rustup & wait
command -v mise   >/dev/null 2>&1 || warn "mise was not installed"
command -v rustup >/dev/null 2>&1 || warn "rustup was not installed; rust-toolchain.toml will be ignored"

# mise-versions.jdx.dev is not on the Trusted list. Delete this block if you add that host.
mkdir -p "$HOME/.config/mise"
cat > "$HOME/.config/mise/config.toml" <<'EOF'
[settings]
use_versions_host = false
EOF

# Each cloned repository that ships a provisioning script provisions itself. The loop is
# sequential: apt and cargo take locks.
for script in */.claude/cloud/provision.sh; do
  [ -f "$script" ] || continue
  repo="${script%%/*}"
  left=$(( BUDGET - SECONDS ))
  if [ "$left" -lt 30 ]; then
    warn "$repo: no time left; its SessionStart hook finishes the job"
    continue
  fi
  echo "== provisioning $repo (${left}s left)"
  ( cd "$repo" && PROVISION_BUDGET_SECONDS="$left" timeout "$left" bash .claude/cloud/provision.sh setup ) \
    || warn "$repo: provision.sh did not finish"
done

echo "== done in ${SECONDS}s: $(mise --version 2>/dev/null | cut -d' ' -f1) / $(rustup --version 2>/dev/null | head -n1)"
exit 0
