---
name: create-pr
description: >
  Covers opening or updating a pull request in this repository: the preconditions (a
  clean feature branch), just check as the gate, a Conventional Commits title that
  check-pr-title.yml accepts, a body filled from .github/PULL_REQUEST_TEMPLATE.md
  (Summary, Test Plan, Checklist), the Release impact line and its MAJOR/MINOR/PATCH
  call, the evidence only a human can produce (just test-local output for a
  myapp-platform adapter), the CHANGELOG.md entry under [Unreleased], and gh pr create /
  gh pr edit. Use when asked to open, create, submit, or update a PR or pull request,
  request review, or decide whether a change needs a release or which version bump it
  deserves.
---

# Create PR

**Owns:** turning a pushed-ready branch into a pull request that can be reviewed:
preconditions, the gate run, the title, the body, the Release impact line, and the
create-or-update call. **Does not own:** making the commits (`smart-commit`); what the
gates contain (`changing-gates`); landing someone else's PR (`shipping-issues`,
`merging-dependency-prs`).

Titles, bodies, and commit messages are English.

## Gather the state first

```bash
cat .github/PULL_REQUEST_TEMPLATE.md
git log main..HEAD --oneline
git diff --stat main..HEAD
git status --short
gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --json number,title,url
```

- On `main`: stop. A pull request comes from a feature branch.
- Uncommitted changes: stop. **REQUIRED:** `smart-commit` first, since the gate would
  judge a tree the pull request does not contain.
- A pull request already open for this branch: update it (`gh pr edit`), never open a
  second one.

## Step 1: The gate

```bash
just check
```

`just check` runs everything a Mac can run without a human (verify-hooks, fmt, lint,
lint-repo, agents-check, test-scripts, check-harness, test, test-platform);
the justfile's `check` recipe is the source of truth for the order. It opens no window
(`AGENTS.md` › "Never taking over the developer's Mac"). A cold run takes longer than a
foreground tool call may last, so under Claude Code start it with `run_in_background`
and wait for the completion notice; under Codex CLI give the command a timeout that
covers a full build.

Any failure stops the pull request. Report the failing step and its first error, and fix
the cause; a failing gate is never worked around (`AGENTS.md` › "Security and human
approval" lists what counts as weakening one).

A green run can still leave the branch behind: its `fmt` step rewrites files in place
rather than failing on them. Check the tree afterwards:

```bash
git status --short
```

Any output means the pushed branch differs from what the gate judged, and CI's format
check fails on it. **REQUIRED:** `smart-commit` for those files, then run `just check`
again.

## Step 2: Read the diff for what the gate cannot judge

Read `git diff main..HEAD` for these, each of which feeds a checklist item:

- **Where the logic landed.** A decision (anything that branches, clamps, or formats)
  belongs in `crates/myapp-core`, with tests, where the coverage floor sees it. A
  decision found in `src-tauri/`, `crates/myapp-platform/`, `crates/myapp/`, or
  `ui/src/` leaves "New logic lives in `myapp-core`" unchecked.
- **IPC.** A type that derives `ts_rs::TS` changed without `ui/src/ipc/generated/`
  changing beside it, or a command or event changed without its wrapper in
  `ui/src/ipc/commands.ts` or `ui/src/ipc/events.ts`.
- **A contract.** Core's public API, the bundle identifier, an IPC name or payload, an
  on-disk format, or the helper's command line (`docs/architecture.md` › "What is
  contract and what is private"). A breaking change is named in the Summary.
- **Evidence only a human can produce.** A change to an adapter in
  `crates/myapp-platform/` that has an `#[ignore = "local machine: ..."]` test needs
  `just test-local` output. It is a human's recipe, never run by an agent. Ask the
  human to run it and paste the output; until it is in the Test Plan, that item stays
  unchecked.
- **A new dependency** (a crate or an npm package) needs its reason in the body for the
  human's sign-off (`.claude/rules/project.md` › "Dependency Policy").
- **A weakened gate**: a lint `allow` or `expect`, a lowered floor, a coverage
  exclusion, an `#[ignore]` or a `skip` on a failing test, an ignore-list entry. Any of these leaves "No gate weakened" unchecked, and the PR stops until a
  human decides.
- **Doc comments.** A new `pub` item without a `///` comment saying why it exists
  (`AGENTS.md` › "Review Checklist"), or a new wrapper in `ui/src/ipc/` without a TSDoc
  comment. `missing_docs` catches an absent `///`, not one that only restates the
  signature, and nothing checks the TSDoc.
- **CHANGELOG.** A user-visible change without an entry under `[Unreleased]` in
  `CHANGELOG.md` (`AGENTS.md` › "Review Checklist").
- **Docs.** A change to public behavior or a contract without the doc that describes it.
  **REQUIRED:** `updating-docs`, to decide which surface owes the update.

## Step 3: The title

`<type>(<optional scope>): <summary>`, under 72 characters, the same limit `smart-commit`
sets for a commit subject (no check enforces either). The types are the ones
`.github/workflows/check-pr-title.yml` accepts: `feat`, `fix`, `docs`, `style`,
`refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, `deps`. With mixed commits,
use the type of the most significant change. The title becomes the squashed commit on
`main`, and `.github/workflows/pr-label.yml` labels the PR from its type for the release
notes, so a wrong type files the change under the wrong heading.

## Step 4: The body

Fill `.github/PULL_REQUEST_TEMPLATE.md` in order.

- **Summary.** One to three lines on why the change exists, then `Closes #N` when an
  issue is known (a bare `#N` closes nothing). Name any breaking change.
- **Release impact.** Replace the comment after the template's `**Release impact:**`
  label with one of the two forms in **REQUIRED:**
  [references/release-impact.md](references/release-impact.md), which also holds the
  MAJOR/MINOR/PATCH table. A missing value is not `none`: it is an unfinished PR.
- **Test Plan.** The commands that ran and what they printed: `just check` always, the
  narrower check from `AGENTS.md` › "Validating a change" that exercised the change, and
  any human-run output from Step 2.
- **Checklist.** Tick an item only when Step 1 or Step 2 showed it holds; an item that
  does not apply to the change is ticked, since there is nothing to hold.

Any item left unchecked stops the pull request: report which and why.

## Step 5: Create or update

Pushing the branch and creating or updating its pull request are the remote writes this
skill exists to make; invoking it is the sign-off for them, for this invocation only
(`AGENTS.md` › "Security and human approval", standing exceptions). Nothing else on that
list is covered: no force push, no merge.

```bash
git push -u origin <current-branch>

gh pr create --base main --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"

gh pr edit <number> --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"
```

Pass the body through a quoted heredoc so its Markdown and backticks survive the shell.
Print the PR URL when done.
