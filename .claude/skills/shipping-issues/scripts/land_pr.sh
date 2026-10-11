#!/usr/bin/env bash
# land_pr.sh — Merge a green PR using the repo's preferred method, then verify
# that the issue it was supposed to close actually closed.
#
# Usage: land_pr.sh <pr-number> [--issue N] [--method squash|merge|rebase]
#                   [--head-sha SHA] [--review-log FILE] [--dry-run]
#                   [--no-link-check] [--no-ready]
#
# Without --method the script picks the first method the repository allows,
# preferring squash. It always merges now: it never arms GitHub auto-merge, so
# `--auto` is an unknown argument.
#
# With --issue N the script does the issue-closing bookkeeping the whole skill
# exists for:
#   * before merging, it runs link_check.sh (without --fix: repairing the body
#     is the PR step's job, and a re-save fires the PR's `edited` workflows), so
#     a PR whose issue is not linked is refused instead of merging and
#     orphaning the issue; link_check's ERROR is reported as `result: ERROR`;
#   * after merging, it confirms the issue really is CLOSED, and closes it with
#     a back-reference comment if GitHub did not (squash merges into a
#     non-default base, keyword lost in a body edit, …).
#
# A draft PR cannot be merged at all — GitHub refuses with "Pull Request is
# still a draft" — so by default the script marks it ready for review (`gh pr
# ready`) right before merging. Pass --no-ready to report `result: DRAFT`
# instead of ready-ing it (the caller decides when a PR should stay draft).
#
# It merges only a PR whose mergeStateStatus is CLEAN, and reports
# `result: NOT_CLEAN` with a `merge_state:` line otherwise (BLOCKED, BEHIND,
# DIRTY, UNSTABLE, …): a ruleset on the default branch is the only other
# guard, and a repository cut from this template has none until its owner
# adds one.
#
# The merge is pinned to one commit (`gh pr merge --match-head-commit`), so a
# push that lands after CI was read cannot be merged unverified: GitHub refuses
# it and the result is MERGE_REFUSED. Pass --head-sha with the `head_sha:` line
# ci_watch.sh printed for its PASS; without it the script pins to the head it
# reads just before it checks the merge state.
#
# With --review-log FILE (the output review_watch.py wrote for this PR) the
# script merges an open PR only when that log is about this PR and its
# `verdict:` is CLEAN or FINDINGS, or NO_NEW_REVIEW (no review started within
# the grace after a push) whose `after_push:` is the commit being merged;
# anything else — PENDING_TIMEOUT (a review still running included),
# NO_REVIEW, ERROR, a NO_NEW_REVIEW about another push, another PR's log, or
# no log at all — is `result: REVIEW_UNSETTLED` and nothing is merged. It
# cannot tell whether FINDINGS were addressed: that triage is the caller's
# step, and this guard only stops a merge that would land before the PR's
# review exists.
#
# With --dry-run nothing is written: on an already-merged PR whose issue is
# still open it reports `issue: WOULD_CLOSE` instead of closing the issue.
#
# Exit codes: 0 = merged, 1 = merge refused, 2 = usage

set -uo pipefail

