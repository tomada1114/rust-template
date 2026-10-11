#!/usr/bin/env bash
# preflight.sh — Verify the local repo is in a state where issues can be shipped,
# and report the repo's profile so the calling model doesn't have to re-derive it
# with ad-hoc probes on every run.
#
# Usage: preflight.sh [--with-github] [--profile-cache <path>]
#                      [--set-worktree-viable <yes|no>]
#
# Prints a compact key: value report and exits non-zero if a hard blocker
# is present. Soft warnings are reported but do not fail.
#
# By default this checks only the local git state plus cheap, local repo-profile
# facts (package managers, verify command, hooks). It makes no GitHub or network
# calls at all — that is a deliberate property of this script, so --with-github
# is how a caller opts into the (slower, network-dependent) GitHub checks. Later
# steps that actually need GitHub still surface a problem on their own if the
# caller skips --with-github.
#
# --profile-cache lets the caller avoid recomputing verify_command/hooks/etc on
# every invocation across a single shipping-issues run: those facts are constant
# for a repo as long as its lockfile (Cargo.lock) and build-config files
# (justfile, Makefile, Cargo.toml, rust-toolchain.toml, mise.toml,
# lefthook.yml) haven't changed, so a matching lockfile
# hash + config hash is treated as a cache hit. worktree_viable is never
# detected here (git-worktree viability requires actually running a baseline
# verify command, which is worktree_setup.sh's job, not preflight's) — it is
# only ever set via --set-worktree-viable, once the caller has paid for that
# probe, so future preflight calls can read it back for free. A cache miss
# keeps a recorded `yes` and resets a recorded `no` to `unknown`.
#
# Exit codes:
#   0 = ready
#   1 = hard blocker (not a repo, no origin, or a Claude Code cloud session:
#       CLAUDE_CODE_REMOTE=true prints `host: cloud` and a `next:` line naming
#       the cloud skill, and stops before any git or gh call)
#   2 = usage error

set -uo pipefail

fail=0
warn=0

emit() { printf '%s: %s\n' "$1" "$2"; }

# --- hashing helper ----------------------------------------------------------
# Prefer shasum (macOS default), fall back to sha256sum (Linux default). If
# neither exists, HASHER stays empty and every hash_* call reports "" — callers
# turn that into the documented "none" value rather than failing the script.
HASHER=""
if command -v shasum >/dev/null 2>&1; then
  HASHER="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  HASHER="sha256sum"
fi

hash_file12() {
  [[ -n "$HASHER" && -f "$1" ]] || { printf '%s' ""; return; }
  $HASHER "$1" 2>/dev/null | awk '{print substr($1,1,12)}'
}

hash_str12() {
  [[ -n "$HASHER" ]] || { printf '%s' ""; return; }
  printf '%s' "$1" | $HASHER | awk '{print substr($1,1,12)}'
}

# --- python helpers ----------------------------------------------------------
# The Python helpers live in functions rather than inline in "$(…)": bash 3.2
# (macOS's /bin/bash) misparses a here-document inside a command substitution
# whose body holds a backtick or quote.

# Prints HIT or MISS, then key<TAB>value lines, for the cached repo profile.
read_profile_cache() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json
import sys

path, lockfile_hash, meta_hash, logic_version = sys.argv[1:5]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    print("MISS")
    sys.exit(0)

if not isinstance(data, dict):
    print("MISS")
    sys.exit(0)

if (data.get("lockfile_hash") != lockfile_hash
        or data.get("meta_hash") != meta_hash
        or str(data.get("logic_version")) != logic_version):
    # A miss invalidates what was *derived* from the repo's config files, not
    # what was *measured* by running a gate in a real worktree. Hand a stale
    # `yes` back so the caller can carry it forward; everything else gets
    # recomputed. A stale `no` is dropped (the caller falls back to
    # `unknown`): the changed lockfile, config, or provisioning logic may be
    # what fixes it, and a carried `no` keeps every later run serial, so the
    # repo would never be probed again.
    print("MISS")
    if data.get("worktree_viable") == "yes":
        print("worktree_viable\tyes")
    sys.exit(0)

