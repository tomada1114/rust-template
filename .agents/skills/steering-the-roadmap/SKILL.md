---
name: steering-the-roadmap
description: >
  Covers docs/architecture/roadmap.md, the app's Now / Next / Later direction that sits
  between AGENTS.md's Product section and the issue backlog: what each horizon holds,
  who changes the page and when, and how open and on hold issues feed it. Use when asked
  what to work on next or for the app's plan, direction, or status, before choosing an
  issue for shipping-issues, when every issue behind a Now outcome has closed, when the
  owner reorders, adds, defers, or drops an outcome, when parked on hold issues or
  requests from daily use start to cluster, when a Product section or ADR change moves
  the direction, or when filling in the roadmap skeleton after the bootstrap.
---

# Steering the Roadmap

**Owns:** `docs/architecture/roadmap.md`: what it holds (the Now, Next, and Later
horizons), who changes it and when, and how the open backlog and the parked `on hold`
issues feed it. **Does not own:** what the app is and its non-goals (`AGENTS.md` ›
"Product"); a label's meaning, a tier, or filing, parking, and promoting an issue
(`triaging-issues`, including its "Requests from daily use"); whether a change owes an
ADR and how one is written (`recording-architecture-decisions`); implementing and
merging an issue (`shipping-issues`).

## What the roadmap is for

The Product section says what the app is and is not, and changes rarely. The backlog
says what work exists, one issue at a time, and changes daily. Neither says which
outcomes come first, so without a roadmap the order is whatever the last session
remembered. The roadmap is that order, written down and re-read each time rather than
recalled.

It records direction and authorizes nothing. An issue is built because it is filed,
tiered, and picked, never because a roadmap line names it. A line that needs a decision
first says so, and the decision is made where it belongs.

## The template or an app

`roadmap.md` starts as a `TODO:` skeleton, as the Product section does. In the template,
which keeps its own direction in its issues, leave the page a skeleton. In an app, fill
it in right after the Product section is written; the first Now outcome is usually the
core interaction that section names. No check reads this page's `TODO:`
markers (the harness's Product check reads only `AGENTS.md`), so a leftover marker is
noticed only by the next person who opens the page.

## Horizons, not milestones

The page has three horizons and no dates:

| Horizon | Holds | Issues |
|---|---|---|
| Now | one to three outcomes being worked on, each with a "Done when" someone can observe | filed and tiered, one per pull request |
| Next | outcomes that follow, each naming what must happen before it moves up | optional; often parked as `on hold` |
| Later | intended direction, not yet ordered | none, apart from a parked issue a line names |

Horizons were chosen over milestones or numbered phases on purpose. A milestone carries
a date, and an app with one owner has no schedule to keep; a date that slips teaches
the reader to ignore the page. Phases need a label or a parent issue each to keep the
tracker in step, which is new vocabulary in `.github/labels.yml` and a second ordering
beside the tiers. A horizon needs neither: issues, tiers, and `on hold` already carry
everything it needs.

Write each entry as an outcome (what a user can do, or what is true of the app), not as
a task. "Done when" names something observable: a behavior of the running app, a `just`
recipe that passes, a release. An entry stays short and links issues by number; it never
copies an issue body, an ADR, or a Product line.

## Where each fact lives

| Fact | Home |
|---|---|
| What the app is, its core interaction, its non-goals | `AGENTS.md` › "Product" |
| Which outcomes come now, next, later | `docs/architecture/roadmap.md` |
| A unit of work, its tier, its `blocked:` or `on hold` label | the issue tracker (`triaging-issues`) |
| Why the architecture is the way it is | an ADR under `docs/architecture/` (`recording-architecture-decisions`) |
| What has shipped | `CHANGELOG.md` |

A fact in two homes drifts. When a roadmap edit is tempted to hold one of the others,
link it instead.

## Read the state first

Before recommending anything or editing the page, read the page and the open backlog as
they are now; both change between sessions.

```bash
gh issue list --state open --limit 200 --json number,title,labels
gh issue list --state open --label "on hold" --json number,title,labels
```

Then open the issues a Now outcome links (`gh issue view <n>`), and each parked issue's
comment giving its reason.

## How the backlog feeds it

**REQUIRED:** `triaging-issues`, for every issue filed, parked, promoted, or closed below.

- **A Now outcome's issues are all closed.** Check its "Done when" yourself with what
  an agent may run: the recipe, `just smoke`, `just logs`. When only the window can show
  it, ask the human to run `just run` (a human's recipe: it opens the app) and say what
  they saw (`AGENTS.md` › "Never taking over the developer's Mac"). If it holds, remove
  the entry (`CHANGELOG.md` already records what shipped) and propose the next outcome
  to move up. If it does not, the missing work is a new issue under that outcome, filed
  through `triaging-issues`, and the entry stays.
- **Now has no ready issue.** Everything left is blocked or parked. Say what clears it
  (a `blocked: design` choice, a `blocked: external` step only a person can take) before
  suggesting work from Next.
- **Parked issues cluster.** Several `on hold` issues pointing the same way, often
  requests from daily use, are evidence for a Next or Later line. Propose the line and
  link them; promoting or closing each issue stays `triaging-issues`' decision.
- **An outcome moves into Now.** Its work is filed as issues through `triaging-issues`;
  an issue parked because its line sat in Later loses `on hold` by that skill's
  "Promote" rule, since its reason no longer holds.
- **An outcome moves out of Now, or is dropped.** Its open issues are parked with the
  reason, or closed as not planned, through `triaging-issues`.

A roadmap move never re-tiers an issue by itself. Tiers rank impact on the rest of the
backlog, which is `triaging-issues`' judgment, and `shipping-issues` reads the labels,
not this page. The roadmap reaches the backlog only through which issues exist and which
are parked.

## When it changes, and who changes it

The owner decides what the roadmap says. An agent proposes: it edits the page in a pull
request that says what moved and why, and the owner's approval of that pull request is
the acceptance, as the owner's confirmation is what accepts a Proposed ADR. Never merge
a roadmap change the owner has not approved. Review the page when:

- a Now outcome's issues have all closed, or Now has no ready issue left;
- the owner asks what is next, or changes their mind about an outcome;
- a parked issue is promoted or closed, or parked issues start to cluster;
- the Product section changes, or an ADR is accepted, rejected, or superseded: a line
  that depended on it moves with it.

Update "Last reviewed" whenever the page is checked against the backlog, even when
nothing else moves.

Never, without the owner saying so:

- put an outcome in Now, reorder Now, or drop an outcome;
- add a line that contradicts a Product non-goal: that is a change to the Product
  section first, and a human's call;
- treat a line as the go-ahead for an architecture change: a line that hits a trigger in
  `AGENTS.md` › "Before changing the architecture" says "Before it moves up: an ADR"
  (**REQUIRED:** `recording-architecture-decisions` writes it).

## Answering "what is next?"

Lead with anything only the owner can clear, since nothing else moves until they act.
Then recommend one to three ready issues from Now's outcomes, each with its number and a
one-line reason, and ask the owner to pick. A pick outside Now is the owner's to make;
say which Now outcome it delays, then note it on the page if it changes the direction.

`shipping-issues` takes the pick from there, and invoking it authorizes every write it
makes, the merge included. Invoke it only on the owner's confirmed pick, never on this
skill's own recommendation.
