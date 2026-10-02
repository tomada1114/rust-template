---
name: recording-architecture-decisions
description: >
  Covers the ADR tree under docs/architecture/: its README.md index and status legend,
  adr/template.md, and the numbered adr/NNNN-*.md records. Use when a change adds a
  crate to the workspace or a port in myapp-core, changes persistence or configuration
  (where and in what format the tool keeps state, a settings file or environment
  variable it reads), adds a crate dependency, adds or drops a target platform, adds
  distribution (a release workflow, prebuilt or signed binaries, a package-manager tap,
  crates.io publishing, an updater), raises rust-version, needs an OS privacy (TCC)
  permission, lifts unsafe_code = "forbid", changes the bundle identifier or XDG
  directory name, adds a second language for the wording or a TUI theme beyond the
  terminal's colors, or replaces clap or ratatui or moves either to a new major; when
  proposing, accepting, amending, rejecting, or superseding an ADR; when writing a
  version or an availability fact into a document; or when deciding whether a change
  owes an ADR at all.
---

# Recording Architecture Decisions

**Owns:** `docs/architecture/`'s ADRs: whether a change owes an ADR or a status change,
an ADR's shape, numbering, and statuses, amending versus superseding, keeping the index
true, and how a fact is written into any of it. **Does not own:** which other surface a
change lands on, including `docs/architecture.md` and README's Design Philosophy
(`updating-docs`); `docs/architecture/roadmap.md` (`steering-the-roadmap`); how each
choice is made: CLI-only or CLI and TUI (`starting-an-app`), a system API and its
permission (`integrating-system-apis`), a dependency (`managing-dependencies`), a gate
(`changing-gates`); the decisions themselves, which are the ADRs.

## What the tree is for

- `docs/architecture/README.md` is the index: what the tree is for, the status legend,
  "How an ADR changes", "Adding an ADR", and one row per ADR with its status. It is the
  procedure's home; this skill adds the judgment around it.
- `docs/architecture/adr/template.md` is the shape every ADR copies.
- `docs/architecture/adr/NNNN-<kebab-case-title>.md` records one decision each.

`docs/architecture.md` describes the layers every app starts with (core, platform,
test-support, and the `myapp` binary with its subcommands and TUI). It is not an ADR and takes no status: when
an ADR moves a boundary it describes, the ADR records why, and `docs/architecture.md`
and `AGENTS.md` › Architecture are updated to describe the result in the same pull
request.

## The template or an app

The index starts empty on purpose: the reasoning behind the layers every app starts with
is README's Design Philosophy, and an ADR records only what an app decides on top of
them. So:

- In the template itself, before the bootstrap has run (`README.md` still carries
  `<!-- template-only -->` blocks), a change that hits a trigger below updates README's
  Design Philosophy (`updating-docs`), never the ADR tree. Never seed the template's
  index with an ADR.
- In an app, the same change owes an ADR.

## When a change owes an ADR

A decision owes one when it is expensive to reverse, or when someone outside the change
will build on it. `AGENTS.md` › "Before changing the architecture" is the list; here is
why each entry is expensive:

- **A new crate in the workspace, or a new port in core.** A crate fixes a dependency
  direction every later file obeys, and the boundary checks (`deny.toml`'s `wrappers`,
  the closure check) must learn it. A port fixes the contract its adapter, its fake, its
  contract function, and every caller are written against.
- **Persistence or configuration.** Where state lives and in what format, or a settings
  file or environment variable the tool reads. Stored data outlives the code that wrote
  it, so a later change is a migration, and a format is contract
  (`docs/architecture.md` › "On-disk file formats"). A setting is an interface users and
  their scripts come to depend on, and it reaches core only as an argument the
  composition root reads, never from core itself.
- **A new crate dependency**, runtime or dev. Code the tool now builds and runs; the
  review record `managing-dependencies` asks for is the evidence the ADR cites.
- **A new target platform, or dropping one** (Windows, another architecture).
  `deny.toml`'s `[graph] targets`, CI's jobs, and every adapter's `cfg(target_os)` arms
  and contract runs follow the target list, and dropping a target strands its users.
- **Distribution.** A release workflow, prebuilt or signed binaries, a package-manager
  tap, crates.io publishing, an updater. Today the tool is installed from its checkout
  with `cargo install --locked --path crates/myapp` and `publish = false`; each of these
  adds a secret, a workflow that writes, and a promise to support what was shipped.
- **`rust-version` in `Cargo.toml`.** Raising it narrows which crate releases resolve
  and who can build the tool; every later choice assumes the value.
