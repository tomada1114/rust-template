---
name: starting-an-app
description: >
  Covers turning this template into a new app and its first decisions: just bootstrap
  (cargo xtask bootstrap), its prompts or flags (display name, slug, bundle identifier,
  owner/repo, author, copyright holder), the placeholders it rewrites (MyApp, myapp,
  myapp-core, myapp_core, com.example.myapp), just verify-bootstrap and the
  Template Bootstrap Smoke job; AGENTS.md's Product section and the roadmap; the tool's
  shape, subcommands only or subcommands plus the myapp tui screen; where it keeps state
  and the first ADRs; removing the sample counter; installing it with just install-cli;
  just labels, just ruleset, the GitHub security settings, and private-repository
  steps. Use when starting an app from this repository, running or changing the
  bootstrap, a placeholder survived the rename, just check-harness fails on the Product
  section, or setting up a repository created from the template.
---

# Starting an App

**Owns:** the order of work from "Use this template" to an app's first feature: the
bootstrap, the Product section and roadmap as steps, the tool's shape, where it keeps
state, the first ADRs, removing the sample, installing the tool, and the new
repository's GitHub setup. **Does not own:** how a task or script is written
(`writing-repo-scripts`); what the roadmap says (`steering-the-roadmap`); how an ADR is
written (`recording-architecture-decisions`); a subcommand's shape (`designing-clis`);
the full-screen view (`building-tuis`); a system API or TCC permission
(`integrating-system-apis`); what a gate may contain (`changing-gates`); README's prose
(`updating-docs`).

README's "Using This Template" is the reader-facing list of the steps below, in the same
order; the bootstrap removes that section with the rest of the template-only material,
so this skill is where an app still finds them.

## The order

1. **Create and clone.** "Use this template" on GitHub, clone, `mise trust`, then
   `just install`.
2. **Rename.** `just bootstrap` rewrites the repository, so it is a human's step (an
   agent runs it only when asked). It prompts for, or takes as flags, the display name
   (`MyApp`), the slug used for crate and binary names (`myapp`), the bundle identifier
   (`com.example.myapp`), the GitHub `owner/repo`, the author, and the copyright holder.
   It needs step 1's `just install`. **REQUIRED:**
   [references/bootstrap.md](references/bootstrap.md), for its flags, defaults, and
   validation, before running it, changing it, or chasing a leftover placeholder.
3. **Commit the rewrite**: review it (`git status`, `git diff`), and commit it as one
   commit before editing anything, so the rename stays one reviewable diff.
4. **Write `AGENTS.md`'s `## Product` section**: what the app is and who it is for, the
   core interaction, the non-goals, and where those decisions are recorded. The owner
   decides every line; an agent drafts only from what the owner has said. Delete each
   `TODO:` as it is replaced: once the bootstrap has run, `just check-harness` (and so
   `just check`) fails while one is left. Write it before any feature: without it, an
   agent picking up an issue has no in-repo answer to "is this in scope?", and a
   non-goal nobody wrote down is one an eager implementer reads as a feature.
5. **Fill `docs/architecture/roadmap.md`**: the Now, Next, and Later outcomes that follow
   from the Product section, with `steering-the-roadmap`. Nothing checks that page, so
   its `TODO:` lines stay until someone replaces them.
6. **Verify and push**: `just check`, then commit the Product section and roadmap and
   push both commits to `main`, which takes a direct push until step 10's ruleset.
   Pushing is a remote write: a human's step, or an agent's with the owner's sign-off.
7. **Labels**: `just labels` creates `.github/labels.yml`'s labels on the new
   repository. Run it before the first issue is filed from a form, so every label the
   forms apply exists. Dependabot skips a label `.github/dependabot.yml` names that the
   repository lacks (`AGENTS.md` › "GitHub settings a new repository must enable" has
   the source), so add `dependencies` by hand to any Dependabot pull request opened
   before this step. It writes to GitHub: a human's step, or an agent's with the
   owner's sign-off.
8. **Security settings and the Renovate App**, turned on by the repository's admin:
   `AGENTS.md` › "GitHub settings a new repository must enable".
9. **Replace the sample** with the app, in the order of the sections below: the tool's
   shape, where it keeps state, the first ADRs, then removing the sample.
10. **Ruleset, last**: once the bootstrap commit is on `main`, a repository admin runs
    `just ruleset`, which applies `main.json` and the `release-tags` tag ruleset. From
    then on every change needs a pull request with the required checks green, so the
    ruleset must name only jobs the app still runs. On a **private repository**, first
    **REQUIRED:** [references/private-repository.md](references/private-repository.md).