# Prefixes every line on stdin with two spaces, for quoting tool output in a report.
indent() { sed 's/^/  /'; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# print_help — the script's own usage, derived straight from this header
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
HEAD_SHA=""
REVIEW_LOG=""
DRY=0
LINK_CHECK=1
READY=1
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) [[ $# -ge 2 ]] || { echo "--issue needs a value" >&2; exit 2; }; ISSUE="$2"; ISSUE="${ISSUE#\#}"; shift 2 ;;
    --method) [[ $# -ge 2 ]] || { echo "--method needs a value" >&2; exit 2; }; METHOD="$2"; shift 2 ;;
    --head-sha) [[ $# -ge 2 ]] || { echo "--head-sha needs a value" >&2; exit 2; }; HEAD_SHA="$2"; shift 2 ;;
    --review-log) [[ $# -ge 2 ]] || { echo "--review-log needs a value" >&2; exit 2; }; REVIEW_LOG="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-link-check) LINK_CHECK=0; shift ;;
    --no-ready) READY=0; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "Usage: land_pr.sh <pr-number> [--issue N] [--method squash|merge|rebase] [--head-sha SHA] [--dry-run]" >&2
  exit 2
fi
if [[ -n "$HEAD_SHA" && ! "$HEAD_SHA" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  echo "--head-sha needs a commit SHA, got: $HEAD_SHA" >&2
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

# --- 0.5 the PR's review (merge precondition) --------------------------------
if [[ -n "$REVIEW_LOG" && "$state" == "OPEN" ]]; then
  review_verdict=""
  review_pr=""
  review_after_push=""
  if [[ -r "$REVIEW_LOG" ]]; then
    review_verdict="$(sed -n 's/^verdict: //p' "$REVIEW_LOG" | tail -n 1)"
    review_pr="$(sed -n 's/^pr: //p' "$REVIEW_LOG" | tail -n 1)"
    review_after_push="$(sed -n 's/^after_push: //p' "$REVIEW_LOG" | tail -n 1)"
  fi
  echo "review: ${review_verdict:-UNREADABLE}"
  if [[ "$review_pr" != "${PR#\#}" ]] \
      || [[ "$review_verdict" != "CLEAN" && "$review_verdict" != "FINDINGS" \
            && "$review_verdict" != "NO_NEW_REVIEW" ]]; then
    echo "result: REVIEW_UNSETTLED"
    if [[ -n "$review_pr" && "$review_pr" != "${PR#\#}" ]]; then
      echo "detail: $REVIEW_LOG is review_watch.py's log for PR #$review_pr, not #$PR — nothing was merged"
    else
      echo "detail: the PR's review has no CLEAN, FINDINGS or NO_NEW_REVIEW verdict in $REVIEW_LOG — nothing was merged"
    fi
    exit 1
  fi
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
    echo "detail: link_check.sh failed — ${link_detail:-no detail}"
    exit 1
  elif [[ $link_rc -eq 2 ]]; then
    echo "result: WRONG_BASE"
    echo "detail: retarget the PR at the default branch (gh pr edit $PR --base <default>), or issue #$ISSUE stays open"
    exit 1
  elif [[ $link_rc -ne 0 ]]; then
    # link_check's own detail says which case it is: no closing keyword
    # (`--fix` appends one), or a keyword GitHub has not linked (step 4's
    # `--fix` already re-saved it; the PR is held for a human).
    echo "result: NOT_LINKED"
    link_detail="$(printf '%s\n' "$link_out" | sed -n 's/^detail: //p' | head -n 1)"
    echo "detail: merging now would leave issue #$ISSUE open — ${link_detail:-link_check.sh gave no detail}"
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
      echo "detail: PR #$PR is a draft — mark it ready (gh pr ready $PR) and retry, or omit --no-ready"
      exit 1
    elif gh pr ready "$PR" >/dev/null 2>&1; then
      echo "draft: MARKED_READY"
    else
      echo "result: DRAFT"
      echo "detail: gh pr ready $PR failed — mark it ready by hand and retry"
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

  # --- 1.7 the commit to merge -------------------------------------------------
  # Read BEFORE the merge state, so the CLEAN below is about this commit or a
  # newer one; a push after this read makes GitHub refuse the pinned merge.
  if [[ -z "$HEAD_SHA" ]]; then
    HEAD_SHA="$(gh pr view "$PR" --json headRefOid -q .headRefOid 2>/dev/null)"
    if [[ ! "$HEAD_SHA" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
      echo "result: ERROR"
      echo "detail: cannot read the head commit of PR #$PR — nothing was merged"
      exit 1
    fi
  fi
  echo "head_sha: $HEAD_SHA"

  # NO_NEW_REVIEW speaks only for the push it waited after: a later push
  # needs its own start grace before it can merge.
  if [[ "${review_verdict:-}" == "NO_NEW_REVIEW" ]]; then
    pushed="$(printf '%s' "$review_after_push" | tr '[:upper:]' '[:lower:]')"
    pinned="$(printf '%s' "$HEAD_SHA" | tr '[:upper:]' '[:lower:]')"
    if [[ ! "$pushed" =~ ^[0-9a-f]{7,40}$ ]] \
        || [[ "$pinned" != "$pushed"* && "$pushed" != "$pinned"* ]]; then
      echo "result: REVIEW_UNSETTLED"
      echo "detail: $REVIEW_LOG says no review started after push ${review_after_push:-none}, not the head $HEAD_SHA — re-run review_watch.py --after-push $HEAD_SHA; nothing was merged"
      exit 1
    fi
  fi

  # --- 1.8 merge state (merge precondition) ----------------------------------
  # GitHub's own answer to "can this merge right now".
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
    echo "detail: GitHub does not report PR #$PR as cleanly mergeable — nothing was merged"
    gh pr view "$PR" --json mergeable,mergeStateStatus,reviewDecision 2>/dev/null | indent
    exit 1
  fi
fi

# --- 2. merge ---------------------------------------------------------------
# confirm_issue <result-label> — post-merge, make sure the issue really closed.
confirm_issue() {
  [[ -z "$ISSUE" ]] && return 0
  local st
  st="$(gh issue view "$ISSUE" --json state -q .state 2>/dev/null)"
  if [[ "$st" == "CLOSED" ]]; then
    echo "issue: CLOSED (#$ISSUE)"
    return 0
  fi
  if [[ -z "$st" ]]; then
    echo "issue: UNKNOWN (#$ISSUE — could not read state)"
    return 0
  fi
  if [[ $DRY -eq 1 ]]; then
    echo "issue: WOULD_CLOSE (#$ISSUE — still open; dry run, nothing closed)"
    return 0
  fi
  # GitHub did not auto-close it. Close it here rather than leaving a merged
  # change with an open issue behind it.
  if gh issue close "$ISSUE" \
       --comment "Closed by #$PR (merged). Auto-close did not fire, so closing explicitly." \
       >/dev/null 2>&1; then
    echo "issue: CLOSED_MANUALLY (#$ISSUE — auto-close did not fire)"
  else
    echo "issue: STILL_OPEN (#$ISSUE — close it by hand)"
  fi
}

if [[ "$state" == "MERGED" ]]; then
  confirm_issue
  exit 0
fi

if out="$(gh pr merge "$PR" "--$METHOD" --delete-branch --match-head-commit "$HEAD_SHA" 2>&1)"; then
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
# whenever the branch is still checked out — long after GitHub has already merged.
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

echo "result: MERGE_REFUSED"
echo "$out" | indent
gh pr view "$PR" --json mergeable,mergeStateStatus,reviewDecision 2>/dev/null | indent
exit 1
