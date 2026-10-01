# A private repository

The detail behind `starting-an-app`'s ruleset step. The workflows assume a public
repository. On a private one, three of them need a paid GitHub security product, and a
required check that can never report blocks every pull request. Do these steps after
the bootstrap commit and before `just ruleset`.

The fix is to delete files, not to add `if:` guards: a skipped job never reports its
check, so a guarded job would leave its required context unsatisfied forever.

## 1. Delete the workflows a private repository cannot run

| File | Why it goes |
|---|---|
| `.github/workflows/codeql.yml` | Code scanning on a private repository needs a GitHub Code Security licence (https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning, checked 2026-09-29) |
| `.github/workflows/dependency-review.yml` | The dependency review action runs on a private repository only with GitHub Code Security or GitHub Advanced Security enabled (https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review, checked 2026-09-29) |
| `.github/workflows/scorecard.yml` | It uploads its results to code scanning (`github/codeql-action/upload-sarif`), which needs the same licence |

Keep any of them if the repository's plan includes those products. `osv-scan.yml` needs
neither and stays as the dependency-vulnerability check.

## 2. The attestation step in `release.yml`

`.github/workflows/release.yml` publishes a build-provenance attestation
(`actions/attest-build-provenance`) with the `attestations: write` and `id-token: write`
permissions, which no other step uses. Remove the step and both permissions unless the
repository is on GitHub Enterprise Cloud, the plan artifact attestations need on a
private repository
(https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations,
checked 2026-09-29). The release itself still works, visible only to people with
access to the repository.

## 3. Drop the matching required context

In `.github/rulesets/main.json`, remove the `Dependency Review` entry from
`required_status_checks` when `dependency-review.yml` was deleted. Neither CodeQL nor
Scorecard is a required context, so deleting them needs no ruleset edit; keep every
other context.

## 4. Verify, then apply the ruleset

Run `just lint` and `just check-harness` (the harness reads the remaining workflows and
checks that every required context names a job), commit, and open a pull request: every
check it waits for is now one a job reports. Then a repository admin runs `just ruleset`.
If the plan does not allow rulesets on a private repository, the script stops with
`ERR_RULESET_PLAN_UNSUPPORTED` rather than a raw HTTP error, and `main` and the `v*`
tags (`release-tags.json`) stay unprotected until the plan changes: say so to the owner
rather than working around it.
