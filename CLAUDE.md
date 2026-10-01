@AGENTS.md

# Claude Code Specifics

The shared, tool-agnostic instructions are in `AGENTS.md`, imported above. This file
only records what Claude Code adds on top of them.

- **Rules load by path.** `.claude/rules/*.md` apply while you touch a file matching
  their `paths:` globs (`AGENTS.md` › Rules lists them). They restate nothing a gate
  already enforces; the gate's config is the source of truth.
- **Permissions and the format hook are personal.** This repository commits no
  `.claude/settings.json`: which commands run without a prompt, and whether
  `cargo xtask format-edited-file` runs as a `PostToolUse` hook after each edit, are each
  person's choice in `~/.claude/settings.json` or the gitignored
  `.claude/settings.local.json`. `AGENTS.md` › "Enforcement layers" says what such a
  file should keep at `ask` and how to register the hook, and › "Security and human
  approval" says when you may edit one: only when the owner asks for it in that session.
- **Sub-agent tiers.** `.claude/agents/` defines `executor` (`opus`, low effort),
  `architect` (`opus`, high effort), and `worker` (`sonnet`, medium effort); hand a
  step to one by `subagent_type`, never by a bare `model`. A same-named agent in
  `~/.claude/agents/` is shadowed by these inside this repository.
- **Skills** are read from `.claude/skills/`, a generated mirror of `.agents/skills/`:
  never hand-edit it; edit the authored copy and run `just agents-sync`.

When an instruction in `AGENTS.md` would block something that looks necessary, the
answer is to fix what made the bypass look necessary, or to ask. It is not to find
another spelling.
