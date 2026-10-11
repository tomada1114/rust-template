#!/usr/bin/env bash
# link_check.sh — Verify a PR will auto-close its issue when it merges.
#
# GitHub only closes an issue automatically when BOTH hold:
#   1. the PR body (or a commit message) carries a closing keyword —
#      "Closes #N" / "Fixes #N" / "Resolves #N" — and
#   2. the PR merges into the repository's DEFAULT branch.
# A PR that merely says "see #N", or one targeting a non-default base, leaves
# the issue open. This script checks both and can repair case 1.
#
# Usage: link_check.sh <pr-number> [--issue N] [--fix] [--dry-run]
#
#   --issue N   require that issue #N specifically is in the closing set
#   --fix       if it is not: a body with no closing keyword for #N gets
#               "Closes #N" appended; a body whose keyword GitHub has not
#               linked (already there, or just appended) is re-saved — a
#               minimal "Closes #N" body, then the full body put back — up to
#               2 times, a few seconds apart, and never gains a second keyword.
#               Every edit fires `pull_request: edited` workflows, hence the
#               low bound; run --fix before watching CI.
#               It refuses to rewrite a body it could not read, and if the full
#               body cannot be put back, ERROR names the file that holds it.
#               No re-save on a non-default base: that verdict is WRONG_BASE.
#   --dry-run   with --fix, print the append or re-save it would make instead of
#               calling `gh pr edit` — makes no change to the PR, exits with the
#               status code a real run whose fix links the issue would use
#
# Prints:
#   verdict: LINKED | NOT_LINKED | WRONG_BASE | ERROR
#   closes: #N,#M | none
#   base: <branch> (default: <branch>)
#   detail: <why>                   (on any verdict other than LINKED)
# NOT_LINKED's detail says whether the body lacks a closing keyword or has one
# GitHub has not linked; a re-save does not always make GitHub link it.
#
# Exit codes: 0 = LINKED, 1 = NOT_LINKED, 2 = WRONG_BASE, 3 = usage/lookup error

set -uo pipefail

