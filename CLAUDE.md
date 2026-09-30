@AGENTS.md

# Claude Code Specifics

The shared, tool-agnostic instructions are in `AGENTS.md`, imported above. This file
only records what Claude Code adds on top of them.

- **Rules load by path.** `.claude/rules/*.md` apply while you touch a file matching
  their `paths:` globs (`AGENTS.md` › Rules lists them). They restate nothing a gate
  already enforces; the gate's config is the source of truth.
- **`.claude/settings.json` is committed and reviewed like code.** Its `allow` list
  covers the `just` recipes that neither open a window nor write to GitHub (a harness
  check keeps the others out), and read-only `gh`; its `deny` list refuses the hook
  bypasses (`git commit --no-verify`/`-n` and its abbreviations, `LEFTHOOK=0` and its
  siblings, `core.hooksPath`), force pushes, a second `-X`/`--method` on an allowed
  `gh api` read, `--web` on the allowed `gh` reads, and edits to
  `src-tauri/Entitlements.plist`. Its one `PostToolUse` hook runs
  `scripts/format-edited-file.ts` on the file an `Edit`/`Write`/`MultiEdit` touched
  (rustfmt for `.rs`, Prettier for `.ts`/`.tsx`) and reports a formatter failure back
  to you; the git hook and CI remain the gate. Personal permissions belong in
  `~/.claude/settings.json` or the gitignored `.claude/settings.local.json`, and editing
  either needs a human's sign-off (`AGENTS.md` › Security and human approval).
- **Sub-agent tiers.** `.claude/agents/` defines `executor` (`opus`, low effort),
  `architect` (`opus`, high effort), and `worker` (`sonnet`, medium effort); hand a
  step to one by `subagent_type`, never by a bare `model`. A same-named agent in
  `~/.claude/agents/` is shadowed by these inside this repository.
- **Skills** are read from `.claude/skills/`, a generated mirror of `.agents/skills/`:
  never hand-edit it; edit the authored copy and run `just agents-sync`.

When an instruction in `AGENTS.md` would block something that looks necessary, the
answer is to fix what made the bypass look necessary, or to ask. It is not to find
another spelling.
