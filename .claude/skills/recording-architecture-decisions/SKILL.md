---
name: recording-architecture-decisions
description: >
  Covers the ADR tree under docs/architecture/: its README.md index and status legend,
  adr/template.md, and the numbered adr/NNNN-*.md records, including the design-lock
  ADR. Use when a change adds a crate or a port in myapp-core, changes the app shape (a
  window, or a menu-bar agent with ActivationPolicy::Accessory and a tray icon), the
  App Sandbox or Entitlements.plist, persistence (where and in what format state is
  kept), a new crate or npm dependency, a Tauri plugin or capability, the CSP,
  distribution (Developer ID, notarization, an updater, a universal build),
  minimumSystemVersion or rust-version, a TCC permission, a second UI locale, unsafe
  code, or the bundle identifier; when proposing, accepting, amending, rejecting, or
  superseding an ADR; when writing a version, an availability, or an Apple or Tauri
  fact into a document; or when deciding whether a change owes an ADR at all.
---

# Recording Architecture Decisions

**Owns:** `docs/architecture/`'s ADRs: whether a change owes an ADR or a status change,
an ADR's shape, numbering, and statuses, amending versus superseding, keeping the index
true, and how a fact is written into any of it. **Does not own:** which other surface a
change lands on, including `docs/architecture.md` and README's Design Philosophy
(`updating-docs`); `docs/architecture/roadmap.md` (`steering-the-roadmap`); how each
choice is made: the design lock (`designing-ui`), the app shape and sandbox posture
(`starting-an-app`), a system API and its permission (`integrating-system-apis`), a
dependency (`managing-dependencies`), a gate (`changing-gates`), a release path
(`releasing-the-app`); the decisions themselves, which are the ADRs.

## What the tree is for

- `docs/architecture/README.md` is the index: what the tree is for, the status legend,
  "How an ADR changes", "Adding an ADR", and one row per ADR with its status. It is the
  procedure's home; this skill adds the judgment around it.
- `docs/architecture/adr/template.md` is the shape every ADR copies.
- `docs/architecture/adr/NNNN-<kebab-case-title>.md` records one decision each.

`docs/architecture.md` describes the layers every app starts with (core, platform,
test-support, the helper, the shell, the UI). It is not an ADR and takes no status: when
an ADR moves a boundary it describes, the ADR records why, and `docs/architecture.md`
and `AGENTS.md` › Architecture are updated to describe the result in the same pull
request.

## The template or an app

The template ships the index empty on purpose: its own reasoning is README's Design
Philosophy, and ADRs belong to the apps cut from it. So:

- In the template itself, before the bootstrap has run (`README.md` still carries
  `<!-- template-only -->` blocks), a change that hits a trigger below updates README's
  Design Philosophy (`updating-docs`), never the ADR tree. Never seed the template's
  index with an ADR.
- In an app, the same change owes an ADR.

## When a change owes an ADR

A decision owes one when it is expensive to reverse, or when someone outside the change
will build on it. `AGENTS.md` › "Before changing the architecture" is the list, and the
last four entries below are ADR decisions other documents name (`docs/architecture.md`'s
contract table, `docs/architecture/README.md`, README's Design Philosophy, and the
comment on `tauri` in `Cargo.toml`); here is why each one is expensive:

- **A new crate, or a new port in core.** A crate fixes a dependency direction every
  later file obeys, and the boundary checks (`deny.toml`'s `wrappers`, the closure
  check) must learn it. A port fixes the contract its adapter, its fake, its contract
  function, and every caller are written against.
- **The app shape.** A window, or a menu-bar agent (`ActivationPolicy::Accessory`, the
  `tray-icon` feature, no Dock icon), changes startup, the window config, how the app is
  quit, and what the launch smoke and a human's check can see.
- **The sandbox posture.** The App Sandbox on or off, or any entitlement. It decides
  which APIs work at all, and whether the Mac App Store is open to the app, which
  requires the sandbox (https://developer.apple.com/documentation/security/app-sandbox,
  checked 2026-09-29).
- **Persistence.** Where state lives and in what format. Stored data outlives the code
  that wrote it, so a later change is a migration, and a format is contract
  (`docs/architecture.md` › "On-disk file formats").
- **A new crate or npm dependency.** Code the app now builds and runs; the review record
  `managing-dependencies` asks for is the evidence the ADR cites.
- **A Tauri plugin or capability, or relaxing the CSP.** Each widens what the WebView
  may reach; a plugin is a dependency and a capability at once.
- **Distribution.** Developer ID signing and notarization, an in-app updater, a
  universal (Intel) build. Each constrains signing, the release workflow, and support.
- **`minimumSystemVersion` or `rust-version`.** Raising the macOS floor drops users;
  raising `rust-version` narrows which crate releases resolve. Every later choice
  assumes the value.
- **A TCC permission** (Accessibility, Input Monitoring, Screen Recording, Full Disk
  Access, any other privacy grant). Each is a prompt the user must accept and a way the
  app can half-work.
