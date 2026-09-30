#!/usr/bin/env bash
# land_pr.sh -- Merge a green PR using the repo's preferred method, then verify
# that the issue it was supposed to close actually closed.
#
# Usage: land_pr.sh <pr-number> [--issue N] [--method squash|merge|rebase]
#                   [--auto] [--dry-run] [--no-link-check] [--no-ready]
#
# Without --method the script picks the first method the repository allows,
# preferring squash. With --auto it enables GitHub auto-merge instead of
# merging now (the right choice when reviews or checks still gate the PR).
#
# With --issue N the script does the issue-closing bookkeeping the whole skill
# exists for:
#   * before merging, it runs link_check.sh (without --fix: repairing the body
#     is the PR step's job, and a re-save fires the PR's `edited` workflows), so
#     a PR whose issue is not linked is refused instead of merging and
#     orphaning the issue; link_check's ERROR is reported as `result: ERROR`;
#   * after merging, it confirms the issue really is CLOSED, and closes it with
#     a back-reference comment if GitHub did not (squash merges into a
#     non-default base, keyword lost in a body edit, ...).
#
# A draft PR cannot be merged at all -- GitHub refuses with "Pull Request is
# still a draft" -- so by default the script marks it ready for review (`gh pr
# ready`) right before merging. Pass --no-ready to report `result: DRAFT`
# instead of ready-ing it (the caller decides when a PR should stay draft).
#
# Without --auto it merges only a PR whose mergeStateStatus is CLEAN, and
# reports `result: NOT_CLEAN` with a `merge_state:` line otherwise (BLOCKED,
# BEHIND, DIRTY, UNSTABLE, ...): the `main` ruleset is the only other guard, and
# a repository cut from this template has none until its owner runs
# `just ruleset`.
#
# --auto and --no-link-check together are a usage error (exit 2, before any
# GitHub call): after --auto nothing confirms the issue closed, so only a PR
# GitHub has verifiably linked may be armed.
#
# Exit codes: 0 = merged (or auto-merge armed), 1 = merge refused, 2 = usage

set -uo pipefail

# Prefixes every line on stdin with two spaces, for quoting tool output in a report.
indent() { sed 's/^/  /'; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# print_help -- the script's own usage, derived straight from this header
# comment so the text lives in exactly one place. Must run BEFORE the
# positional PR argument below is consumed, or `land_pr.sh --help` sets
# PR="--help" and forwards it straight to `gh` instead of showing this.
print_help() {
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
}
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  print_help
  exit 0
fi

PR="${1:-}"
ISSUE=""
METHOD=""
AUTO=0
DRY=0
LINK_CHECK=1
READY=1
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) [[ $# -ge 2 ]] || { echo "--issue needs a value" >&2; exit 2; }; ISSUE="$2"; ISSUE="${ISSUE#\#}"; shift 2 ;;
    --method) [[ $# -ge 2 ]] || { echo "--method needs a value" >&2; exit 2; }; METHOD="$2"; shift 2 ;;
    --auto) AUTO=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-link-check) LINK_CHECK=0; shift ;;
    --no-ready) READY=0; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ $AUTO -eq 1 && $LINK_CHECK -eq 0 ]]; then
  echo "--auto cannot be combined with --no-link-check: nothing would close the issue once auto-merge lands." >&2
  echo "Merge without --auto (confirm_issue then closes the issue after the merge), or wait until GitHub links the PR and use --auto with the link check." >&2
  exit 2
fi

if [[ -z "$PR" ]]; then
  echo "Usage: land_pr.sh <pr-number> [--issue N] [--method squash|merge|rebase] [--auto] [--dry-run]" >&2
  exit 2
fi

state="$(gh pr view "$PR" --json state -q .state 2>/dev/null)" || {
  echo "result: ERROR"; echo "detail: cannot read PR #$PR"; exit 1; }
if [[ "$state" == "MERGED" ]]; then
  echo "result: ALREADY_MERGED"
  # With --issue, fall through to the post-merge issue check below.
  [[ -z "$ISSUE" ]] && exit 0
