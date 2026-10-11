# Review fix (brief)

Used at [SKILL.md step 5](../SKILL.md#5-wait-for-the-pr-review) — only for the PR
review's findings this session has already read and accepted
(triage: `implement-and-review.md` › "Triaging the review's findings") for this PR, one brief
per review round that has any, handed to **`executor`** or followed inline in that branch's
own `{workdir}`.
Zero accepted findings → nothing to run.

```
Branch {branch} implements issue #{n} in {owner}/{repo} and is open as PR
#{pr}. The PR's automatic review has already run against it and I have triaged
its findings myself; below are the ones I accepted. Apply exactly these and
nothing else. The review itself is not yours to answer: do not reply to,
resolve, or comment on any review thread, and do not ask for another review.

Work only inside {workdir} — not any sibling checkout or worktree of the same
repository. Branch {branch} is already checked out there; do not switch
branches, and do not create one.

<context>
Issue #{n}: {two-sentence paraphrase of what issue #{n} asks for}, "the body
is authoritative over this summary."
Read it yourself, read-only, with:
  gh issue view {n} --repo {owner}/{repo} --json title,body,labels,comments
When the body has a `Part of: #<N>` line, read that parent issue too, read-only
and the same way — it holds the settled decisions the body defers to:
  gh issue view <N> --repo {owner}/{repo} --json title,body,labels,comments
Those reads are the ONLY GitHub commands you are permitted to run.
</context>

<findings>
{one per line, numbered as review_watch.py numbered them, as `F<n> file:line —
what is wrong — why it matters`, in my words. Findings I rejected or ruled out of
scope are not listed here and must not be inferred.}
</findings>

Project conventions: read {workdir}/AGENTS.md (and the host's own instruction
file, if any) before changing anything, and load the skills its Skills table
names for tests, commits, and the areas the findings touch.
Verification: the narrowest checks that can fail for the fixed lines
              (AGENTS.md › "Validating a change"), never the full `just check`

Do:
1. Fix each finding at its cause, not at its symptom.
2. If a finding is wrong on closer reading — the code already handles it, or
   the fix would change behavior issue #{n} did not ask to change — do NOT
   apply it. Report it under REJECTED with the reason. A finding I accepted
   from a summary can still be wrong in front of the code, and you are the
   one in front of the code.
3. Do not fix anything that is not in the list. Real defects you notice go to
   FOLLOW-UPS, not into this diff.
4. Run the verification command in the **foreground** — never in the
   background where you then have to poll it — then commit and push. Push
   before you return.
5. No GitHub write of any kind beyond the read above — no `gh pr`, no
   `gh issue edit/comment/close`, no label change. Never `rm`: undo a probe
   inside the checkout with `git checkout --`, or move it aside with `mv`
   into {holding_dir}, and name any scratch file — including a throwaway fixture or repository
   you created under a temp directory — you left behind in your report.
6. Use my F-numbers verbatim in APPLIED and REJECTED; do not renumber.

Return exactly:
APPLIED: <one line per finding fixed, `F<n> -> <what changed>`, or "none">
REJECTED: <one line per finding not applied, with why, or "none">
VERIFY: <exact command run> -> <pass/fail + the failing output if any>
PUSHED: <yes + the remote ref, or "no" + why>
FOLLOW-UPS: <defects you saw that are NOT in the list, one per line as
             `file:line — what is wrong — what prevents it today`, or "none">
```

`REJECTED` is read, not skimmed — it is the run's only signal that a finding this
session accepted did not survive contact with the code, and a rejection that reads like
a real defect goes back through the same loop with the reason addressed. `FOLLOW-UPS`
feeds step 8 like every other one.
