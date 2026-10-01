---
name: smart-commit
description: >
  Covers turning the working tree into Conventional Commits in this repository: the
  branch guard, the judgment the staged guard (cargo xtask check-staged) cannot make,
  grouping changes into atomic commits, the files that must travel together (Cargo.lock
  with a Cargo.toml, pnpm-lock.yaml with package.json, .claude/skills/ with
  .agents/skills/), the commit types
  check-pr-title.yml accepts, and recovering when lefthook's pre-commit hook refuses a
  commit (ERR_STAGED_BLOCKED_PATH, ERR_STAGED_CREDENTIAL_SHAPED, rustfmt, prettier,
  eslint, typos, skills mirror). Use when asked to commit, save changes, stage changes,
  commit and push, push my changes, or ship it, or when git commit fails in the hook.
---

# Smart Commit

**Owns:** staging, grouping, and writing the commits for work already done, and pushing
them when asked. **Does not own:** the pull request (`create-pr`); what the staged guard
blocks (`xtask/guard/`, stated once in `AGENTS.md` › "Security and human
approval"); changing a hook or a gate (`changing-gates`).

Every commit message is English.

## Gather the state first

```bash
git rev-parse --abbrev-ref HEAD   # current branch
git status --short                # what changed
git log --oneline -5              # the message style in use
```

## Branch guard

`.github/rulesets/main.json` rejects a direct push to `main` once an admin has applied
it with `just ruleset` (a human's step, run once per repository). Until then a solo
owner may commit to `main`. Commit on a feature branch instead when either holds:

- the user wants a pull request for this change (`create-pr` refuses to run on `main`);
- the ruleset is applied, or the repository has a team workflow (`CONTRIBUTING.md`).

When it is unclear which the user wants, ask before staging anything.

## Step 1: Read the changes

```bash
git status
git diff            # unstaged
git diff --cached   # staged
```

Changes the user already staged are their statement of intent: commit those first and
treat the rest as candidates. With nothing staged, every modified and untracked file is a
candidate.

## Step 2: What must never be committed

The mechanical list (secret-shaped paths such as `.env*`, `secrets/`, signing material,
SSH keys, `.claude/settings.local.json`, and credential-shaped content such as a private
key block or a GitHub token) lives in `xtask/guard/src/paths.rs` and
`xtask/guard/src/credentials.rs`; the pre-commit hook's staged guard enforces it.
Enforced by: `lefthook.yml` "staged guard". Never keep a second copy of that list, and
never read a secret-shaped file to check it.

What stays with you is what no pattern sees:

- a file whose name is innocent but whose content is secret: a real API key in
  `tauri.conf.json`, a TypeScript constant, or a test fixture; a signing script with a
  password inlined;
- a name containing `password` or `secret`, deliberately not a path rule because many
  legitimate files share the word: look at what the file holds;
- a webhook URL with an embedded token, or someone's personal data in a log or fixture;
- anything the user plainly did not mean to commit, secret or not.

Build output never lands either: `target/`, `dist/`, `coverage/`, `src-tauri/binaries/`,
`src-tauri/gen/` are gitignored, so one showing up as untracked means something is
wrong. Investigate it instead of committing it.

Exclude what fails these checks and tell the user. Everything else (source, tests,
config, docs) is committed: work in progress is safer in a commit than in a working
tree.

## Step 3: Group the changes

Each commit is one coherent change that builds and passes on its own. The story the log
tells matters more than the commit count: three related one-line edits are one commit.

| Change | Type |
|---|---|
| Rust under `crates/*/src/` or `src-tauri/src/`, TypeScript under `ui/src/` | `feat`, `fix`, `refactor`, or `perf` by what it does |
| Tests only (`crates/*/tests/`, `src-tauri/tests/`, `*.test.ts(x)`) | `test` |
| Docs (`*.md`, `.github/PULL_REQUEST_TEMPLATE.md` included, `docs/`, a skill) | `docs` |
| A dependency bump or addition | `deps` |
| `justfile`, `scripts/`, `lefthook.yml` | `build` |
| `.github/workflows/`, and `.github/zizmor.yml` (the workflow security linter's config) | `ci` |
| The rest of `.github/` that is not Markdown: issue forms, `labels.yml`, `rulesets/`, the Dependabot, Renovate, and release-notes config | `chore` |
| Tool config (`mise.toml`, `typos.toml`, `.claude/`, an editor file) | `chore` |

Where two rows match one file, the more specific row wins: a Markdown file is `docs`
wherever it lives (the PR template too), a test under `scripts/` is `test`, and a
skill's mirror under `.claude/skills/` is `docs`.

These always travel in one commit, whatever the grouping otherwise says:

- **A source change and its test.** This repository works test-first (`tdd`); a red test
  is never committed alone, and the pair takes the source change's type.
- **A manifest and its lockfile:** `Cargo.lock` with the `Cargo.toml` that moved it,
  `pnpm-lock.yaml` with the `package.json` that moved it. A lockfile committed apart
  from its manifest is a commit that does not build (`cargo` fails under `--locked`, and
  `pnpm install --frozen-lockfile` refuses the mismatch).
- **A skill and its mirror:** `.agents/skills/<name>/` with `.claude/skills/<name>/`
  after `just agents-sync`. The hook's skills-mirror job compares the two trees on
  disk, not what is staged, so it cannot catch a commit that stages only one side:
  stage both yourself.

## Step 4: Write the commits

Stage files by name, never `git add .` or `git add -A`: a blanket add is how an
untracked secret or an unrelated edit lands.

```bash
git add <file> <file>
git commit -m "<type>(<optional scope>): <summary>"
```

- Conventional Commits, with the types `.github/workflows/check-pr-title.yml` accepts:
  `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
  `revert`, `deps`. A squash merge makes the PR title the commit on `main`, so the same
  list governs both.
- Imperative mood, lowercase start, no final period, under 72 characters (no check
  enforces it; `create-pr` sets the same limit for the title); say what changed, not
  how. A scope, when one helps, is the area: `core`, `platform`, `shell`, `cli`, `ui`,
  `scripts`.
- A breaking change to a contract (a command or event name, a payload shape, an on-disk
  format) carries `!` after the type and says so in the body.

In the sample (a deletable illustration):

```text
feat(core): save the counter with the time it changed
fix(ui): keep the increment button disabled at the maximum
deps: bump tauri to 2.12 with @tauri-apps/api and @tauri-apps/cli
```

## Step 5: Push, only when asked

Push only when the user said so ("commit and push", "ship it"). Invoking this skill with
that request is the sign-off for pushing the commits it made to the current branch
(`AGENTS.md` › "Security and human approval", standing exceptions), and nothing else:
never a force push, never another branch. With "commit" alone, stop here; `create-pr`
pushes on its own.

```bash
git push                              # upstream already set
git push -u origin <current-branch>   # first push of the branch
```

## Step 6: Show the result

```bash
git status --short
git log --oneline -<number of new commits>
```

Report every file left uncommitted and why.

## When the pre-commit hook refuses

The hook only checks; it never rewrites a file, so a refused commit did not happen and
the staged files are still staged. Fix the cause, re-stage, and commit again with the
same message. Never `--no-verify`, never `--amend` a commit you did not make, and never
relax the rule that fired. **REQUIRED:**
[references/pre-commit-hook.md](references/pre-commit-hook.md), for the fix for each job.
