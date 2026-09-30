---
name: triaging-issues
description: >
  Covers this repository's issue vocabulary: the type, priority, blocked, on hold, and
  tracking labels declared in .github/labels.yml and synced by just labels, what
  priority: P0-P3, blocked: design, blocked: dependency, blocked: external, on hold,
  tracking, and security mean, and what an issue body must contain (a path:line such as
  crates/myapp-platform/src/paths.rs:31, an observable close condition, a Depends on #N
  line). Use when filing a GitHub issue, triaging or re-prioritizing the backlog,
  choosing between bug, enhancement, documentation, chore, and security, marking a
  tracking issue, editing .github/labels.yml or an issue form under
  .github/ISSUE_TEMPLATE/, running just labels, recording a problem found outside the
  task, or routing a friction or idea that came up while using the app.
---

# Triaging Issues

**Owns:** the issue vocabulary: the label taxonomy, what a priority means, and what an
issue body must contain. **Does not own:** implementing an issue (`shipping-issues`); the
roadmap's order of outcomes (`steering-the-roadmap`); a change to a gate file
(`changing-gates`); anything beyond the tracker.

Labels carry the triage decision, so it is made once and read back rather than
re-derived each time the backlog is looked at. An issue is filed with a type label and no
tier; triage adds the tier, and a `blocked:` label where one applies.

## Priority and readiness labels

| Label | When it applies |
|---|---|
| `priority: P0` | A real blocking chain (another open issue names this one as its blocker) or active damage (a red `main`, a live vulnerability, lost user data). Tier by what is blocked or broken, never by how urgent it feels. |
| `priority: P1` | Foundational work later issues will build on (CI, a core port, a shared type that crosses IPC, config), even before an issue names it as a dependency. Once one does, the chain usually makes it P0. |
| `priority: P2` | The default tier. Before leaving an issue here, check that it blocks nothing (P0) and is not groundwork (P1): P2 is not where unevaluated work is parked. |
| `priority: P3` | Genuinely low impact: nobody waits on it and nothing depends on it. Not a stand-in for "unappealing"; work that matters but is dull keeps its real tier. |
| `blocked: design` | The approach has real, unresolved alternatives a human must choose between, not merely that nobody has looked yet. It still gets a tier (below). |
| `blocked: dependency` | Only with a `Depends on #N` line in the body naming the blocker; without one the label cannot be verified or cleared. |
| `blocked: external` | The next step is one only a person can take: a Developer ID certificate or notarization credential, an Apple Developer account step, a purchase or accepted terms, a privacy (TCC) grant in System Settings. Never for something an agent can do with its own tools. `shipping-issues` never picks it. |
| `on hold` | Real work parked on purpose, with the reason in a comment. It keeps its tier; `shipping-issues` never picks it. Not for a tracking issue. |

Priority ranks impact on the rest of the backlog, not how interesting the work is.

Tier and readiness are independent. A `blocked: design` issue still gets a tier, so it
ranks correctly the moment the block clears; leaving it untiered means redoing the
judgment later, when nobody remembers it.

A wrong label is corrected, not worked around. Ranking around a stale label in your head
leaves the next reader to make the same mistake.

## Type labels

`bug`, `enhancement`, `documentation`, `chore`, and `security` are the issue types. The
forms under `.github/ISSUE_TEMPLATE/` apply one when the issue is filed:
`bug_report.yml` applies `bug`, `feature_request.yml` `enhancement`, and `task.yml`
`chore`. `config.yml` disables blank issues, so `documentation` and `security` are
applied by hand at triage.

`security` marks a security-relevant defect that is safe to discuss in public: a
hardening gap, a missing defense layer, a follow-up to an advisory that is already
fixed and published. A vulnerability someone could exploit today is never a public
issue: it goes through `SECURITY.md`'s private reporting route (a GitHub security
advisory), which `config.yml` links from the issue chooser. When unsure which it is, it
is the private route.

`ci` and `dependencies` are pull-request labels, never used for issues.
`.github/workflows/pr-label.yml` runs `scripts/label-pr.ts`, which labels a pull
request from its Conventional Commits title type (`feat` and `perf` give `enhancement`,
`fix` gives `bug`, `docs` gives `documentation`, `ci` gives `ci`, `deps` gives
`dependencies`, every other accepted type gives `chore`), removes a type label a retitle
left stale, and never creates a label. Dependabot applies `dependencies` itself, so the
script never removes that one. `.github/release.yml` files each of these labels, and
`security`, under a release-notes heading.

