# Review checklist for a bot PR

Run every item against every PR before the plan in `merging-dependency-prs` Step 2. It is
the point of the approval gate, not a formality: green CI proves the new version builds
and passes the tests, not that it is the version anyone meant to trust.

## Release notes

- Read the release notes or changelog for every **major** bump and every **0.x minor**
  (the survey already reports a 0.x minor as `major`: below 1.0.0 a minor release is
  allowed to break, and Cargo's and npm's caret ranges treat it that way). Note removed
  APIs, a raised minimum Rust version (`rust-version` in `Cargo.toml` is `1.90`, and
  raising it is an ADR decision), a raised Node engine, and new lints.
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

A crate or npm package whose repository moved to another owner, an Action whose
repository was transferred, or a mise tool whose backend changed is held for the human
even when green. `cargo deny` (`deny.toml`'s `[sources]`) checks that crates come from
crates.io only, and the `Dependency Review` check covers licences and known
vulnerabilities on the PR; confirm both are green.

## Supply-chain settings stay as they are

A bot PR changes versions, nothing else. Hold one that touches `.github/dependabot.yml`'s
`cooldown`, `.github/renovate.json`'s `minimumReleaseAge`, `pnpm-workspace.yaml`
(`minimumReleaseAge`, `trustPolicy`, `strictDepBuilds`, `allowBuilds`), `deny.toml`,
`osv-scanner.toml`, or any other gate file. A new `allowBuilds` entry would let an npm
lifecycle script run on the developer's Mac at install time, so it is always the
human's call.

## Nothing new

A package in `Cargo.lock` or `pnpm-lock.yaml` that was not there before is a new
transitive dependency: name it in the plan. `just deny` and `mise exec -- cargo shear`
run on the combined branch.

## Code that runs at build time

A crate with a build script (`build.rs`) or a procedural macro runs its own code inside
`cargo build`, on the developer's Mac and on the CI runners, before any test has a say.
Review a version change to such a crate as code that runs, not as a data update. List
the crates that carry one:

```bash
cargo metadata --format-version 1 --locked --filter-platform aarch64-apple-darwin \
  | node -e 'const m = JSON.parse(require("fs").readFileSync(0, "utf8")); for (const p of m.packages) if (p.targets.some((t) => t.kind.some((k) => k === "custom-build" || k === "proc-macro"))) console.log(p.name, p.version);'
```

For each bumped crate on that list, read what changed in its `build.rs` or macro source
between the two versions (https://diff.rs/ shows a published crate's changes between
versions, checked 2026-09-29). A build script that starts fetching from the network,
writing outside `OUT_DIR`, or running a new program is held for the human. The list
holds `serde_derive`, `thiserror-impl`, `tauri`, and `tauri-macros` among about sixty
others (observed on this Mac with the command above, 2026-09-29), so a grouped cargo PR
almost always contains one.

## The Tauri family

- The survey's Tauri section says `aligned` for every pair the batch moves, or the
  combined branch moves the missing side (`merging-dependency-prs` "The Tauri rule").
- A Tauri major is held and becomes a migration issue; it is never merged in a batch.
- A new `tauri-plugin-*` crate or `@tauri-apps/plugin-*` package appearing in a bump is
  a new dependency and a new capability, not a bump: stop and ask.

## Security updates

Dependabot's cooldown applies only to version updates, never to security updates
(https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference,
checked 2026-09-29), so a security PR can propose a version younger than the 7 days pnpm
enforces. See `failure-modes.md` (F3 there) for what to do.
