#!/usr/bin/env bash
# worktree_setup.sh — Turn a bare `git worktree` into a working build
# environment, and report whether the project's own verification command is
# already green there — BEFORE any implementation agent is spawned.
#
# A fresh `git worktree add` gives tracked files only: no .env, no cargo
# target/. This repository is a Cargo workspace, and cargo builds on demand, so
# there is nothing to install: when the new worktree's own tree holds
# Cargo.lock (judged from the worktree, not the main checkout) the script
# reports `deps: none-needed (cargo builds on demand)`. It never copies a
# secret or personal-permission file (.env*, .envrc, *.local,
# settings.local.json) or the main checkout's target/. It checks that the
# shared lefthook pre-commit hook is installed, and (with --verify) runs the
# project's verification command once as a baseline. A red baseline is the
# repository's problem, not the issue's — finding it here costs one command
# instead of a wasted implementation run, so a red baseline is reported as a
# warning, never a script failure — see "This script REPORTS" below.
#
# Usage: worktree_setup.sh --issue <n> --branch <branch> --base <base-ref>
#                          --root <worktrees-root>
#                          [--verify "<command>"] [--log <path>] [--dry-run]
#
#    or: worktree_setup.sh --spec <issue>:<branch> [--spec <issue>:<branch> ...]
#                          --base <base-ref> --root <worktrees-root>
#                          [--verify "<command>"] [--log-dir <dir>]
#                          [--verify-timeout <seconds>] [--dry-run]
#
# --verify-timeout defaults to 2700 seconds (see VERIFY_TIMEOUT below).
#
# --spec provisions several worktrees in ONE invocation, SEQUENTIALLY — never
# in parallel. Two reasons: verify commands in several worktrees contend for
# the same cargo registry cache and CPU cores, so running them concurrently
# just serializes on locks anyway but with none of the clarity; and a verify command that binds a fixed port or writes to one local
# dev database fails in ways that look like the issue's fault when it's really
# two worktrees racing each other, which is worse than a slower, honest run.
#
# This script REPORTS; it does not decide. A red baseline in a fresh worktree
# usually means the repo is not worktree-viable right now — a fresh worktree
# holds tracked files and nothing else: no .env, no
# pre-warmed cache, no locally-running service it depends on — but "usually" is
# not "always", and telling the two apart needs the diff, the log, and the
# repo's own conventions in view. So the baseline is a warning here and the
# caller decides what it means, including whether to tear the worktree down.
# Provision the batch in small groups if that judgement matters: reading
# worktree #1's block before asking for #2 and #3 costs one extra call and
# keeps the decision where it can actually be made.
#
# Two facts worth writing down:
#   * The main checkout's target/ is never copied or shared. Each worktree's
#     cargo build goes into its own target/, and the first build there is
#     cold: clippy, the coverage build, and the test binaries compile the whole
#     workspace from scratch (5.3 GB observed for this workspace with
#     `du -sh target`, 2026-09-29). Sharing one target/ would make worktrees
#     wait on each other's build lock; copying one is that many gigabytes per
#     worktree.
#   * Git hooks live in the main .git and are shared by every worktree, so
#     this script never runs `lefthook install` from a worktree: `just install`
#     in the main checkout installs the shared hook once, and re-running it
#     from a worktree would only rewrite the hook every worktree uses. A
#     missing hook is reported as a warning — install it once with
#     `just install` in the main checkout.
#   * The worktree, and every file this script writes (the baseline log), live OUTSIDE the repo's main checkout, under the
#     caller-supplied --root. This script never creates or modifies
#     anything inside the repo checkout — the skill treats an unexpectedly
#     dirty main checkout as a hard stop condition. This guard is enforced
#     per-spec in batch mode, not just for the first one.
#
# Exit codes:
#   0 = READY or READY_WITH_WARNINGS (batch: every spec READY/READY_WITH_WARNINGS)
#   1 = BLOCKED (see the `verdict:` line for which check failed; batch: any
#       spec BLOCKED)
#   2 = usage error

set -uo pipefail
shopt -s nullglob

emit() { printf '%s: %s\n' "$1" "$2"; }

