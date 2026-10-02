# Implementation notes

<!-- template-only: cargo xtask bootstrap removes docs/template/ from a generated app. -->

What the implementation runs did differently from [design.md](design.md), and the
decisions they made that the design left open. Design decisions are never edited to match
what was built; each entry says what the design said, what was done, and why.

The first run built the desktop-GUI stack the 2026-10-01 pivot removed (design.md § 1).
Its notes about that stack — the GUI framework's versions and licences, the Node
toolchain, the bindings generator, the launch smoke, the release scripts — went with it;
git history keeps them. What follows still holds for the command-line template.

## Deviations

- **Live labels are a superset of `labels.yml`.** After `just labels`, every declared
  label exists on the repository, and GitHub's defaults (`accessibility`, `duplicate`,
  `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`) remain beside them:
  the sync never deletes a label the manifest does not mention (as in both reference
  repositories), and deleting labels is outside the run's GitHub authority.
- **`just check` runs two more gates than D10 lists:** `lint-repo` (typos over the whole
  tree and actionlint) and `agents-check` (the skills mirror), placed after `lint`. CI
  already ran all three; running them locally too shrinks `just-check-matches-ci`'s
  exception list to what genuinely cannot run offline (cargo deny, zizmor's online audits)
  or has no local meaning.
- CI's `Repo Lint & Harness` job runs `cargo fetch --locked` before the script tests: the
  `core-boundary` check reads `cargo metadata --offline`, which needs the registry.

## Decisions made during the run

- **No cargo-deny advisory is ignored.** With `[graph] targets` set to the built triples
  and `unmaintained = "workspace"`, `cargo deny check` passes with an empty `ignore`
  list, and `osv-scanner.toml` holds no entry.
- **`shellcheck` is pinned in `mise.toml`**: actionlint runs it over every workflow
  `run:` block, and an unpinned shim broke actionlint; `just test-scripts` also runs it
  over the `shipping-issues` skill's `.sh` scripts.
- **Actions pinned one release back where the newest was under seven days old**
  (`github/codeql-action` v4.38.1), matching Dependabot's cooldown.
- Template-only blocks in standing docs are marked `<!-- template-only -->` …
  `<!-- /template-only -->` (D19 names the blocks, not their syntax); the bootstrap
  removes exactly this pair.

## Facts confirmed during the run

- clippy reads `crates/myapp-core/clippy.toml`: a temporary `println!` and a temporary
  `std::time::SystemTime::now()` in core each failed `cargo clippy -p myapp-core -- -D
  warnings` (`disallowed_macros`, `disallowed_methods`), so D3's clippy layer stands and
  no source-scanning fallback was needed. `disallowed-macros` catches `std::println` in
  edition 2024.
- YAML reads an unquoted label color such as `5319e7` as a number (5.319 × 10⁹), so
  `.github/labels.yml` quotes every color, and `cargo xtask sync-labels` rejects a
  non-string color.
- macOS's `/bin/bash` is still 3.2, and on a Mac without Homebrew's bash first on
  `PATH` a `#!/usr/bin/env bash` script runs under it (CI's macOS runners included).
  bash 3.2 fails to parse a here-document inside `"$(...)"` whose body holds a backtick,
  which the Template Bootstrap Smoke job caught in the ported
  `shipping-issues/scripts/preflight.sh`. Its two Python helpers now sit in functions
  called from the substitution, and `tests/test_shell_syntax.py` parses every bundled
  script with `/bin/bash -n`, so the Linux job's bash 5 no longer hides the problem.
