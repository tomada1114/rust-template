# When the pre-commit hook refuses a commit

The detail behind `smart-commit`'s last section.

`lefthook.yml` defines the pre-commit hook, installed by `just install` and checked by
`just verify-hooks`. Its jobs run in parallel over the staged files and only check:
none rewrites a file, so a failure leaves the commit unmade and the index as it was. The
skill does not re-run these checks itself; it reacts to the one that failed.

## Recovery, whatever failed

1. Read which job failed and its first error line.
2. Fix the cause in the file (the table below).
3. Re-stage exactly the files you fixed: `git add <file>`.
4. Commit again, same message.

Never `git commit --no-verify` or `-n`: `AGENTS.md` › "Security and human approval"
forbids them for every author, whatever a personal permission file allows. Never
`--amend` a commit someone else made to fold a fix in.

## Each job

| Job | Typical failure | Fix |
|---|---|---|
| staged guard (`scripts/check-staged.ts`) | `ERR_STAGED_BLOCKED_PATH`: a secret-shaped path is staged | `git restore --staged <path>`, tell the user, and leave the file out. Do not open it to look. |
| staged guard | `ERR_STAGED_CREDENTIAL_SHAPED`: a staged blob looks like a credential | Unstage the file and tell the user which file and rule the guard named. If the value is a real secret, the user rotates it; if it is a test value shaped like one, the user decides how the fixture should look. Never edit the guard's patterns to let it through. |
| rustfmt | a staged `.rs` file is not formatted | `just fmt`, then re-stage the file |
| prettier | a staged TypeScript, JSON, CSS, or YAML file is not formatted | `just fmt`, then re-stage |
| eslint | a lint error in a staged TypeScript file | `just fix` for what is auto-fixable, then fix the rest by hand. Never an `eslint-disable` comment, which `AGENTS.md` counts as weakening a gate. |
| typos | a misspelling in a staged file | Correct the word. A real identifier the tool does not know (a crate name, a macOS term) is a `typos.toml` change, which is a gate change for a human to approve (`changing-gates`), not something to add on the way past. |
| skills mirror | the staged `.agents/skills/` and `.claude/skills/` differ (it compares the index, so a synced but unstaged mirror still fails) | `just agents-sync`, then stage both trees |

`just fmt` formats every file in the repository, not only the staged ones. Re-stage
only what you meant to commit; leave any other file it touched for the user to see in
`git status`.

## What the hook does not run

No clippy, no compile, no test runs in the hook: those are `just check` and CI. A
commit the hook accepts can still fail `just lint` or `just test`, which is why
`create-pr` runs `just check` before opening a pull request.