# --- resolve a path to a canonical absolute form, without requiring the
# path (or any of it) to exist yet. Walks up to the nearest existing
# ancestor, canonicalizes that with `cd && pwd -P` (which resolves symlinks
# and any `..`/`.` components in one shot), then reappends the missing tail.
resolve_path() {
  local p="$1" d b
  if [[ -d "$p" ]]; then
    (cd "$p" && pwd -P)
    return
  fi
  if [[ -e "$p" ]]; then
    printf '%s/%s\n' "$(cd "$(dirname "$p")" && pwd -P)" "$(basename "$p")"
    return
  fi
  d="$(dirname "$p")"
  b="$(basename "$p")"
  if [[ "$d" == "$p" ]]; then
    printf '%s\n' "$p"
  else
    printf '%s/%s\n' "$(resolve_path "$d")" "$b"
  fi
}

# Run a verify command with a hard wall-clock bound. Exits 124 on timeout, the
# same code timeout(1) uses, so callers can tell "never finished" apart from
# "finished red". stdout/stderr go straight through to the caller's redirect.
run_verify_bounded() {
  python3 - "$1" "$2" "$3" <<'PYTIMEOUT'
import os
import signal
import subprocess
import sys

workdir, command, timeout = sys.argv[1], sys.argv[2], float(sys.argv[3])
proc = subprocess.Popen(["bash", "-c", command], cwd=workdir,
                        start_new_session=True)
try:
    sys.exit(proc.wait(timeout=timeout))
except subprocess.TimeoutExpired:
    # The whole process group, not just the shell: a runner that forked workers
    # would otherwise outlive the kill still holding whatever it bound.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(proc.pid), sig)
        except (ProcessLookupError, PermissionError):
            break
        try:
            proc.wait(timeout=5)
            break
        except subprocess.TimeoutExpired:
            continue
    sys.exit(124)
PYTIMEOUT
}

usage() {
  echo "Usage: worktree_setup.sh --issue <n> --branch <branch> --base <base-ref> --root <worktrees-root> [--verify \"<command>\"] [--log <path>] [--dry-run]" >&2
  echo "   or: worktree_setup.sh --spec <issue>:<branch> [--spec ...] --base <base-ref> --root <worktrees-root> [--verify \"<command>\"] [--log-dir <dir>] [--verify-timeout <seconds>] [--dry-run]" >&2
}

# print_help — the script's own usage, derived straight from this header
# comment so the text lives in exactly one place (kept separate from usage()
# above, which is the short one-liner already used on stderr for arg errors).
print_help() {
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
}