## Choose the tool's shape

Every app starts with both front ends over one core: subcommands
(`myapp counter show`) for a script, a scheduled job, or a quick look, and `myapp tui`
for a person who sits in front of the tool. Decide before the first feature which the
app needs, and write it into the Product section's core interaction:

- **Subcommands only**, for a tool that is scripted or scheduled: remove the `tui`
  subcommand, `crates/myapp/src/tui/`, and core's screen types (`CounterScreen`,
  `ScreenAction`, `ScreenKey`), drop `ratatui` from `crates/myapp/Cargo.toml`, and,
  since no other member uses it, its entry in the root `Cargo.toml`'s
  `[workspace.dependencies]` (crossterm has no entry of its own: the binary reaches it
  as `ratatui::crossterm`). `mise exec -- cargo shear` confirms nothing is left unused
  (`managing-dependencies` › "Removing one"). Removing a dependency needs no sign-off;
  adding one back does.
- **Subcommands and a screen**, for a tool someone works in: keep both, with the
  screen's state and key table in core and only the loop and drawing in the binary
  (`building-tuis`). A screen never replaces the subcommands: they are what a script
  and the binary's tests reach.

A configuration file, an environment variable the tool reads, or a `--json` form of its
output is part of its command-line contract (`designing-clis`); a settings file is an
ADR too (below).

## Decide where it keeps state

The sample keeps `counter.json` where each system expects an app's data:
`~/Library/Application Support/<bundle identifier>/` on macOS and
`$XDG_DATA_HOME/<slug>/` on Linux (`crates/myapp-platform/src/paths.rs`), with logs
beside them. The bundle identifier and the slug the bootstrap set key those
directories, so they are fixed once the tool has run anywhere a user's data lives.
Decide the app's own files — where, in what format, with what version field — as soon
as it keeps state of its own, and record it as an ADR. A privacy (TCC) permission the
tool will need on macOS is decided here too, each its own ADR
(`integrating-system-apis`).

## Record the first ADRs

Write each as Proposed (only the owner accepts), in `docs/architecture/adr/` with its row
in `docs/architecture/README.md`, per `recording-architecture-decisions`: persistence
(where and in what format the tool keeps state) as soon as it keeps state of its own,
each new crate the first features need, any TCC permission, and any platform the tool
adds or drops beyond macOS and Linux. Every external claim in them carries its URL and
the date it was checked.

## Remove the sample

The counter is a deletable illustration, not the app. The checklist is
`docs/getting-started.md` › "Removing the example code": it lists every file that holds
the sample and the search that ends it. On top of it:

- delete or rewrite what the skills under `.agents/skills/` give the counter as an
  example: the sample appears as its own "In the sample" sentences, parentheticals, code
  blocks, or a table column (`integrating-system-apis`), each of which can be deleted or
  rewritten with the app's own names while the rule around it stands. Two files are
  the sample's worked examples throughout and are rewritten with the app's own first
  command, use case, and tests rather than deleted: `writing-tests/references/patterns.md`
  and `tdd/SKILL.md` Steps 1-3. Then run `just agents-sync`;
- replace the core module and its tests in the same pull request that removes them, so
  the core coverage floor still measures real code.

Keep what is general: the `Clock` port and `SystemClock`, logging and its directories,
the binary's `compose` and exit-code convention, the wording module's shape, and, for a
tool with a screen, the TUI's enter, leave, and panic-hook code.

## Install it

There is no release pipeline: the tool is built and installed from its checkout with
`just install-cli` (`cargo install --locked --path crates/myapp`), which writes to
`~/.cargo/bin` outside the checkout, so it is a human's step. Reaching other people —
a release workflow, prebuilt or signed binaries, a tap, crates.io — is an ADR and a
sign-off change (`AGENTS.md` › "Security and human approval"), not a setup step.

## What the new app keeps

Everything about the repository rather than the application survives unchanged, and is
most of what starting from this template buys: the `justfile` and `xtask/`, every
workflow except the template-only bootstrap job, the pre-commit hook and its staged
guard, the skills and rules (drop a skill only when its subject leaves the repository,
with its row in `AGENTS.md`'s Skills table), the label set, and the ruleset. A red check
early in a new app is an argument for fixing the code, never for deleting the check.