- **A second UI locale.** Every later string owes a translation and a reviewer.
- **`unsafe` code**, which means lifting `unsafe_code = "forbid"` for `myapp-platform`.
  `forbid` is the strongest lint level: code cannot opt back in with `#[allow]` (E0453,
  https://doc.rust-lang.org/error_codes/E0453.html), which is why lifting it is a
  decision and not an edit (`integrating-system-apis`).
- **The bundle identifier**, once a build has left the machine: macOS keys the app's
  data, logs, and privacy grants by it, so a new one is a new app to macOS.
- **The design lock**: the app's own design direction, decided before its first screen.
  `designing-ui` owns its content (direction, references, decision ledger); it is filed
  here like any other ADR, usually as the app's first.
- **A CSS framework, a component library, or a state library**, which the template
  deliberately ships without.
- **A new Tauri major.** `tauri` stays on `2` until a migration ADR moves it.

A refactor inside a module, a test, a screen within the design lock, a rename that
crosses no boundary, or a fix that restores what an ADR already says owes none. Saying
so in the pull request is a legitimate outcome. The test: if a reviewer a year from now
would ask "why is it like this?" and the code cannot answer, the answer is an ADR.

An ADR records reasoning; it grants nothing. An entitlement, a signing change, a CSP
change, or a new dependency still needs the sign-off `AGENTS.md` › "Security and human
approval" asks for, whether or not an ADR exists.

## Shape and statuses

- Copy `adr/template.md` to `adr/NNNN-<kebab-case-title>.md` with the next free number,
  keep its section order, and write "None." under a heading with nothing to say rather
  than deleting it. Numbers start at `0001` and are never reused, even for a rejected
  proposal: a reader who saw "ADR-0004" in a pull request must always find the same one.
- An agent writes **Proposed**, names what acceptance needs, and edits a Proposed ADR
  freely until the owner decides. Only the owner moves it to **Accepted** or
  **Rejected**, as a one-line status edit with the date.
- An Accepted ADR takes small corrections in place (a re-checked fact, a clarified
  consequence, a follow-up that landed), each as an `Amended YYYY-MM-DD` line saying
  what changed. If the correction would change what was decided, it is not small.
- A replaced decision gets a new ADR that says what it replaces and why. The old one
  changes only its status line to `Superseded by ADR-NNNN`, with a link forward; its
  body stays as it was, so the reasoning that held at the time is still readable.
- A partly settled decision says which part is which ("Accepted: files under
  Application Support. Proposed: the JSON layout.").
- Add or update the ADR's row in `docs/architecture/README.md`'s Decisions table in the
  same change as the ADR.
- When an Accepted ADR and the code disagree, neither is quietly edited to match the
  other: the next change moves the code toward the ADR, or a new ADR changes the
  decision.

## Fact discipline

Keep four kinds of statement apart, in every file of the tree:

- **Verified fact**: a primary-source URL and "checked YYYY-MM-DD", listed under the
  ADR's Sources, and the author opened the page that day. The primary source is the
  tool's own: Tauri's documentation for a config key, a plugin, or a capability;
  docs.rs and crates.io for a crate's API, version, licence, and `rust-version`; the npm
  registry for a package; Apple's developer documentation for an API, an entitlement, a
  TCC rule, or notarization. Never fill it from memory.
- **Observed fact**: what a command showed on this Mac, written as "observed with
  `<command>`, YYYY-MM-DD" (a smoke run keeping focus, a crate's feature list in
  `cargo tree -e features`).
- **Decision or recommendation**: its reason and the options it beat.
- **Unverified**: prefixed `Unverified:` and listed under Open questions. It leaves that
  list only by being verified and cited, or by deleting the claim that needed it.

The facts an ADR here leans on move: the macOS version an API needs, what the sandbox
allows, a Tauri minor's behaviour, a crate's maintenance, the Developer Program fee. A
price carries its unit and date; an availability or a deprecation carries the OS or
crate version and date. One confidently wrong fact costs the credibility of every
correct one beside it.

## Public-repository hygiene

Nothing in the tree carries a Team ID, a certificate name, any `APPLE_*` value, an
Apple ID, an unannounced product name, a personal name or email, a path under a home
directory, or any user's data. Call the person who decides "the owner". The secret rules
are `AGENTS.md` › "Security and human approval"; this is their application to prose.

## Writing

English, per `AGENTS.md` › "Important Reminders". Spend words on trade-offs and on what
the code cannot say. Name a symbol, a crate, or a config key (`bundle.macOS.entitlements`
in `tauri.conf.json`) rather than a `path:line`, which rots with the next edit. Keep
sketches small enough to check by eye (a trait, a key layout, an entitlement list):
nothing compiles a fenced block in a document. **BACKGROUND:** `updating-docs`, whose
"What belongs in prose" applies here unchanged. Run `mise exec -- typos
docs/architecture` before committing; nothing formats Markdown.
