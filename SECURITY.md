# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report it privately through GitHub's private vulnerability reporting: open
[a new security advisory](https://github.com/tomada1114/tauri-template/security/advisories/new),
or use **Report a vulnerability** on the repository's **Security and quality** tab. How
it works is described in GitHub's documentation,
<https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability>
(checked 2026-09-28).

Please include:

- a description of the vulnerability and its impact;
- the steps to reproduce it;
- the affected versions (the release, or the commit you built from);
- a suggested fix, if you have one.

## Response

This project is maintained on a best-effort basis and makes no guaranteed response
time. Reports are acknowledged and assessed as maintainer time allows, and a fix ships
in the next release once it is ready. A repository created from this template should
replace this section with the commitments its own maintainers can keep.

## Supported versions

| Version | Supported |
|---|---|
| The latest release | Yes |
| The previous minor release | Best effort |
| Anything older | No |

## Supply-chain posture

- Every GitHub Action is pinned to a full commit SHA with a version comment, and
  workflows are linted by actionlint and zizmor.
- CLI tools are pinned in `mise.toml`, Rust in `rust-toolchain.toml`, and pnpm in
  `package.json`; `Cargo.lock` and `pnpm-lock.yaml` are committed, and every install in
  CI is `--locked` or `--frozen-lockfile`.
- Automated dependency updates (Dependabot for Cargo, npm, and Actions; Renovate for
  `mise.toml` and `rust-toolchain.toml`) wait out a 7-day release age, and pnpm refuses
  a version younger than that.
- `cargo deny` checks advisories, licences, bans, and sources over the dependency graph
  of the one shipped target, `aarch64-apple-darwin`. CodeQL, OSV-Scanner, OpenSSF
  Scorecard, and Dependency Review run in CI, and gitleaks scans the full history weekly.

`main`'s intended protection is defined as code in
[`.github/rulesets/main.json`](.github/rulesets/main.json) (pull requests required,
required checks green, no force push or deletion, no bypass actors) and applied by a
repository admin with `just ruleset`. Whether it is in force is visible only through
`gh api repos/{owner}/{repo}/rulesets`, not from a checkout: rulesets are server-side
configuration, and **Use this template** does not copy them.

## Responsible disclosure

We follow coordinated disclosure. Please:

1. report the issue privately, as described above;
2. allow reasonable time for a fix before disclosing it publicly;
3. not exploit the vulnerability beyond what is needed to demonstrate it.

We credit reporters in the release notes unless they prefer to remain anonymous.
