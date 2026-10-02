# Review checklist for a bot PR

Run every item against every PR before the plan in `merging-dependency-prs` Step 2. It is
the point of the approval gate, not a formality: green CI proves the new version builds
and passes the tests, not that it is the version anyone meant to trust.

## Release notes

- Read the release notes or changelog for every **major** bump and every **0.x minor**
  (the survey already reports a 0.x minor as `major`: below 1.0.0 a minor release is
  allowed to break, and Cargo's caret ranges treat it that way). Dependabot's
  `update-types` counts a 0.x minor as a minor
  (https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference,
  `groups` › `update-types`, checked 2026-09-30), so it arrives inside a
  `*-minor-and-patch` group, and the survey marks that bump `(major)`. Note removed APIs,
  a raised minimum Rust version (`rust-version` in `Cargo.toml` is `1.90`, and raising it
  is an ADR decision), and new lints.
- Where to find them: the PR body's release-notes section, or
  `gh release view <tag> --repo <owner>/<repo>`.

## GitHub Actions bumps

- Every non-local `uses:` stays a full 40-character SHA with a `# vX.Y.Z` comment, and
  the comment names the new tag. `just check-harness` fails otherwise; a PR that drops
  either is held, never fixed by loosening the check.
- The bump must not widen a job's `permissions:`, add a `secrets:` input, or change a
  trigger (never `pull_request_target`). Each is a gate change: stop and ask
  (`changing-gates`).
- The `Workflow Security Lint` job (zizmor) is green on the PR.

## Maintainer and source

A crate whose repository moved to another owner, an Action whose
repository was transferred, or a mise tool whose backend changed is held for the human
even when green. `cargo deny` (`deny.toml`'s `[sources]`) checks that crates come from
crates.io only, and the `Dependency Review` check covers licences and known
vulnerabilities on the PR; confirm both are green.

## Supply-chain settings stay as they are

A bot PR changes versions, nothing else. Hold one that touches `.github/dependabot.yml`'s
`cooldown`, `.github/renovate.json`'s `minimumReleaseAge`, `deny.toml`,
`osv-scanner.toml`, or any other gate file.

## Nothing new

A package in `Cargo.lock` that was not there before is a new
transitive dependency: name it in the plan. `just deny` and `mise exec -- cargo shear`
run on the combined branch.

## Code that runs at build time

A crate with a build script (`build.rs`) or a procedural macro runs its own code inside
`cargo build`, on the developer's machine and on the CI runners, before any test has a
say.
Review a version change to such a crate as code that runs, not as a data update. List
the crates that carry one:

```bash
cargo metadata --format-version 1 --locked \
  --filter-platform aarch64-apple-darwin --filter-platform x86_64-unknown-linux-gnu \
  | python3 -c 'import json, sys; [print(p["name"], p["version"]) for p in json.load(sys.stdin)["packages"] if any(k in ("custom-build", "proc-macro") for t in p["targets"] for k in t["kind"])]'
```

For each bumped crate on that list, read what changed in its `build.rs` or macro source
between the two versions (https://diff.rs/ shows a published crate's changes between
versions, checked 2026-09-29). A build script that starts fetching from the network,
writing outside `OUT_DIR`, or running a new program is held for the human. The list
holds `serde_derive`, `thiserror-impl`, and `clap_derive` among about thirty (observed
with the command above, 2026-10-02; the two targets are `deny.toml`'s `[graph]`
`targets`), so a grouped cargo PR almost always contains one.

## Migrations: ratatui, crossterm, clap

- A ratatui or crossterm minor (pre-1.0, so the survey marks it `(major)`), a clap major,
  or ratatui reaching 1.0 is a migration (`merging-dependency-prs` "Migrations: ratatui,
  crossterm, clap"), named as one in the plan however Dependabot grouped it.
- Read its changelog for what the binary crate's TUI module or its clap definitions
  use: a renamed or removed widget, style, or layout item; a changed default in how
  text, borders, or colors render; a change to crossterm's raw mode, alternate screen,
  or key-event reading; a derive attribute or parser behavior clap changed. Note which
  of these a `TestBackend` test covers and which only a real terminal shows.
- crossterm is reached only through `ratatui::crossterm`. A direct `crossterm`
  requirement in a manifest is a new dependency, not a bump: stop and ask. A
  `Cargo.lock` diff that leaves two crossterm versions behind is named in the plan.
- A clap major or ratatui 1.0 owes an ADR before it lands
  (`recording-architecture-decisions`); a pre-1.0 ratatui minor does not.

## Security updates

Dependabot's cooldown applies only to version updates, never to security updates
(https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference,
checked 2026-09-29), so a security PR can propose a version younger than 7 days. Name
the advisory, the version, and its publish date in the plan, and let the human choose
between landing it now and waiting out the remaining days.
