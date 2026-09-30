---
name: starting-an-app
description: >
  Covers turning this template into a new app and its first decisions: just bootstrap
  (scripts/bootstrap.ts), its prompts or flags (display name, slug, bundle identifier,
  owner/repo, author, copyright holder), the placeholders it rewrites (MyApp, myapp,
  myapp-core, MYAPP_SMOKE, com.example.myapp), scripts/verify-bootstrap.ts and the
  Template Bootstrap Smoke job; AGENTS.md's Product section and the roadmap; the design
  system first (design-lock ADR, ui/src/design/tokens.css); the app shape, a window or
  a menu-bar agent (ActivationPolicy::Accessory, tray-icon, no Dock icon); the sandbox
  posture; the first ADRs; removing the sample counter; just labels, just ruleset, the
  GitHub security settings, and private-repository steps. Use when starting an app from
  this repository, running or changing the bootstrap, a placeholder survived the
  rename, just check-harness fails on the Product section, or setting up a repository
  created from the template.
---

# Starting an App

**Owns:** the order of work from "Use this template" to an app's first feature: the
bootstrap, the Product section and roadmap as steps, the design-system-first rule, the
app shape, the sandbox posture, the first ADRs, removing the sample, and the new
repository's GitHub setup. **Does not own:** how a script is written
(`writing-repo-scripts`); the design direction itself (`designing-ui`); what the
roadmap says (`steering-the-roadmap`); how an ADR is written
(`recording-architecture-decisions`); a system API or TCC permission
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
3. **Commit the rewrite**: `just install` again (the rename changed `package.json`'s
   name, and pnpm runs nothing until the next install), review the rewrite
   (`git status`, `git diff`), and commit it as one commit before editing anything, so
   the rename stays one reviewable diff.
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
   push both commits to `main`, which takes a direct push until step 11's ruleset.
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
9. **Replace the sample** with the app, in the order of the sections below: design
   system, app shape, sandbox posture, the first ADRs, then removing the sample.
10. **Release secrets**, only for Developer ID signed and notarized releases
    (`releasing-the-app`); without them releases are ad hoc.
11. **Ruleset, last**: once the bootstrap commit is on `main`, a repository admin runs
    `just ruleset`. From then on every change needs a pull request with the required
    checks green, so the ruleset must name only jobs the app still runs. On a **private
    repository**, first **REQUIRED:**
    [references/private-repository.md](references/private-repository.md).

## Decide the design system first

Before the app's first screen, decide its own design system, because every screen
written against the template's neutral tokens is one to restyle later. Research the
direction with the `refero-design` skill when the session has it (it is a user-level
skill, not part of this repository, and nothing here depends on it); otherwise use
`designing-ui`'s own research steps. Record the outcome as the app's design-lock ADR
(`docs/architecture/adr/NNNN-design-lock.md`: direction, references, decision ledger),
usually its first. Apply it by replacing values in `ui/src/design/tokens.css` and, where
the direction needs it, the primitives, keeping every token's role name, never by
styling a screen directly. The literal check and the contrast test hold for the app's
tokens exactly as for the base, so `just test-ui` and `just check-harness` prove the
replacement. **REQUIRED:** `designing-ui` for the lock's content and the token edits.

## Choose the app shape

The template ships a windowed app: a Dock icon, an app menu, and a main window that
startup shows. The other common shape is a menu-bar agent: no Dock icon and no app menu,
a tray icon as its whole surface, and a window only when the tray opens one. Decide
before the first feature: the shape touches startup, the window config, how the app is
quit, and what anyone can check of it, and it is an ADR.
[references/app-shapes.md](references/app-shapes.md) has both shapes side by side and
the changes an agent shape needs, including keeping the smoke run invisible.

## Decide the sandbox posture

The App Sandbox is off, Tauri's default (`docs/distribution.md` › "The App Sandbox is
off"), so that an app can reach what the sandbox forbids, such as writing
`~/Library/LaunchAgents` and running `launchctl` to manage launchd jobs. The sandbox
limits an app to the resources its entitlements request, and the Mac App Store requires
it (https://developer.apple.com/documentation/security/app-sandbox, checked 2026-09-29),
so judge by what the new app must reach: another app, global input, or files and system
tools the user never chose each have to be found on that entitlement list before the app
can be sandboxed. It stays off unless the new app can live inside it; turning it on, or
adding any entitlement, is an edit to `src-tauri/Entitlements.plist`, which only a human
makes (`AGENTS.md` › "Security and human approval"). Propose it with the reason and let
the owner decide. A privacy (TCC) permission the app will need is decided here too, each
its own ADR (`integrating-system-apis`).

## Record the first ADRs

Write each as Proposed (only the owner accepts), in `docs/architecture/adr/` with its row
in `docs/architecture/README.md`, per `recording-architecture-decisions`: the design
lock, the app shape (window or menu-bar agent, and why), and the sandbox posture (and
any entitlement or TCC permission it implies). Persistence gets one as soon as the app
keeps state of its own. Every external claim in them carries its
URL and the date it was checked.

## Remove the sample

The counter is a deletable illustration, not the app. The checklist is
`docs/getting-started.md` › "Removing the example code": it lists every file that holds
the sample, the `log_from_ui` wiring and tests to keep, and the search that ends it. On
top of it:

- delete or rewrite what the skills under `.agents/skills/` give the counter as an
  example: the sample appears as its own "In the sample" sentences, parentheticals, code
  blocks, or a table column (`integrating-system-apis`), each of which can be deleted or
  rewritten with the app's own names while the rule around it stands. Three files are
  the sample's worked examples throughout and are rewritten with the app's own first
  command, use case, and tests rather than deleted:
  `designing-ipc/references/adding-a-command.md`, `writing-tests/references/patterns.md`,
  and `tdd/SKILL.md` Steps 1-3. Then run `just agents-sync`;
- replace the core module and its tests in the same pull request that removes them, so
  the core coverage floor still measures real code.

Keep what is general: the `Clock` port and `SystemClock`, `UiLogEntry` and the
`log_from_ui` command with its registration and tests, logging, smoke mode, and the
design primitives.

## What the new app keeps

Everything about the repository rather than the application survives unchanged, and is
most of what starting from this template buys: the `justfile` and `scripts/`, every
workflow except the template-only bootstrap job, the pre-commit hook and its staged
guard, the skills and rules (drop a skill only when its subject leaves the repository,
with its row in `AGENTS.md`'s Skills table), the label set, and the ruleset. A red check
early in a new app is an argument for fixing the code, never for deleting the check.