`tracking` marks a tracking issue: a checklist of sub-issues (`- [ ] #N`) whose own body
is never implemented. It takes a type label (usually `chore`) and no tier, since it
ranks nothing; each sub-issue carries its own tier and says `Part of #N`.
`shipping-issues` drops a `tracking` issue from ranking and selection.

`.github/labels.yml` is the source for the label set: name, color, and description. This
skill holds only what each label means for triage. A label is added or renamed there
first, then here; when the file and this skill disagree, fix the mismatch rather than
picking one. Of these labels only `bug`, `enhancement`, and `documentation` are GitHub
defaults
(https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels,
checked 2026-09-29), and an issue form's label that the repository lacks is not added
(https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms,
checked 2026-09-29). `just labels` (`scripts/sync-labels.ts`) creates or updates
every declared label and never deletes one; running it is a remote write that needs a
human's sign-off (`AGENTS.md` › "Security and human approval").

## What an issue body must contain

Two things nothing else can recover later:

- **What is wrong today, with a `path:line`.** A symptom without a location makes the
  next person re-find what the filer already knew. Point at the code, not the symptom:
  `crates/myapp-platform/src/paths.rs:31`, `src-tauri/src/commands.rs:58`,
  `ui/src/ipc/commands.ts:12`.
- **What observable result closes it**, as a command or a test: `just test-core` passes
  with a new test named for the behavior, `just check-harness` passes, a `grep` prints
  nothing, `just smoke` logs a line. Never a feeling of doneness ("works correctly", "is
  cleaned up"); a condition only the filer can judge cannot be verified by anyone else.

`task.yml`'s fields ask for exactly these; a hand-written body keeps the same two parts.

## Ordering constraints

Write an ordering constraint as `Depends on #N`, one per line under a `## Dependencies`
heading, with `Blocks #N` for the reverse edge. This is the spelling automation parses
(`shipping-issues` reads it, and `task.yml`'s `Depends on: #N` placeholder parses the
same); prose such as "after the logging work lands" is not machine-readable and is not
picked up.

An issue with a `Depends on` line also carries `blocked: dependency` while the blocker is
open. The label is not removed automatically when the blocker closes: whoever lands the
blocking issue clears it, by hand, from every issue that named it, in the same pull
request or right after it. It is nobody else's automated job.

## A problem found outside the task

`AGENTS.md` › "Important Reminders" says a problem found outside the task is recorded,
not fixed. Recording it means an issue with a type label, a `path:line`, and a close
condition as above; filing it is a remote write, so where that is not yours to do, list
it in the pull request description instead. Never widen the pull request to fix it.

## Requests from daily use

A friction or an idea that comes up while using the app is routed the moment it is
raised, so it is neither lost in a chat log nor shipped unreviewed. Filing is a remote
write. When the human explicitly asked for an issue, that request is the sign-off for
creating each issue it asks for and for comments on those issues in the same request
(`AGENTS.md` › "Security and human approval", standing exceptions). A friction the
human raises without asking for an issue was not explicitly asked for, any more than
one you noticed or inferred: draft the title, labels, and body in the reply and wait
for a yes. Pick one outcome:

1. **File it** when it stays inside the existing design (a default, a keyboard
   shortcut, copy, a small change to how an existing screen behaves) and is in scope
   under `AGENTS.md` › "Product". The request covers creating the issue and nothing
   more: a type label, a tier (`priority: P2` unless the table above says otherwise),
   and a body that meets "What an issue body must contain". Several requests in one
   message get one issue each, unless they are one pull request's worth. Report the
   numbers and stop; implementation waits until someone picks the issue.
2. **Park it** as `on hold` when it is worth keeping but not worth doing yet: it needs
   more use to judge, it leans on a Product non-goal, or it needs a design or
   architecture decision first. File it the same way, add `on hold`, and comment the
   reason and what would change the call. It keeps its tier.
3. **Drop it** without an issue when it contradicts a Product non-goal or duplicates an
   open issue (draft a comment for that one; posting it on an issue this request did not
   create waits for the human's yes). Say so in the reply, with the reason, so the
   decision is visible rather than silent.

A parked issue leaves the lane by a decision, never by age:

- **Promote** it by removing `on hold` once its reason no longer holds: the use it waited
  for happened, or the decision it needed was made. Re-check its tier; if a real choice
  remains, it may now want `blocked: design` instead.
- **Close** it as not planned when its reason became permanent: the app moved away from
  it, or a later issue superseded it (link that one).

Moving a request out of the Product non-goals is a human's call, not the triager's:
parking or dropping it records that line rather than crossing it.