fi
if [[ "$state" != "OPEN" && "$state" != "MERGED" ]]; then
  echo "result: NOT_OPEN"; echo "state: $state"; exit 1
fi

# --- 1. issue link (auto-close precondition) --------------------------------
if [[ -n "$ISSUE" && $LINK_CHECK -eq 1 && "$state" == "OPEN" ]]; then
  # Inspects only, never edits the PR body.
  link_out="$("$SCRIPT_DIR/link_check.sh" "$PR" --issue "$ISSUE" 2>&1)"; link_rc=$?
  printf '%s\n' "$link_out" | sed 's/^/  link| /'
  if [[ $DRY -eq 1 ]]; then
    :  # report only; the dry-run summary below still prints
  elif [[ $link_rc -eq 3 ]]; then
    # link_check's ERROR: the link state is unknown, so never merge on it.
    echo "result: ERROR"
    link_detail="$(printf '%s\n' "$link_out" | sed -n 's/^detail: //p' | head -n 1)"
    echo "detail: link_check.sh failed -- ${link_detail:-no detail}"
    exit 1
  elif [[ $link_rc -eq 2 ]]; then
    echo "result: WRONG_BASE"
    echo "detail: retarget the PR at the default branch (gh pr edit $PR --base <default>), or issue #$ISSUE stays open"
    exit 1
  elif [[ $link_rc -ne 0 ]]; then
    echo "result: NOT_LINKED"
    echo "detail: merging now would leave issue #$ISSUE open -- fix the link (link_check.sh $PR --issue $ISSUE --fix) and retry"
    exit 1
  fi
fi

# --- 1.5 draft check (merge precondition) ------------------------------------
if [[ "$state" == "OPEN" ]]; then
  is_draft="$(gh pr view "$PR" --json isDraft -q .isDraft 2>/dev/null)" || {
    echo "result: ERROR"; echo "detail: cannot read draft status for PR #$PR"; exit 1; }
  if [[ "$is_draft" == "true" ]]; then
    echo "draft: true"
    if [[ $DRY -eq 1 ]]; then
      :  # report only; a dry run never mutates the PR
    elif [[ $READY -eq 0 ]]; then
      echo "result: DRAFT"
      echo "detail: PR #$PR is a draft -- mark it ready (gh pr ready $PR) and retry, or omit --no-ready"
      exit 1
    elif gh pr ready "$PR" >/dev/null 2>&1; then
      echo "draft: MARKED_READY"
    else
      echo "result: DRAFT"
      echo "detail: gh pr ready $PR failed -- mark it ready by hand and retry"
      exit 1
    fi
  fi
fi

if [[ "$state" == "OPEN" ]]; then
  if [[ -z "$METHOD" ]]; then
    meta="$(gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed 2>/dev/null)"
    if printf '%s' "$meta" | grep -q '"squashMergeAllowed":true'; then METHOD=squash
    elif printf '%s' "$meta" | grep -q '"mergeCommitAllowed":true'; then METHOD=merge
    elif printf '%s' "$meta" | grep -q '"rebaseMergeAllowed":true'; then METHOD=rebase
    else METHOD=squash
    fi
  fi
  echo "method: $METHOD"

  if [[ $DRY -eq 1 ]]; then
    echo "result: DRY_RUN"
    gh pr view "$PR" --json mergeable,mergeStateStatus,reviewDecision 2>/dev/null
    exit 0
  fi

  # --- 1.8 merge state (merge precondition) ----------------------------------
  # GitHub's own answer to "can this merge right now". --auto skips it: arming
  # auto-merge is how a PR that is not CLEAN yet merges once it is.
  if [[ $AUTO -eq 0 ]]; then
    merge_state="$(gh pr view "$PR" --json mergeStateStatus -q .mergeStateStatus 2>/dev/null)"
    # Computed lazily: the first read after a push, or right after `gh pr
    # ready`, is often UNKNOWN (or still DRAFT). One retry gets the real state.
    if [[ "$merge_state" == "UNKNOWN" || "$merge_state" == "DRAFT" ]]; then
      sleep 5
      merge_state="$(gh pr view "$PR" --json mergeStateStatus -q .mergeStateStatus 2>/dev/null)"
    fi
    if [[ "$merge_state" != "CLEAN" ]]; then
      echo "result: NOT_CLEAN"
      echo "merge_state: ${merge_state:-UNREADABLE}"
      echo "detail: GitHub does not report PR #$PR as cleanly mergeable -- nothing was merged"
      gh pr view "$PR" --json mergeable,mergeStateStatus,reviewDecision 2>/dev/null | indent
      exit 1
    fi
  fi
