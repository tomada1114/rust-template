# Landing outcomes

What `land_pr.sh` can return and what each result requires. Read it when the
merge step returns anything other than a clean merge.

`land_pr.sh <pr> --issue <n>` prints a `result:` line and, with `--issue`, an
`issue:` line. The `--issue` flag makes it re-check the closing link before
merging and confirm the issue really closed after, closing it explicitly with a
back-reference comment if GitHub's auto-close did not fire. Without `--auto` it
merges only a PR whose `mergeStateStatus` is `CLEAN`.

This skill never passes `--auto`. Arming auto-merge hands the merge to GitHub
after this run has stopped watching, while the go-ahead this skill merges on is
a `verdict: PASS` from `ci_watch.sh` and a `CLEAN` merge state. A PR that waits
on a human review is held and reported, not armed.

These twelve are every `result:` the script prints (`grep -o 'result: [A-Z_]*'
land_pr.sh`):

| `result:` | What it means | What to do |
|---|---|---|
| `MERGED` | GitHub reports the PR merged; a `note:` line may say only the local branch cleanup failed | read `issue:` -- `CLOSED` and `CLOSED_MANUALLY` are done, `STILL_OPEN` and `UNKNOWN` go in the step 10 report -- then record `--event merged`. |
| `ALREADY_MERGED` / `NOT_OPEN` | the PR left the open set before this call | take the issue's state from the `issue:` line and move on without retrying. |
| `NOT_LINKED` / `WRONG_BASE` | the script refused to merge because the issue would be orphaned | repair it -- `link_check.sh --fix` for a missing keyword, retarget the PR's base for a wrong base -- then retry. When the `link|` detail says the body has the closing keyword but GitHub has not linked it, retry with `--no-link-check --issue <n>` instead: the issue is still confirmed closed, and closed by the script if auto-close did not fire (`pr-ci-merge.md`, step 5). Otherwise pass `--no-link-check` only if the user asked for a PR that deliberately does not close its issue. |
| `DRAFT` | still a draft, and the script could not (or was told not to) mark it ready | mark the PR ready, then retry. |
| `NOT_CLEAN` | GitHub does not report the PR cleanly mergeable; nothing was merged. The `merge_state:` line says why | `BLOCKED`: a required check is missing or still pending, or a required review is outstanding -- run `ci_watch.sh` again; if every check passed and `reviewDecision` asks for a review, the PR is held for a human: record `--event blocked --field reason=review-required` and move on. `BEHIND` or `DIRTY`: [bring the branch up to date](#bringing-a-pushed-branch-up-to-date) and return to the CI step. `UNKNOWN` or `UNREADABLE`: retry once. Anything else (`UNSTABLE`, ...): re-read the PR's checks before retrying. |
| `MERGE_REFUSED` | `gh pr merge` was rejected; the reason is indented below it | a conflict: [bring the branch up to date](#bringing-a-pushed-branch-up-to-date) and return to the CI step. Anything else: report the reason. |
| `AUTO_MERGE_ARMED` | only with `--auto`, which this skill does not pass: auto-merge is armed and nothing has merged yet | report it as armed, never as merged; `issue: PENDING` stays open until GitHub merges. |
| `MERGE_UNCONFIRMED` / `ERROR` | the outcome is unestablished | re-read the actual PR and issue state. **Never report a merge on this result alone.** |
| `DRY_RUN` | only with `--dry-run`: the merge method and merge state were printed and nothing was written | read them, then run without `--dry-run`. |

## Bringing a pushed branch up to date

A PR branch has already been pushed, so it is brought up to date by merging
the default branch into it, never by a rebase: a rebased branch needs a force
push, which the sign-off for this skill does not cover (`AGENTS.md` ›
"Security and human approval").

```bash
git -C <workdir> fetch origin <default_branch> --quiet
git -C <workdir> merge origin/<default_branch>
git -C <workdir> push
```

A conflict that is mechanical -- two entries under the same `CHANGELOG.md`
heading -- is resolved in `<workdir>` by keeping both; any other conflict is
`recovery.md`'s "A merge conflict". A repository whose rules require linear
history and refuse this merge is a stop condition: record `--event blocked
--field reason=linear-history` and ask the human.