print("HIT")
for key in ("verify_command", "verify_source", "hooks", "pkg_manager", "worktree_viable"):
    print(f"{key}\t{data.get(key, '')}")
PY
}

# --- args --------------------------------------------------------------------
WITH_GITHUB=0
PROFILE_CACHE=""
SET_WORKTREE_VIABLE=""

usage() {
  echo "Usage: preflight.sh [--with-github] [--profile-cache <path>] [--set-worktree-viable <yes|no>]" >&2
}

# print_help — the script's own usage, derived straight from this header
# comment so the text lives in exactly one place (kept separate from usage()
# above, which is the short one-liner already used on stderr for arg errors).
print_help() {
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) print_help; exit 0 ;;
    --with-github) WITH_GITHUB=1; shift ;;
    --profile-cache)
      [[ $# -ge 2 ]] || { echo "--profile-cache needs a value" >&2; exit 2; }
      PROFILE_CACHE="$2"; shift 2 ;;
    --set-worktree-viable)
      [[ $# -ge 2 ]] || { echo "--set-worktree-viable needs a value" >&2; exit 2; }
      SET_WORKTREE_VIABLE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

# --- host ------------------------------------------------------------------
# A Claude Code cloud session sets CLAUDE_CODE_REMOTE=true (never true locally).
# This workflow cannot run there — the GitHub proxy refuses `gh`'s GraphQL — so
# stop before any git or gh call and name the skill that can. Only the exact
# value `true` counts; anything else is a local host.
if [[ "${CLAUDE_CODE_REMOTE:-}" == "true" ]]; then
  emit host "cloud"
  emit next "in a Claude Code cloud session use the cloud-claude-shipping-issues skill"
  echo "verdict: BLOCKED"
  exit 1
fi

# --set-worktree-viable is a standalone cache-write operation: it doesn't need
# a git repo at all, so it's handled and exited before any git check runs.
if [[ -n "$SET_WORKTREE_VIABLE" ]]; then
  if [[ -z "$PROFILE_CACHE" ]]; then
    echo "--set-worktree-viable requires --profile-cache" >&2
    usage
    exit 2
  fi
  if [[ "$SET_WORKTREE_VIABLE" != "yes" && "$SET_WORKTREE_VIABLE" != "no" ]]; then
    echo "--set-worktree-viable requires yes or no" >&2
    usage
    exit 2
  fi
  mkdir -p "$(dirname "$PROFILE_CACHE")"
  python3 - "$PROFILE_CACHE" "$SET_WORKTREE_VIABLE" <<'PY'
import json
import sys

path, value = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
data["worktree_viable"] = value
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY
  emit worktree_viable "$SET_WORKTREE_VIABLE"
  echo "verdict: READY"
  exit 0
fi

# --- git repo ------------------------------------------------------------
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  emit git_repo "NOT_A_REPO"
  echo "verdict: BLOCKED"
  exit 1
fi
emit git_repo "ok"
repo_root="$(git rev-parse --show-toplevel)"
emit repo_root "$repo_root"
git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
emit git_common_dir "$git_common_dir"

# --- worktree state ----------------------------------------------------------
# Neither of these is a blocker or a warning on its own — they only inform the
# caller whether parallel-worktree mode is already in play.
git_dir=$(git rev-parse --path-format=absolute --git-dir)
if [[ "$git_dir" != "$git_common_dir" ]]; then
  emit in_worktree "yes"
else
  emit in_worktree "no"
fi

worktree_list="$(git worktree list 2>/dev/null)"
worktree_count=$(printf '%s\n' "$worktree_list" | sed -n '2,$p' | grep -c . || true)
if [[ "$worktree_count" -gt 0 ]]; then
  emit existing_worktrees "$worktree_count"
  printf '%s\n' "$worktree_list" | sed -n '2,$p' | sed 's/^/  /'
fi

if ! origin_url="$(git remote get-url origin 2>/dev/null)"; then
  emit origin "MISSING"
  fail=1
  origin_url=""
else
  emit origin "$origin_url"
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
emit current_branch "$current_branch"

dirty="$(git status --porcelain 2>/dev/null | head -20)"
if [[ -n "$dirty" ]]; then
  emit working_tree "DIRTY"
  emit dirty_files "$(git status --porcelain | wc -l | tr -d ' ')"
  printf '%s\n' "$dirty" | sed 's/^/  /'
  warn=1
else
  emit working_tree "clean"
fi

# --- repo profile: always emitted, cheap, local ------------------------------

# repo_slug — parsed from the origin URL. Handles git's scp-style
# [user@]host:[/]owner/repo (a bare ssh host alias included) and the network
# schemes https, http, ssh, git, git+ssh, ssh+git as
# scheme://[user@]host[:port]/owner/repo, each with an optional ".git" and
# trailing "/". Any other scheme (file:// included) is UNKNOWN. Anything that doesn't reduce to exactly "owner/repo" is reported as
# UNKNOWN rather than guessed at. issue_digest.py's parse_repo_slug() is the
# Python twin of this block; tests/test_runstate_parity.py holds them equal.
repo_slug="UNKNOWN"
if [[ -n "$origin_url" ]]; then
  slug="$origin_url"
  while [[ "$slug" == */ ]]; do slug="${slug%/}"; done
  slug="${slug%.git}"
  case "$slug" in
    https://*|http://*|ssh://*|git://*|git+ssh://*|ssh+git://*)
      slug="${slug#*://}"; slug="${slug#*/}" ;;
    *://*) slug="" ;;
    *:*)
      if [[ "${slug%%:*}" == */* ]]; then
        slug=""
      else
        slug="${slug#*:}"; slug="${slug#/}"
      fi ;;
    *) slug="" ;;
  esac
  if [[ "$slug" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
    repo_slug="$slug"
  fi
fi
emit repo_slug "$repo_slug"

# default_branch — origin/HEAD is only set by `git clone`, not by `git remote
# add` + fetch, so plenty of real repos lack it (see cleanup_run.sh for the
# same gap). Fall back to origin/main, then origin/master, then whatever
# branch we're actually on — this must never fail preflight.
default_branch="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
if [[ -z "$default_branch" ]]; then
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    default_branch="main"
  elif git show-ref --verify --quiet refs/remotes/origin/master; then
    default_branch="master"
  else
    default_branch="$current_branch"
  fi
fi
emit default_branch "$default_branch"

# runstate — where a caller may persist per-repo state (e.g. the profile
# cache) across runs. Only the path is reported; the directory is deliberately
# NOT created here, since not every caller needs it.
if [[ "$repo_slug" == "UNKNOWN" ]]; then
  runstate_leaf="UNKNOWN"
else
  runstate_leaf="${repo_slug%/*}__${repo_slug#*/}"
fi
# A leading "~" or "~/" is expanded, matching run_record.py and issue_digest.py
# for those forms, so a quoted AGENT_SKILL_STATE_DIR=~/x lands in one place.
# Python's expanduser() also expands "~user"; this block does not.
state_root="${AGENT_SKILL_STATE_DIR:-$HOME/.local/state/agent-skills}"
case "$state_root" in
  "~") state_root="$HOME" ;;
  \~/*) state_root="$HOME/${state_root#\~/}" ;;
esac
state_root="${state_root%/}"
runstate="$state_root/shipping-issues/$runstate_leaf"
emit runstate "$runstate"

# This repository is a Cargo workspace: Cargo.lock at the root selects cargo.
# There is nothing to install per worktree — cargo builds on demand.
pkg_manager="none"
lockfile="none"
if [[ -f "$repo_root/Cargo.lock" ]]; then
  pkg_manager=cargo
  lockfile="Cargo.lock"
fi
emit pkg_manager "$pkg_manager"
emit lockfile "$lockfile"

lockfile_hash="none"
if [[ "$lockfile" != "none" ]]; then
  h="$(hash_file12 "$repo_root/$lockfile")"
  [[ -n "$h" ]] && lockfile_hash="$h"
fi
emit lockfile_hash "$lockfile_hash"

# hooks — checked in this order: a lefthook config (this repository's hook
# manager; `just install` runs `lefthook install`) always wins, even over a
# native hook that also happens to be installed; then a lefthook-generated hook
# in the shared hooks directory; then "some other native hook is installed";
# then none.
hooks="none"
if [[ -f "$repo_root/lefthook.yml" || -f "$repo_root/lefthook.yaml" || -f "$repo_root/.lefthook.yml" ]]; then
  hooks="lefthook"
elif [[ -d "$git_common_dir/hooks" ]] && grep -ril "lefthook" "$git_common_dir/hooks" 2>/dev/null | grep -v '\.sample$' | grep -q .; then
  hooks="lefthook"
elif [[ -d "$git_common_dir/hooks" ]] && find "$git_common_dir/hooks" -maxdepth 1 -type f ! -name '*.sample' 2>/dev/null | grep -q .; then
  hooks="native"
fi
# Not emitted here — emitted once below, after the profile-cache block has had
# a chance to override it on a cache hit.

# verify_command — first match wins, in this order: justfile recipe
# (verify, check, test), Makefile target, then Cargo.lock's `cargo test`. In
# this repository that is `just check`, the full local gate — it runs `fmt`
# first, so it can rewrite files. shipping-issues reports it but never runs it
# as a baseline: CI is the gate, and implementers run the narrowest check that
# can fail. Independent of pkg_manager/lockfile detection above: a recipe can
# wrap a different toolchain than the lockfile suggests, so this chain is
# checked fresh rather than branching on pkg_manager.
VERIFY_COMMAND=""
VERIFY_SOURCE=""

for jfile in "$repo_root/justfile" "$repo_root/.justfile"; do
  [[ -f "$jfile" ]] || continue
  for recipe in verify check test; do
    if grep -qE "^${recipe}([[:space:]].*)?:" "$jfile"; then
      VERIFY_COMMAND="just $recipe"
      VERIFY_SOURCE="justfile:$recipe"
      break 2
    fi
  done
done

if [[ -z "$VERIFY_COMMAND" ]]; then
  for mkfile in "$repo_root/Makefile" "$repo_root/makefile" "$repo_root/GNUmakefile"; do
    [[ -f "$mkfile" ]] || continue
    for target in verify check test; do
      if grep -qE "^${target}:" "$mkfile"; then
        VERIFY_COMMAND="make $target"
        VERIFY_SOURCE="Makefile:$target"
        break 2
      fi
    done
  done
fi

if [[ -z "$VERIFY_COMMAND" && -f "$repo_root/Cargo.lock" ]]; then
  VERIFY_COMMAND="cargo test"; VERIFY_SOURCE="Cargo.lock"
fi

VERIFY_COMMAND="${VERIFY_COMMAND:-NONE}"
VERIFY_SOURCE="${VERIFY_SOURCE:-none}"

# --- profile cache (only touched with --profile-cache) -----------------------
# `unknown` only until an existing cache is read. A recorded `yes` deliberately
# SURVIVES a cache miss: it is a property of the repository and its tooling —
# whether a fresh worktree can run the gate at all — not of the lockfile or the
# config file that invalidated the rest of the profile. Resetting it on every
# lockfile bump would throw away the one fact that cost a whole worktree install
# to learn, and the caller reads a fresh baseline before trusting a stale `yes`.
# A recorded `no` does not survive a miss: it goes back to `unknown`, so the
# next run re-probes instead of staying serial forever after the change that
# may have fixed it. On a hit (the profile it was recorded for) `no` stands.
worktree_viable="unknown"
if [[ -n "$PROFILE_CACHE" ]]; then
  # meta_hash covers the small set of build-config files that can change
  # verify_command/hooks without touching Cargo.lock (e.g. adding a recipe to
  # the justfile), plus the workspace manifest, the toolchain pins
  # (rust-toolchain.toml, mise.toml), and lefthook.yml (the hook manager).
  meta_concat=""
  for f in Makefile makefile GNUmakefile justfile .justfile Cargo.toml \
    rust-toolchain.toml mise.toml lefthook.yml; do
    if [[ -f "$repo_root/$f" ]]; then
      meta_concat+="$f:$(hash_file12 "$repo_root/$f");"
    fi
  done
  meta_hash="$(hash_str12 "$meta_concat")"
  [[ -z "$meta_hash" ]] && meta_hash="none"
  # The repo's own files are only half of what the answer depends on: the
  # other half is this script's detection rules. Changing the verify_command
  # search order without bumping this leaves every existing cache serving the
  # answer the old rules gave — a stale verify_command is a weaker baseline
  # gate that nothing else in the run would notice. Bump on ANY change to how
  # verify_command, verify_source, hooks or pkg_manager are derived.
  profile_logic_version="6"

  cache_hit=0
  if [[ -f "$PROFILE_CACHE" ]]; then
    cache_read="$(read_profile_cache "$PROFILE_CACHE" "$lockfile_hash" "$meta_hash" "$profile_logic_version")"
    if [[ "$(printf '%s\n' "$cache_read" | head -1)" == "HIT" ]]; then
      cache_hit=1
    fi
    if [[ -n "$cache_read" ]]; then
      while IFS=$'\t' read -r k v; do
        case "$k" in
          verify_command)  VERIFY_COMMAND="$v" ;;
          verify_source)   VERIFY_SOURCE="$v" ;;
          hooks)           hooks="$v" ;;
          pkg_manager)     pkg_manager="$v" ;;
          worktree_viable) [[ -n "$v" ]] && worktree_viable="$v" ;;
        esac
      done < <(printf '%s\n' "$cache_read" | tail -n +2)
    fi
  fi

  if [[ $cache_hit -eq 1 ]]; then
    emit profile_cache "HIT"
  else
    mkdir -p "$(dirname "$PROFILE_CACHE")"
    python3 - "$PROFILE_CACHE" "$lockfile_hash" "$meta_hash" "$VERIFY_COMMAND" "$VERIFY_SOURCE" "$hooks" "$pkg_manager" "$worktree_viable" "$profile_logic_version" <<'PY'
import json
import sys

(path, lockfile_hash, meta_hash, verify_command, verify_source,
 hooks, pkg_manager, worktree_viable, logic_version) = sys.argv[1:10]

data = {
    "lockfile_hash": lockfile_hash,
    "meta_hash": meta_hash,
    "verify_command": verify_command,
    "verify_source": verify_source,
    "hooks": hooks,
    "pkg_manager": pkg_manager,
    "worktree_viable": worktree_viable,
    "logic_version": logic_version,
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY
    emit profile_cache "WRITTEN"
  fi
fi

emit verify_command "$VERIFY_COMMAND"
emit verify_source "$VERIFY_SOURCE"
emit hooks "$hooks"
[[ -n "$PROFILE_CACHE" ]] && emit worktree_viable "$worktree_viable"

# --- github (only with --with-github) -----------------------------------
if [[ $WITH_GITHUB -eq 1 ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    emit gh_auth "GH_MISSING"
    emit gh_write "unknown"
  else
    if gh auth status >/dev/null 2>&1; then
      emit gh_auth "ok"
    else
      emit gh_auth "NOT_LOGGED_IN"
      warn=1
    fi
    perm="$(gh repo view --json viewerPermission -q .viewerPermission 2>/dev/null)"
    case "$perm" in
      ADMIN|MAINTAIN|WRITE) emit gh_write "yes" ;;
      READ|TRIAGE)          emit gh_write "no"; warn=1 ;;
      *)                    emit gh_write "unknown" ;;
    esac
  fi
fi

if [[ $fail -ne 0 ]]; then
  echo "verdict: BLOCKED"
  exit 1
fi
[[ $warn -ne 0 ]] && echo "verdict: READY_WITH_WARNINGS" || echo "verdict: READY"
exit 0
