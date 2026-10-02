# Release impact

The line every pull request body carries, and how to choose its level. `create-pr`
Step 4 links here.

## The line

Every pull request says whether it changes what a user of the tool gets, so a reviewer
can tell a deliberate "no release needed" from a decision nobody made.
`.github/PULL_REQUEST_TEMPLATE.md` carries the label `**Release impact:**` under the
Summary; replace the comment after it with one of these two forms, literally:

```text
**Release impact:** <MAJOR|MINOR|PATCH> -- <one line: what changes for a user, and why>.
**Release impact:** none -- <one line: why the installed tool does not change>.
```

A missing value is not `none`; ask for it before approving.

**none** fits a change that leaves the `myapp` binary a user installs untouched (it is
built from the checkout with `cargo install --locked --path crates/myapp`): CI
workflows, docs, tests, `xtask`, skills, harness checks, a dev-only dependency. A level
fits everything that changes that binary or what it reads and writes: Rust in
`myapp-core`, `myapp-platform`, or `myapp`, a runtime dependency, the release profile.

## Choosing the level

Nothing here is a published library, so the level is judged against what a user of the
tool already depends on, the contract in `docs/architecture.md` › "What is contract and
what is private":

- the command line: its subcommands and flags, what goes to stdout and what to stderr,
  and the exit codes (0 success, 1 a runtime error, 2 a usage error), which a person's
  scripts and scheduled jobs call and parse;
- the on-disk formats, such as `counter.json`, which an earlier version left on the
  user's disk;
- where the data and logs live, named by the bundle identifier on macOS and the XDG
  directory name on Linux;
- `rust-version`, the oldest Rust that builds the tool;
- the behavior a user sees, in a subcommand's output or on the TUI's screen.

Core's public API changes together with its callers in one pull request, so on its own
it never makes a release breaking.

| Change | Level |
|---|---|
| A new version cannot read a file an earlier version wrote | MAJOR |
| A subcommand, flag, or exit code is removed, renamed, or changes meaning | MAJOR |
| Output a script may parse changes shape, or moves between stdout and stderr | MAJOR |
| The data or log directory moves, leaving the user's data behind | MAJOR (and an ADR) |
| A user-visible feature, a new subcommand or flag, a new TUI key, or a new on-disk format version that still reads the old one | MINOR |
| `rust-version` goes up | MINOR, and say so in the line |
| A new privacy (TCC) permission the user will be asked for | MINOR, and say so in the line |
| A fix, a performance change, or a wording change (a stderr sentence, a TUI label) | PATCH |
| An internal refactor, or a runtime dependency bump, with no visible change | PATCH |

A pull request that touches several rows takes the highest: MAJOR over MINOR over PATCH.

Raising `rust-version` is MINOR, not MAJOR: Cargo's SemVer guide calls a new minimum
Rust "possibly-breaking" and recommends treating it as a minor change, since updating a
toolchain is usually easy
(https://doc.rust-lang.org/cargo/reference/semver.html#env-new-rust, checked
2026-10-02). The line still names it, so a user building with an older Rust is warned.

Decide from the table first, then from the version the tool is on (`version` in the root
`Cargo.toml`'s `[workspace.package]`). Below `1.0.0` a MAJOR change ships as a minor bump
and carries migration notes for the user in `CHANGELOG.md`; the line still names MAJOR,
so a reviewer sees the break rather than a minor bump that hides one.

The bundle identifier and the XDG directory name never change in a release: they name
the directories the tool keeps its data and logs in, so a new name leaves the user's
data behind under the old one. A pull request that changes either stops for a human and
an ADR.

## CHANGELOG.md

A user-visible change adds its entry under `[Unreleased]` in the same pull request, in
the Keep a Changelog section that fits (Added, Changed, Fixed, Removed, Security), in
terms of what a user observes rather than which files moved.