# print_help — the script's own usage, derived straight from this header
# comment so the text lives in exactly one place. Must run BEFORE the
# positional PR argument below is consumed, or `link_check.sh --help` sets
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
FIX=0
DRY=0
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) [[ $# -ge 2 ]] || { echo "--issue needs a value" >&2; exit 3; }; ISSUE="$2"; ISSUE="${ISSUE#\#}"; shift 2 ;;
    --fix) FIX=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 3 ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "Usage: link_check.sh <pr-number> [--issue N] [--fix]" >&2
  exit 3
fi
# ISSUE goes into a grep pattern below, so it must be a plain number.
if [[ -n "$ISSUE" && ! "$ISSUE" =~ ^[0-9]+$ ]]; then
  echo "--issue needs an issue number, got: $ISSUE" >&2
  exit 3
fi

# Re-save bounds: attempts, seconds between steps, and tries to put the full
# body back. Every wait is a plain `sleep`, which the tests stub out on PATH.
RESAVES=2
WAIT=3
RESTORE_TRIES=3

closing_numbers() {
  gh pr view "$PR" --json closingIssuesReferences \
    -q '[.closingIssuesReferences[].number] | join(",")' 2>/dev/null
}

is_linked() {
  [[ -n "$ISSUE" ]] && printf ',%s,' "$closes" | grep -q ",$ISSUE,"
}

# current_repo — owner/repo of the current repository, looked up once and only
# when a body is read; empty when gh cannot say or answers with anything but
# an owner/repo name, which goes into a grep pattern.
repo_name=""
repo_looked_up=0
current_repo() {
  if [[ $repo_looked_up -eq 0 ]]; then
    repo_name="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || repo_name=""
    [[ "$repo_name" =~ ^[[:alnum:]_.-]+/[[:alnum:]_.-]+$ ]] || repo_name=""
    repo_looked_up=1
  fi
}

# linkable_text < body — the body without what GitHub never links a keyword
# in: HTML comments, fenced code blocks (``` or ~~~) and inline code spans.
linkable_text() {
  awk '
    BEGIN { comment = 0; fence = "" }
    {
      line = $0
      if (fence == "" && !comment && match(line, /^( |  |   )?(```+|~~~+)/)) {
        fence = substr(line, RSTART, RLENGTH)
        sub(/^ +/, "", fence); next
      }
      if (fence != "") {
        if (match(line, /^( |  |   )?(```+|~~~+)[[:space:]]*$/)) {
          close_ = line; sub(/^ +/, "", close_); sub(/[[:space:]]+$/, "", close_)
          if (substr(close_, 1, 1) == substr(fence, 1, 1) && length(close_) >= length(fence)) fence = ""
        }
        next
      }
      out = ""
      while (line != "") {
        if (comment) {
          i = index(line, "-->")
          if (i == 0) { line = ""; break }
          line = substr(line, i + 3); comment = 0
        } else {
          i = index(line, "<!--")
          if (i == 0) { out = out line; line = ""; break }
          out = out substr(line, 1, i - 1) " "; line = substr(line, i + 4); comment = 1
        }
      }
      gsub(/`+[^`]*`+/, " ", out)
      print out
    }
  '
}

# has_closing_keyword <number-pattern> < body — a keyword GitHub reads as
# closing (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved, any
# case, an optional colon) followed by #<number>, or by owner/repo#<number> or
# https://github.com/owner/repo/issues/<number> naming the current repository,
# the number ending at a non-word character — outside an HTML comment or code,
# where GitHub does not link it. A keyword GitHub would not link to this
# repository's issue counts as absent, so --fix appends a real one.
has_closing_keyword() {
  local repo='' text
  current_repo
  if [[ -n "$repo_name" ]]; then
    repo="$(printf '%s' "$repo_name" | sed 's/[.]/\\./g')"
  fi
  text="$(linkable_text)"
  if [[ -n "$repo" ]]; then
    grep -Eiq "(^|[^[:alnum:]_])(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+(($repo)?#|https?://github\.com/$repo/issues/)$1([^[:alnum:]_]|\$)" <<< "$text"
  else
    grep -Eiq "(^|[^[:alnum:]_])(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+#$1([^[:alnum:]_]|\$)" <<< "$text"
  fi
}

# read_body <file> — write the PR body to <file> exactly: `gh -q` prints a
# string value plus one newline, which would otherwise be written back (and
# grow the body) on every edit. Fails, writing nothing, when gh does.
read_body() {
  local raw nl=$'\n'
  raw="$(gh pr view "$PR" --json body -q .body 2>/dev/null && printf x)" || return 1
  raw="${raw%x}"
  printf '%s' "${raw%"$nl"}" > "$1"
}

base_ref="$(gh pr view "$PR" --json baseRefName -q .baseRefName 2>/dev/null)" || base_ref=""
if [[ -z "$base_ref" ]]; then
  echo "verdict: ERROR"
  echo "detail: could not read PR #$PR"
  exit 3
fi
default_branch="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null)"
default_branch="${default_branch:-main}"

closes="$(closing_numbers)"

# keyword: present | absent | unknown (body unreadable) | "" (not read yet).
keyword=""
resave_note=""
body_file=""
minimal_file=""
minimal_live=0

# restore_body — put the full body back after a minimal save, retrying.
restore_body() {
  local try=1
  while [[ $try -le $RESTORE_TRIES ]]; do
    if gh pr edit "$PR" --body-file "$body_file" >/dev/null 2>&1; then
      minimal_live=0
      return 0
    fi
    [[ $try -lt $RESTORE_TRIES ]] && sleep "$WAIT"
    try=$((try + 1))
  done
  return 1
}

# restore_failed — the one path that leaves the body file behind: it is the
# only full copy of the body, so it is named rather than deleted.
restore_failed() {
  rm -f "$minimal_file"
  echo "verdict: ERROR"
  echo "detail: could not restore PR #$PR body after a minimal re-save — the full body is kept at $body_file; put it back with: gh pr edit $PR --body-file $body_file (GitHub's edit history of the PR description also keeps it)"
  exit 3
}

on_interrupt() {
  trap - INT TERM HUP
  if [[ $minimal_live -eq 1 ]]; then
    echo "fix: interrupted during a re-save — restoring the full body"
    restore_body || restore_failed
  fi
  rm -f "$body_file" "$minimal_file"
  echo "verdict: ERROR"
  echo "detail: interrupted"
  exit 3
}
trap on_interrupt INT TERM HUP

# same_body <a> <b> — the two files hold the same body, ignoring carriage
# returns and trailing newlines (a round trip through GitHub may differ in
# both without anyone having edited the text).
same_body() {
  [[ "$(tr -d '\r' < "$1")" == "$(tr -d '\r' < "$2")" ]]
}

# body_unchanged — the live PR body still matches the snapshot in body_file.
# A body that changed (someone edited it while --fix ran) or cannot be read
# must never be overwritten by a minimal save and a restore of the old text.
body_unchanged() {
  local live ok=1
  live="$(mktemp "${TMPDIR:-/tmp}/link_check_live.XXXXXX")" || return 1
  if read_body "$live" && same_body "$live" "$body_file"; then ok=0; fi
  rm -f "$live"
  return $ok
}

# resave_body — save a minimal "Closes #N" body, then the full body again, up
# to RESAVES times, stopping once GitHub lists the issue as closed by the PR.
resave_body() {
  local attempt=0
  minimal_file="$(mktemp "${TMPDIR:-/tmp}/link_check_min.XXXXXX")" || {
    resave_note=" (re-save skipped: mktemp failed)"; minimal_file=""; return; }
  printf 'Closes #%s\n' "$ISSUE" > "$minimal_file"
  echo "fix: the body has a closing keyword for #$ISSUE that GitHub has not linked — re-saving it (a minimal 'Closes #$ISSUE' body, then the full body) up to $RESAVES times"
  # Named up front: a run killed outright (no trap fires) leaves this file as
  # the only full copy of the body outside GitHub's edit history.
  echo "fix: full body snapshot: $body_file (restore with: gh pr edit $PR --body-file $body_file)"
  while [[ $attempt -lt $RESAVES ]] && ! is_linked; do
    attempt=$((attempt + 1))
    if ! body_unchanged; then
      echo "fix: the PR body changed (or could not be re-read) since --fix read it — re-save stopped, nothing restored over it"
      resave_note=" (re-save stopped: the body changed while --fix ran)"
      break
    fi
    # Marked live before the call: a failed edit may still have landed, and
    # putting back the same body is harmless.
    minimal_live=1
    if gh pr edit "$PR" --body-file "$minimal_file" >/dev/null 2>&1; then
      sleep "$WAIT"
      restore_body || restore_failed
    else
      restore_body || restore_failed
      echo "fix: FAILED (could not edit PR body)"
      resave_note=" (re-saving the body failed)"
      break
    fi
    sleep "$WAIT"
    closes="$(closing_numbers)"
    if is_linked; then
      echo "fix: re-save $attempt/$RESAVES: linked"
    else
      echo "fix: re-save $attempt/$RESAVES: not linked yet"
      resave_note=" after $attempt re-save(s) of the body"
    fi
  done
  rm -f "$minimal_file"
  minimal_file=""
}

# --- repair a missing link --------------------------------------------------
if [[ -n "$ISSUE" && $FIX -eq 1 ]] && ! is_linked; then
  body_file="$(mktemp "${TMPDIR:-/tmp}/link_check_body.XXXXXX")" || { echo "verdict: ERROR"; echo "detail: mktemp failed"; exit 3; }
  if ! read_body "$body_file"; then
    echo "verdict: ERROR"
    echo "detail: could not read PR #$PR body — refusing to rewrite it"
    rm -f "$body_file"
    exit 3
  fi
  if has_closing_keyword "$ISSUE" < "$body_file"; then keyword=present; else keyword=absent; fi

  if [[ $DRY -eq 1 ]]; then
    if [[ "$keyword" == "absent" ]]; then
      echo "fix: would append 'Closes #$ISSUE' to PR #$PR body (dry run — no change made)"
    elif [[ "$base_ref" != "$default_branch" ]]; then
      echo "fix: would not re-save PR #$PR body — its base is not $default_branch (dry run — no change made)"
    else
      echo "fix: would re-save PR #$PR body, which already has a closing keyword for #$ISSUE, up to $RESAVES times (dry run — no change made)"
    fi
    # Simulate a successful fix for the verdict/exit-code below, since that is
    # the outcome a dry run is meant to preview. No gh pr edit call is made.
    closes="${closes:+$closes,}$ISSUE"
    rm -f "$body_file"
    body_file=""
  else
    edited=1
    if [[ "$keyword" == "absent" ]]; then
      printf '\n\nCloses #%s\n' "$ISSUE" >> "$body_file"
      if gh pr edit "$PR" --body-file "$body_file" >/dev/null 2>&1; then
        echo "fix: appended 'Closes #$ISSUE' to the PR body"
        keyword=present
        # GitHub recomputes the link asynchronously.
        sleep "$WAIT"
        closes="$(closing_numbers)"
      else
        echo "fix: FAILED (could not edit PR body)"
        edited=0
      fi
    fi
    if [[ $edited -eq 1 && "$keyword" == "present" ]] && ! is_linked; then
      if [[ "$base_ref" == "$default_branch" ]]; then
        resave_body
      else
        echo "fix: re-save skipped — the base is not $default_branch"
      fi
    fi
    rm -f "$body_file"
    body_file=""
  fi
fi

echo "base: $base_ref (default: $default_branch)"
echo "closes: ${closes:-none}"

if [[ "$base_ref" != "$default_branch" ]]; then
  echo "verdict: WRONG_BASE"
  echo "detail: auto-close only fires when the PR merges into $default_branch"
  exit 2
fi

# not_linked <detail-for-a-body-without-the-keyword> — print NOT_LINKED with
# the detail that says whether the keyword is missing or GitHub has not linked
# it, reading the body when --fix has not already.
not_linked() {
  local body target="${ISSUE:-[0-9]+}" which="#$ISSUE"
  if [[ -z "$keyword" ]]; then
    if body="$(gh pr view "$PR" --json body -q .body 2>/dev/null)"; then
      if has_closing_keyword "$target" <<< "$body"; then keyword=present; else keyword=absent; fi
    else
      keyword=unknown
    fi
    [[ $FIX -eq 0 && "$keyword" == "present" && -n "$ISSUE" ]] && resave_note=" (--fix re-saves the body)"
  fi
  [[ -z "$ISSUE" ]] && which="an issue"
  echo "verdict: NOT_LINKED"
  case "$keyword" in
    present) echo "detail: the PR body has a closing keyword for $which, but GitHub has not linked it$resave_note" ;;
    absent) echo "detail: $1" ;;
    *) echo "detail: GitHub has not linked $which, and the PR body could not be read to say why" ;;
  esac
  exit 1
}

if [[ -z "$closes" ]]; then
  not_linked "the PR body has no Closes/Fixes/Resolves keyword"
fi

if [[ -n "$ISSUE" ]] && ! is_linked; then
  not_linked "PR closes #$closes but not the target issue #$ISSUE"
fi

# No trailing `exit 0`: echo exits 0, and shellcheck 0.11 reports a trap handler
# as never invoked (SC2329) when the script ends in a top-level exit.
echo "verdict: LINKED"