fi

# --- 2. merge ---------------------------------------------------------------
# confirm_issue <result-label> -- post-merge, make sure the issue really closed.
confirm_issue() {
  [[ -z "$ISSUE" ]] && return 0
  local st
  st="$(gh issue view "$ISSUE" --json state -q .state 2>/dev/null)"
  if [[ "$st" == "CLOSED" ]]; then
    echo "issue: CLOSED (#$ISSUE)"
    return 0
  fi
  if [[ -z "$st" ]]; then
    echo "issue: UNKNOWN (#$ISSUE -- could not read state)"
    return 0
  fi
  # GitHub did not auto-close it. Close it here rather than leaving a merged
  # change with an open issue behind it.
  if gh issue close "$ISSUE" \
       --comment "Closed by #$PR (merged). Auto-close did not fire, so closing explicitly." \
       >/dev/null 2>&1; then
    echo "issue: CLOSED_MANUALLY (#$ISSUE -- auto-close did not fire)"
  else
    echo "issue: STILL_OPEN (#$ISSUE -- close it by hand)"
  fi
}

if [[ "$state" == "MERGED" ]]; then
  confirm_issue
  exit 0
fi

flags=("--$METHOD" "--delete-branch")
[[ $AUTO -eq 1 ]] && flags+=("--auto")

if out="$(gh pr merge "$PR" "${flags[@]}" 2>&1)"; then
  if [[ $AUTO -eq 1 ]]; then
    echo "result: AUTO_MERGE_ARMED"
    [[ -n "$ISSUE" ]] && echo "issue: PENDING (#$ISSUE closes when auto-merge lands)"
    exit 0
  fi
  final="$(gh pr view "$PR" --json state -q .state 2>/dev/null)"
  if [[ "$final" == "MERGED" ]]; then
    echo "result: MERGED"
    confirm_issue
    exit 0
  fi
  echo "result: MERGE_UNCONFIRMED"
  echo "state: $final"
  echo "$out" | indent
  exit 1
fi

# `gh pr merge` exited non-zero, which does NOT by itself mean the merge was
# refused: `--delete-branch` also deletes the local branch, and that step fails
# whenever the branch is still checked out -- long after GitHub has already merged.
# Reporting that as MERGE_REFUSED sends the caller chasing a merge that landed,
# so ask GitHub what actually happened before calling it a refusal.
final="$(gh pr view "$PR" --json state -q .state 2>/dev/null)"
if [[ "$final" == "MERGED" ]]; then
  echo "result: MERGED"
  echo "note: merged; only post-merge branch cleanup failed (cleanup_run.sh handles it)"
  echo "$out" | indent
  confirm_issue
  exit 0
fi
if [[ $AUTO -eq 1 ]] &&
   [[ "$(gh pr view "$PR" --json autoMergeRequest -q '.autoMergeRequest != null' 2>/dev/null)" == "true" ]]; then
  echo "result: AUTO_MERGE_ARMED"
  echo "note: auto-merge is armed; only branch cleanup failed (cleanup_run.sh handles it)"
  echo "$out" | indent
  [[ -n "$ISSUE" ]] && echo "issue: PENDING (#$ISSUE closes when auto-merge lands)"
  exit 0
fi

echo "result: MERGE_REFUSED"
echo "$out" | indent
gh pr view "$PR" --json mergeable,mergeStateStatus,reviewDecision 2>/dev/null | indent
exit 1
