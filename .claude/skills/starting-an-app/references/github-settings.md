# GitHub settings a new repository must enable

The detail behind `starting-an-app`'s labels, security-settings, and ruleset steps.

"Use this template" copies files, not settings, so a repository's admin sets these up
once: the security switches under Settings › Advanced Security (Code security on older
UIs), the `main` ruleset, the Renovate App, automatic head-branch deletion, and the
label set:

- **Secret scanning** and **Push protection** — the server-side layer for secrets that
  the staged guard misses or a bypass skips; push protection blocks a detected secret
  at `git push`.
- **Private vulnerability reporting** — `SECURITY.md` sends reporters to a private
  security advisory, which this setting enables.
- **Dependabot alerts** and **security updates** — `.github/dependabot.yml` configures
  version updates; alerts for known-vulnerable dependencies are a separate switch.
- The `main` ruleset, applied by `just ruleset`. `.github/rulesets/main.json`
  deliberately lists no `bypass_actors`: a bypass lets an admin, or an agent acting
  with an admin's token, merge without the PR and green checks the ruleset exists to
  require, and an emergency change can still go through a PR.
- The `release-tags` ruleset, applied by the same `just ruleset` from
  `.github/rulesets/release-tags.json`: only a repository admin may create, move, or
  delete a `v*` tag, so it keeps its admin bypass.
- The **Renovate** GitHub App (<https://github.com/apps/renovate>, checked 2026-09-30),
  installed on the repository: without it `.github/renovate.json` does nothing, so
  `mise.toml` and `rust-toolchain.toml` are never bumped — Dependabot covers only cargo
  and Actions.
- **Automatically delete head branches** (Settings › General; the repository's
  `delete_branch_on_merge`): `shipping-issues` deletes no remote branch on either host,
  so without it every merged pull request leaves its head branch behind.
- The label set, created by `just labels` as soon as the repository exists.
  `.github/dependabot.yml` names its `labels` explicitly, and Dependabot then ignores
  one the repository does not define rather than creating it
  (<https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference>,
  `labels`, checked 2026-09-30), so add `dependencies` by hand to any Dependabot pull
  request opened before that.