# --- args --------------------------------------------------------------
ISSUE="" BRANCH="" BASE="" ROOT="" VERIFY="" LOG="" DRY=0
# 45 minutes: a cold build of the whole Cargo workspace plus the coverage runs.
LOG_DIR="" VERIFY_TIMEOUT="2700"
SPECS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) print_help; exit 0 ;;
    --issue)  [[ $# -ge 2 ]] || { echo "--issue needs a value" >&2; exit 2; }; ISSUE="$2"; shift 2 ;;
    --branch) [[ $# -ge 2 ]] || { echo "--branch needs a value" >&2; exit 2; }; BRANCH="$2"; shift 2 ;;
    --base)   [[ $# -ge 2 ]] || { echo "--base needs a value" >&2; exit 2; }; BASE="$2"; shift 2 ;;
    --root)   [[ $# -ge 2 ]] || { echo "--root needs a value" >&2; exit 2; }; ROOT="$2"; shift 2 ;;
    --verify) [[ $# -ge 2 ]] || { echo "--verify needs a value" >&2; exit 2; }; VERIFY="$2"; shift 2 ;;
    --log)    [[ $# -ge 2 ]] || { echo "--log needs a value" >&2; exit 2; }; LOG="$2"; shift 2 ;;
    --log-dir) [[ $# -ge 2 ]] || { echo "--log-dir needs a value" >&2; exit 2; }; LOG_DIR="$2"; shift 2 ;;
    --verify-timeout) [[ $# -ge 2 ]] || { echo "--verify-timeout needs a value" >&2; exit 2; }; VERIFY_TIMEOUT="$2"; shift 2 ;;
    --spec)   [[ $# -ge 2 ]] || { echo "--spec needs a value" >&2; exit 2; }; SPECS+=("$2"); shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

# --- validation ----------------------------------------------------------
if [[ ${#SPECS[@]} -gt 0 && -n "$ISSUE" ]]; then
  echo "--spec and --issue are mutually exclusive" >&2
  exit 2
fi
if [[ ! "$VERIFY_TIMEOUT" =~ ^[0-9]+$ || "$VERIFY_TIMEOUT" -eq 0 ]]; then
  echo "--verify-timeout requires a positive integer (seconds)" >&2
  exit 2
fi
if [[ ${#SPECS[@]} -gt 0 && -n "$LOG" ]]; then
  echo "--log is single-issue only; use --log-dir with --spec" >&2
  exit 2
fi

if [[ ${#SPECS[@]} -eq 0 ]]; then
  if [[ -z "$ISSUE" || -z "$BRANCH" || -z "$BASE" || -z "$ROOT" ]]; then
    usage
    exit 2
  fi
else
  if [[ -z "$BASE" || -z "$ROOT" ]]; then
    usage
    exit 2
  fi
  for spec in "${SPECS[@]}"; do
    case "$spec" in
      *:*) ;;
      *) echo "Invalid --spec (expected <issue>:<branch>): $spec" >&2; exit 2 ;;
    esac
    spec_issue="${spec%%:*}"
    if [[ ! "$spec_issue" =~ ^[0-9]+$ ]]; then
      echo "Invalid --spec issue number (must be digits): $spec" >&2
      exit 2
    fi
  done
fi

# --path-format=absolute --git-common-dir always points at the main .git,
# regardless of which worktree this script is invoked from (see
# cleanup_run.sh for the same idiom and why --show-toplevel is wrong here).
# This is the same for every spec in a batch, so it's computed once.
repo_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")

branch_exists() { git -C "$repo_root" show-ref --verify --quiet "refs/heads/$1"; }

is_registered_worktree() {
  local target="$1" wt
  target="$(resolve_path "$target")"
  while IFS= read -r wt; do
    wt="${wt#worktree }"
    [[ "$(resolve_path "$wt")" == "$target" ]] && return 0
  done < <(git -C "$repo_root" worktree list --porcelain | grep '^worktree ')
  return 1
}

# --- dependency detection --------------------------------------------------
# Cargo.lock is looked for in the tree the worktree holds — never the main
# checkout, which may sit on another commit than --base (an un-pulled main, a
# feature branch). A real run reads the created worktree; a dry run, which
# creates nothing, reads the ref `git worktree add` would check out
# (checkout_ref, set per spec).
has_lockfile() { # $1=file name at the tree's root
  if [[ $DRY -eq 1 ]]; then
    git -C "$repo_root" cat-file -e "$checkout_ref:$1" 2>/dev/null
  else
    [[ -f "$worktree_path/$1" ]]
  fi
}

# A lefthook config means commits are meant to run its pre-commit hook. The
# hook file itself lives in the shared hooks directory, so it is checked, not
# installed: lefthook writes a pre-commit script that names lefthook.
hooks_expected=0
expected_hooks=(pre-commit)
if [[ -f "$repo_root/lefthook.yml" || -f "$repo_root/lefthook.yaml" || -f "$repo_root/.lefthook.yml" ]]; then
  hooks_expected=1
fi
hooks_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-path hooks)"

# --- provision_one: everything that used to be this whole script's tail,
# now per-spec. Never calls `exit` — every failure path `return`s 1 so a
# batch run can continue with the remaining specs; the single-issue driver
# below turns that return code straight into the process exit code, which
# preserves the original (pre-batch) single-issue behavior exactly.
#
# Sets globals PROVISION_VERDICT (READY|READY_WITH_WARNINGS|BLOCKED) and
# PROVISION_BASELINE (PASS|FAIL|NONE) for the caller to read.
provision_one() {
  local p_issue="$1" p_branch="$2" p_base="$3" p_root="$4" p_verify="$5" p_log="$6"
  local warn=0
  worktree_path="$p_root/$p_issue"
  PROVISION_VERDICT=""
  # Exported so a caller that sources this file can read it; shellcheck otherwise
  # reports it unused.
  export PROVISION_BASELINE="NONE"

  emit repo_root "$repo_root"
  emit worktree "$worktree_path"

  # --- 2. idempotent re-entry ---------------------------------------------
  if [[ -e "$worktree_path" ]]; then
    if is_registered_worktree "$worktree_path"; then
      emit result "EXISTS"
      emit path "$worktree_path"
      PROVISION_VERDICT="READY"
      echo "verdict: READY"
      return 0
    else
      emit result "BLOCKED"
      emit path "$worktree_path"
      PROVISION_VERDICT="BLOCKED"
      echo "verdict: BLOCKED"
      return 1
    fi
  fi

  # --- 3. create the worktree ---------------------------------------------
  # The ref the worktree checks out: an existing branch as it stands, else a
  # new branch at the base.
  if branch_exists "$p_branch"; then
    checkout_ref="$p_branch"
  else
    checkout_ref="$p_base"
  fi
  if [[ $DRY -eq 1 ]]; then
    echo "DRY: mkdir -p $p_root"
    if branch_exists "$p_branch"; then
      echo "DRY: git -C $repo_root worktree add $worktree_path $p_branch"
    else
      echo "DRY: git -C $repo_root worktree add $worktree_path -b $p_branch $p_base"
    fi
  else
    mkdir -p "$p_root"
    local wt_log wt_rc
    wt_log="$(mktemp)"
    if branch_exists "$p_branch"; then
      git -C "$repo_root" worktree add "$worktree_path" "$p_branch" >"$wt_log" 2>&1
    else
      git -C "$repo_root" worktree add "$worktree_path" -b "$p_branch" "$p_base" >"$wt_log" 2>&1
    fi
    wt_rc=$?
    if [[ $wt_rc -ne 0 ]]; then
      emit result "BLOCKED"
      sed 's/^/  /' "$wt_log"
      rm -f "$wt_log"
      PROVISION_VERDICT="BLOCKED"
      echo "verdict: BLOCKED"
      return 1
    fi
    rm -f "$wt_log"
    emit result "CREATED"
  fi

  # --- 4. dependencies ------------------------------------------------------
  # Nothing to install: cargo fetches and builds on demand into the
  # worktree's own target/.
  local deps_line="none"
  has_lockfile Cargo.lock && deps_line="none-needed (cargo builds on demand)"
  if [[ $DRY -eq 1 ]]; then
    echo "DRY: deps: $deps_line"
  else
    emit deps "$deps_line"
  fi

  # --- 5. shared lefthook hook (checked, never installed here) ------------
  if [[ $hooks_expected -eq 1 ]]; then
    local hook missing_hooks=()
    for hook in "${expected_hooks[@]}"; do
      if ! { [[ -f "$hooks_dir/$hook" ]] && grep -q "lefthook" "$hooks_dir/$hook" 2>/dev/null; }; then
        missing_hooks+=("$hook")
      fi
    done
    if [[ ${#missing_hooks[@]} -eq 0 ]]; then
      emit hooks "shared pre-commit hook installed"
    else
      emit hooks "MISSING ${missing_hooks[*]} (commits here would skip the hook; run \`just install\` in the main checkout)"
      warn=1
    fi
  fi

  # --- 6. verification baseline (only with --verify) ----------------------
  if [[ -n "$p_verify" ]]; then
    local log_path="$p_log" log_dir resolved_log resolved_repo_root resolved_worktree verify_rc
    log_dir="$(dirname "$log_path")"

    resolved_log="$(resolve_path "$log_path")"
    resolved_repo_root="$(resolve_path "$repo_root")"
    resolved_worktree="$(resolve_path "$worktree_path")"

    case "$resolved_log" in
      "$resolved_repo_root"/*|"$resolved_worktree"/*)
        emit baseline_log "$log_path"
        PROVISION_VERDICT="BLOCKED"
        echo "verdict: BLOCKED"
        return 1
        ;;
    esac

    if [[ $DRY -eq 1 ]]; then
      echo "DRY: mkdir -p $log_dir"
      echo "DRY: (cd $worktree_path && $p_verify) > $log_path 2>&1"
    else
      mkdir -p "$log_dir"
      # Bounded, always. The verify command is whatever the caller passed, and
      # a repo whose "check" script starts a watcher or a dev server would
      # otherwise hang this script forever — with no output, since everything is
      # redirected to the log. A timeout is not a judgement call about the
      # command, so it belongs here rather than with the caller; `timeout` is
      # missing on a stock macOS, hence the fallback.
      # Run through python3 rather than timeout(1): timeout is not on a stock
      # macOS, and the two fallbacks that leaves (skip the bound, or kill only
      # the shell and leave its children running) are both worse than using the
      # interpreter this skill already requires. start_new_session puts the
      # command in its own process group so the whole tree dies, not just the
      # `bash -c` wrapper — a test runner that forked workers would otherwise
      # survive the kill and keep holding the port it bound.
      run_verify_bounded "$worktree_path" "$p_verify" "$VERIFY_TIMEOUT" >"$log_path" 2>&1
      verify_rc=$?
      if [[ $verify_rc -eq 0 ]]; then
        emit baseline "PASS"
        PROVISION_BASELINE="PASS"
      elif [[ $verify_rc -eq 124 ]]; then
        # 124 is `timeout`'s own exit code. Called out separately because it
        # means something different from a red baseline: the command never
        # finished, so nothing was proved either way.
        emit baseline "TIMEOUT(${VERIFY_TIMEOUT}s)"
        PROVISION_BASELINE="TIMEOUT"
        warn=1
      else
        emit baseline "FAIL(exit=$verify_rc)"
        PROVISION_BASELINE="FAIL"
        warn=1
      fi
      emit baseline_log "$log_path"
      [[ $verify_rc -ne 0 ]] && tail -15 "$log_path" | sed 's/^/  /'
    fi
  fi

  # --- 7. verdict -----------------------------------------------------------
  if [[ $warn -eq 1 ]]; then
    PROVISION_VERDICT="READY_WITH_WARNINGS"
    echo "verdict: READY_WITH_WARNINGS"
  else
    PROVISION_VERDICT="READY"
    echo "verdict: READY"
  fi
  return 0
}

default_log_path() { # $1=issue -> the same default single-issue mode always used
  printf '%s/../verify/%s-baseline.log\n' "$ROOT" "$1"
}

# --- driver: single-issue (unchanged behavior) or batch ---------------------
if [[ ${#SPECS[@]} -eq 0 ]]; then
  log_path=""
  if [[ -n "$VERIFY" ]]; then
    if [[ -n "$LOG" ]]; then
      log_path="$LOG"
    else
      log_path="$(default_log_path "$ISSUE")"
    fi
  fi
  provision_one "$ISSUE" "$BRANCH" "$BASE" "$ROOT" "$VERIFY" "$log_path"
  exit $?
fi

# --- batch mode -----------------------------------------------------------
total=0
ready=0
blocked_issues=()
batch_blocked=0
batch_warn=0
idx=0

for spec in "${SPECS[@]}"; do
  idx=$((idx + 1))
  spec_issue="${spec%%:*}"
  spec_branch="${spec#*:}"

  total=$((total + 1))

  echo "=== issue $spec_issue ==="
  spec_log=""
  if [[ -n "$VERIFY" ]]; then
    if [[ -n "$LOG_DIR" ]]; then
      spec_log="$LOG_DIR/${spec_issue}-baseline.log"
    else
      spec_log="$(default_log_path "$spec_issue")"
    fi
  fi

  provision_one "$spec_issue" "$spec_branch" "$BASE" "$ROOT" "$VERIFY" "$spec_log"

  case "$PROVISION_VERDICT" in
    BLOCKED)              blocked_issues+=("$spec_issue"); batch_blocked=1 ;;
    READY_WITH_WARNINGS)  ready=$((ready + 1)); batch_warn=1 ;;
    READY)                ready=$((ready + 1)) ;;
  esac

done

summary_verdict="READY"
[[ $batch_warn -eq 1 ]] && summary_verdict="READY_WITH_WARNINGS"
[[ $batch_blocked -eq 1 ]] && summary_verdict="BLOCKED"

echo "batch: $ready/$total ready"
if [[ ${#blocked_issues[@]} -gt 0 ]]; then
  echo "blocked: $(IFS=,; echo "${blocked_issues[*]}")"
fi
echo "verdict: $summary_verdict"
[[ "$summary_verdict" == "BLOCKED" ]] && exit 1
exit 0
