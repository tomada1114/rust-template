# Implementation (brief)

Used at [SKILL.md step 3](../SKILL.md#3-implement), one issue per brief. Handed to
**`executor`** by default, and to **`architect`** when the issue is foundational —
architecture or a skeleton, an interface/port/schema, or a skill, instruction file, or
gate whose shape the rest of the backlog copies. The test is blast radius, not
difficulty:
`cost-discipline.md` › "The foundation exception: architect for what the backlog builds on".
A resume/patch run stays on the tier its first run used, continuing the same agent where
the host allows.

```
Implement GitHub issue #{n} in {owner}/{repo}. Once you return, your branch is
turned into a PR and merged automatically once CI is green, so it must be
complete and correct by the time you push. You cannot ask me a question
mid-run — if something is genuinely undecidable, make the call, implement it,
and report it under UNRESOLVED.

Work only inside {workdir} — not any sibling checkout or worktree of the same
repository. {workdir_note}

<task>
{Issue #{n}: "{title}" (labels: {labels}{, UNBLOCKS/BLOCKED-BY if any}).

Read the full issue body and every comment yourself, read-only, with:
  gh issue view {n} --repo {owner}/{repo} --json title,body,labels,comments
When the body has a `Part of: #<N>` line, read that parent issue too, read-only
and the same way — it holds the settled decisions the body defers to:
  gh issue view <N> --repo {owner}/{repo} --json title,body,labels,comments
Those reads are the ONLY GitHub commands you are permitted to run.

Then a short paraphrase of what the issue asks — two or three sentences — so
the sub-agent can tell a bad read from a good one, ending with: "the body is
authoritative over this summary."}

{And, whenever the repository has moved under the issue since it was written —
a dependency of it merged in this same run, a file it cites was rewritten:
"IMPORTANT — the issue body describes the OLD state. On current `main`: <what
changed>. Read the current files before designing anything, and if the body's
premise no longer holds, say so under UNRESOLVED and implement what the issue
is actually trying to achieve rather than its literal description of a file
that has since changed."}
</task>

<context>
Work directory: {workdir}   {"<- already provisioned: a fresh worktree with its
                              own empty target/, no secrets copied" in
                              parallel mode; omit in serial mode}
Base branch: {base_branch}
Branch: {branch_name}             <- already created and checked out; do not
                                      create a new one
Likely files: {paths from step 2's triage, or — when step 2 was skipped on a
               labeled backlog — a short grep/glob the parent runs against
               the issue's own keywords right before spawning; never blank}
Project conventions: read {workdir}/AGENTS.md (and the host's own
instruction file, if any) before writing code, then load the skills its
Skills table names for the work: how tests are written and placed and the
test-first order, how commits are grouped, and the skill for each layer or
area you touch.
Decisions already made: {anything step 2/2b resolved, so it is not re-opened}
Verification: the narrowest checks that can fail for what you change, from
              AGENTS.md › "Validating a change" (name them here when the
              triage already knows them, such as `just test-fast <filter>`
              then `just test-core` and `just lint` for core). Do NOT run
              the full `just check` before pushing: CI is the gate and the
              PR merges only once it is green.
</context>

Do:
1. Read the project's own instruction files and the skills they route you to,
   and follow them, including their test and commit conventions.
2. If the task claims a performance improvement (runtime, throughput, memory,
   latency), measure the *before* state here, on the unmodified code, with the
   exact command you will re-run afterwards.
3. Implement the stated scope. Deliver what the task asks, at the scope it
   asks. If a better approach exists, say so in one sentence under
   SCOPE-NOTES and implement as asked.
4. Add or update the tests that cover the change, and run the narrowest
   checks named above (never the full gate: CI runs it). Report the exact
   commands. For a performance task, re-run step 2's measurement under the
   same conditions and report both numbers under MEASURE. Never run a
   recipe that needs a human (`just test-local`, `just logs-follow`,
   `just install-cli`) or `myapp tui`; `just test-platform` and `just logs`
   are your evidence that the change works. When the change is to an
   adapter under crates/myapp-platform/ that has an
   `#[ignore = "local machine: ..."]` test, or to the terminal loop only a
   real terminal shows, say so under VERIFY: that evidence is the human's.
5. If the change is user-facing, add an entry to CHANGELOG.md under
   [Unreleased], in the section (Added / Changed / Fixed / ...) that fits.
   Commit in coherent increments, staging paths explicitly and never a
   generated artifact (`target/`, `coverage/`, `__pycache__`), and push as
   soon as the first coherent commit exists — a run stopped mid-way keeps
   only what was pushed. Before your last push, `git status --short` must
   be empty: commit a leftover change (such as a `just fmt` rewrite) and
   re-run the checks, so the branch is what the checks judged.
6. The only GitHub commands you may run are
   `gh issue view {n} --repo {owner}/{repo} --json title,body,labels,comments` and, when
   the body has a `Part of: #<N>` line, the same read of issue `<N>` — every other GitHub
   call, including `gh pr`, `gh issue edit/comment/close`, any label change,
   or a non-GET `gh api` call, belongs to the parent (it opens the PR and
   watches CI). Never `rm`: undo a probe inside the checkout with
   `git checkout --`, or move it aside with `mv` into {holding_dir}, and name
   any scratch file — including a throwaway fixture or repository you created
   under a temp directory — you left behind in your report. If the issue
   requires deleting an existing file or directory, `mv` it into {holding_dir}
   (keep its relative path), then stage the deletion with `git add -A -- <path>`
   when it was tracked — never `git rm`, never `rm -rf`. If it requires removing
   a dependency, delete its entry from the `Cargo.toml` that declares it and
   let the next `cargo` command update `Cargo.lock`; adding a crate is never
   yours to do — it needs a human's sign-off (`managing-dependencies`): name
   it under UNRESOLVED. `rm` and `git rm` can each raise an approval prompt
   that nobody answers, and one such command chained with others stalls the
   whole call; a disposable temp directory costs nothing to keep. Any other
   command that would ask for approval: don't wait on it — name it under
   UNRESOLVED.
7. Run every verification in the **foreground**. Do not start a long command
   in the background and then poll it — a run that returns while waiting on
   its own background job returns without its report, and its work has to be
   recovered by hand.
8. {Parallel mode only:} If you produce a gitignored artifact worth keeping —
   a fixture, a benchmark result, a generated file the change does not commit
   — copy it into {repo_root} before you return and name it under
   SCOPE-NOTES. Your working directory is a worktree and is deleted at the
   end of the run; anything gitignored inside it goes with it.

Return exactly:
BRANCH: <name>
PUSHED: <yes + the remote ref, or "no" + why>
CHANGED: <file list>
VERIFY: <exact command run> -> <pass/fail + the failing output if any>
MEASURE: <performance task: command + before + after + why it counts as
          improved. Otherwise "n/a">
ACCEPTANCE: <the issue's Acceptance Criteria checklist, one line per item, as
             `met | not-met | not-applicable — <the command or output that
             shows it>`. "The issue has no acceptance criteria" is a valid
             answer; a criterion you cannot demonstrate is not-met, never met>
SCOPE-NOTES: <anything in the task you did not implement, and why>
FOLLOW-UPS: <defects you saw that are NOT this task, one per line as
             `file:line — what is wrong — what prevents it today`, or "none">
UNRESOLVED: <judgment calls you had to make, or "none">
PR-TITLE: <one line the parent can use verbatim; choose its type from the explicit
           types input in .github/workflows/check-pr-title.yml>
PR-SUMMARY: <2-4 lines: what changed and why, for the PR body>
TEST-PLAN: <what the parent should put under the PR's test plan, including the
            commands run and, for a perf issue, both numbers>

Every value in that return must come from a command output in this session.
If a step did not run, say so instead of filling the field.
```

`FOLLOW-UPS` is how a real defect the run must not fix here still survives: step 8 files
it as its own issue. `SCOPE-NOTES` and `UNRESOLVED` feed the same step and the step 10
report.

`ACCEPTANCE` is the one field green CI cannot substitute for. CI proves the repository
still works; it does not prove the issue was answered — a change can pass every check
and still miss a criterion the issue spelled out. An issue written with a checklist has
already done the hard part of saying what "done" means, and reading that checklist back
against real command output is what turns a merge into a completed issue rather than a
closed one. Any `not-met` line is a step 3 result to send back, not a step 10 footnote.

**Name the verification CI cannot run.** CI runs one environment: a clean checkout with
no developer's variables exported. So a change whose behavior turns on whether an
environment variable is _set_ — a credential, a feature flag, a recording mode — has a
whole half CI never exercises, and a green pipe is not evidence about it. Whenever the
diff makes anything conditional on the environment, write the both-ways check into the
prompt as an explicit command pair with a throwaway value, and require both in `VERIFY`:

```
AND, because CI cannot catch this, run these explicitly and report both:
  {VAR}=dummy-not-a-real-value {the narrowest test command}
  {VAR}=dummy-not-a-real-value cargo build --locked -p myapp
Both must succeed. That value is a throwaway string, not a credential; do not
put a real one anywhere, and do not read any `.env` file to find one.
```

Seen in practice: a gate keyed off a provider credential's mere presence, which refused
to start the app, broke the build, and stopped a whole test file from loading on any
machine that exported that variable for an unrelated reason — with CI green throughout,
because CI does not set it. Nothing but running it both ways would have found that
before merge.

Scope is **branch to pushed commits**; the PR, the review, CI, and the merge belong to
the parent. Push discipline is the run's insurance: it pushes as soon as its first
coherent commit exists, so a stopped run loses at most its uncommitted tail — and in
parallel mode the worktree itself is temporary, so an unpushed commit is one cleanup
away from gone. It never deletes anything — that happens once, in the parent's cleanup
step (step 9), and only after the branch is merged.

In parallel mode, hand off every implementation in the batch **before waiting on any of
them** — in one message where the host batches spawns. Spawned and awaited one after
another they run one after another, which is the whole thing this mode exists to avoid.