- **An OS privacy permission** (TCC on macOS: Accessibility, Input Monitoring, Full Disk
  Access, any other privacy grant). Each is a prompt the user must accept and a way the
  tool can half-work (`integrating-system-apis`).
- **`unsafe` code**, which means lifting `unsafe_code = "forbid"` for `myapp-platform`.
  `forbid` is the strongest lint level: code cannot opt back in with `#[allow]` (E0453,
  https://doc.rust-lang.org/error_codes/E0453.html), which is why lifting it is a
  decision and not an edit (`integrating-system-apis`).
- **The bundle identifier or the XDG directory name** (`com.example.myapp` and `myapp`
  until the bootstrap renames them), once a build has left the machine: they name the
  data and log directories (`~/Library/Application Support/com.example.myapp/` on macOS,
  `$XDG_DATA_HOME/myapp` on Linux), so a new name leaves every user's data and logs
  behind under the old one.
- **A second language for the tool's wording.** Every later sentence in
  `crates/myapp/src/wording.rs` owes a translation and a reviewer, and the tool must
  choose a language at startup.
- **A TUI theme beyond the terminal's own colors.** The TUI draws in the terminal's own
  foreground and background, so it reads in a light, dark, or monochrome terminal
  (`building-tuis`). Fixed colors must be checked against all three, and every later
  screen inherits them.
- **Replacing clap or ratatui, or moving either to a new major version.** Every
  subcommand, or every screen, is written against it. A minor bump of `ratatui`, which
  is below `1.0`, is a migration `merging-dependency-prs` lands, not an ADR.

A refactor inside a module, a test, a screen drawn in the existing style, a rename that
crosses no boundary, or a fix that restores what an ADR already says owes none. Saying
so in the pull request is a legitimate outcome. The test: if a reviewer a year from now
would ask "why is it like this?" and the code cannot answer, the answer is an ADR.

An ADR records reasoning; it grants nothing. A release pipeline, a permission grant, or
a new dependency still needs the sign-off `AGENTS.md` › "Security and human approval"
asks for, whether or not an ADR exists.

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
- A partly settled decision says which part is which ("Accepted: one JSON file in the
  data directory. Proposed: its field layout.").
- Add or update the ADR's row in `docs/architecture/README.md`'s Decisions table in the
  same change as the ADR.
- When an Accepted ADR and the code disagree, neither is quietly edited to match the
  other: the next change moves the code toward the ADR, or a new ADR changes the
  decision.

## Fact discipline

Keep four kinds of statement apart, in every file of the tree:

- **Verified fact**: a primary-source URL and "checked YYYY-MM-DD", listed under the
  ADR's Sources, and the author opened the page that day. The primary source is the
  tool's own: docs.rs and crates.io for a crate's API, version, licence, and
  `rust-version`, and its changelog for a breaking change; the Cargo and rustc books
  for a manifest key or a lint; Apple's developer documentation for a macOS API or a TCC
  rule; the freedesktop.org XDG Base Directory specification for a Linux directory.
  Never fill it from memory.
- **Observed fact**: what a command showed on this machine, written as "observed with
  `<command>`, YYYY-MM-DD" (a crate's feature list in `cargo tree -e features`, where a
  scratch-`HOME` run wrote its files).
- **Decision or recommendation**: its reason and the options it beat.
- **Unverified**: prefixed `Unverified:` and listed under Open questions. It leaves that
  list only by being verified and cited, or by deleting the claim that needed it.

The facts an ADR here leans on move: the macOS version an API needs, what a ratatui
minor changed, a crate's maintenance, a platform's default directory, a service's fee.
A price carries its unit and date; an availability or a deprecation carries the OS or
crate version and date. One confidently wrong fact costs the credibility of every
correct one beside it.

## Public-repository hygiene

Nothing in the tree carries a secret or any value of one, a signing identity or
certificate name, an account ID, an unannounced product name, a personal name or email,
a path under a home directory, or any user's data. Call the person who decides "the owner". The secret rules
are `AGENTS.md` › "Security and human approval"; this is their application to prose.

## Writing

English, per `AGENTS.md` › "Important Reminders". Spend words on trade-offs and on what
the code cannot say. Name a symbol, a crate, or a config key (`[graph] targets` in
`deny.toml`) rather than a `path:line`, which rots with the next edit. Keep sketches
small enough to check by eye (a trait, a file layout, a list of subcommands):
nothing compiles a fenced block in a document. **BACKGROUND:** `updating-docs`, whose
"What belongs in prose" applies here unchanged. Run `mise exec -- typos
docs/architecture` before committing; nothing formats Markdown.
