# Implementation notes

<!-- template-only: scripts/bootstrap removes docs/template/ from a generated app. -->

What the first implementation run did differently from [design.md](design.md), and the
decisions it made that the design left open. Design decisions are never edited to match
what was built; each entry says what the design said, what was done, and why.

## Deviations

- **Tauri 2.11, not 2.12.** § 2 lists `tauri` 2.12.0 and `@tauri-apps/*` 2.12.0
  (published 2026-09-26). The repository's own 7-day release-age policy
  (`pnpm-workspace.yaml` `minimumReleaseAge`, design D8/D17) refuses a version that
  young, and the crate and npm minors must agree (a harness check). So the first run
  pins `tauri` 2.11.6 / `tauri-build` 2.6.3 in `Cargo.lock` (manifest `tauri = "2"`) and
  `@tauri-apps/api` ~2.11.1 / `@tauri-apps/cli` ~2.11.5. Dependabot brings 2.12 once it
  matures, as one grouped PR.
- **Other versions below § 2's list for the same reason:** vite 8.3.0, vitest 5.0.1,
  typescript-eslint 8.70.x, prettier 3.9.8, smol-toml 1.8.0 — each the newest release
  older than seven days on 2026-09-28.

## Decisions made during the run

- **pnpm reaches `PATH` through corepack.** mise pins Node (which ships corepack in
  the 24 line) and `package.json` pins pnpm once in `packageManager`, as D9 requires;
  `just install` runs `corepack enable pnpm` so no second pnpm pin exists. CI uses
  `pnpm/action-setup`, which reads the same field.
- **`trustPolicyExclude: semver@6.3.1`.** `eslint-plugin-react-hooks` 7 (required by
  D8) depends on `@babel/core`, which depends on `semver@6.3.1`, published before npm
  provenance existed; pnpm's `trustPolicy: no-downgrade` reads that as a downgrade from
  semver 7's attested releases. The exclusion names the exact version, so any other
  semver release is still checked. Dev-only lint path; nothing ships in the app.
