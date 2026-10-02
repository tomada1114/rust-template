# Implementation notes

<!-- template-only: cargo xtask bootstrap removes docs/template/ from a generated app. -->

Implementation observations that still apply to the finalized [design.md](design.md).
The maintained operating rules live in AGENTS.md and the configurations they name.

## Deviations

- **Live labels are a superset of `labels.yml`.** After `just labels`, every declared
  label exists on the repository, and GitHub's defaults (`accessibility`, `duplicate`,
  `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`) remain beside them:
  the sync never deletes a label the manifest does not mention (as in both reference
  repositories), and deleting labels is outside the run's GitHub authority.
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
  `<!-- /template-only -->`; the bootstrap removes exactly this pair.

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
