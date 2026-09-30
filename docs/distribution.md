# Distribution & Signing

MyApp ships as a `.dmg` attached to a GitHub Release (or the same file on your own site).
It runs on Apple Silicon Macs with macOS 14.0 or later, outside the App Sandbox, with
the hardened runtime on. This page covers how a release is built and signed, what a
user sees when they open it, and how to verify one.

## What is built, for which Macs

| Setting | Value | Where |
|---|---|---|
| Architecture | Apple Silicon only, `aarch64-apple-darwin` | `rust-toolchain.toml`'s `targets`; the release builds with `--target aarch64-apple-darwin` |
| macOS floor | 14.0 | `bundle.macOS.minimumSystemVersion` in `src-tauri/tauri.conf.json` |
| Signing identity | `"-"` (ad hoc) unless the six Apple secrets exist | `bundle.macOS.signingIdentity` |
| Hardened runtime | on | `bundle.macOS.hardenedRuntime` |
| Entitlements | `src-tauri/Entitlements.plist` (empty in the template) | `bundle.macOS.entitlements` |
| Bundled helper | `Contents/MacOS/myapp-cli` | `bundle.externalBin` |

A universal (Intel + Apple Silicon) build is an ADR decision for an app that needs Intel
Macs; until then the template's dependency advisories are evaluated for the Apple
Silicon graph only.

## Local builds

`just build` (debug), `just smoke`, and `just install-app` (release) make the `.app`
bundle only, never a disk image: Tauri's disk-image step drives Finder through
AppleScript unless `CI=true`
(<https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs>,
checked 2026-09-28), so only the release workflow on a CI runner builds one.
`tauri.conf.json`'s `bundle.targets` is `["app"]`, so a plain `pnpm tauri build` makes
no disk image either; the release workflow asks for one with `--bundles app,dmg`. Every
building recipe unsets the `APPLE_*` variables, so a local build is always ad-hoc signed
and never signs as a developer or contacts Apple.

**A locally built app is never quarantined.** Gatekeeper assesses software a user
*downloaded* — the browser or other app that saved it marks it with the
`com.apple.quarantine` attribute — so `just run`, `just install-app`, and `just smoke`
start the app with no Gatekeeper prompt. That is why a personal app is fine to use from
a local build: `just install-app` copies the release `.app` to `~/Applications`.
Apple: <https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web>
(checked 2026-09-28).

## The release

`.github/workflows/release.yml` builds on a macOS runner and publishes from a separate
job. It never re-signs the app by hand: Tauri signs the bundle and the helper inside it
itself, with the identity and the entitlements `tauri.conf.json` names, so the
entitlements cannot be lost by a second signing pass.

1. **Trigger.** Pushing a `v*` tag (a human act), or running the workflow by hand with
   `dry_run: true`, which builds and uploads the `.dmg` as a workflow artifact without
   creating a release.
2. **Preflight.** The `preflight` job, a read-only job (`contents: read`) on a Linux
   runner, checks for a publishing run that the ref is a `v*` tag, that the tag is
   `v<version>` with `package.json`'s version, and that the tagged commit is on the
   default branch, all before any dependency is installed or any test runs. It then
   checks that the version in `Cargo.toml` (`[workspace.package]`),
   `src-tauri/tauri.conf.json`, and `package.json` agree. A refused ref fails within a
   minute or two and starts no macOS job. A dry run skips the ref checks, not the
   version sites.
3. **Tests.** The core and UI tests run again, on a commit that already passed `main`'s
   required checks to get there.
4. **Secrets check.** The build job's first step, before anything is checked out, fails
   unless the six `APPLE_*` secrets are all set or all absent (see
   [The two signing paths](#the-two-signing-paths)).
5. **Build.** In the `release` environment, with a read-only token (`contents: read`):
   `pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg -- --locked` (the
   `--locked` goes to cargo), signed as described below. Rust's build cache is not used
   on this path.
6. **Verify** the built app before anything is uploaded (see
   [Verifying a build](#verifying-a-build)). The build job then uploads the `.dmg` and a
   `SHA256SUMS` file as a workflow artifact.
7. **Publish.** A separate Linux job, the only one with `contents: write`,
   `attestations: write`, and `id-token: write`. It checks out nothing and runs no cargo,
   pnpm, or mise: it downloads the verified artifact, attests the `.dmg`
   (`actions/attest-build-provenance`), and runs `gh release create` with the `.dmg` and
   `SHA256SUMS`; the release notes come from the categories in `.github/release.yml`. A
   dry run skips this job.

The build job still holds the signing identity and the notarization credentials while
it compiles, because Tauri signs while it bundles, and Cargo build scripts run there.
What limits this: only a commit on the default branch, reached through a reviewed pull
request, can reach that job, since the `release` environment's deployment policy and the
admin-only `v*` tags gate it (see
[Repository settings the release needs](#repository-settings-the-release-needs)); pnpm
runs no dependency's install script (`strictDepBuilds`, an empty `allowBuilds`); and the
write token and the OIDC token never enter that job.

### Preparing the version

`just release-prep <version>` (`scripts/release-prep.ts`) sets the version at its three
sites, refreshes `Cargo.lock`, and moves `CHANGELOG.md`'s `[Unreleased]` entries under
a dated heading. It refuses a version that is not greater than the current one, a dirty
work tree, and an empty `[Unreleased]`; `--dry-run` runs every check and writes nothing.
It creates no commit, tag, or push — those stay human acts:

```bash
just release-prep 0.2.0            # writes the three version sites, Cargo.lock, CHANGELOG.md
git switch -c release/0.2.0
git add Cargo.toml Cargo.lock src-tauri/tauri.conf.json package.json CHANGELOG.md
git commit -m 'chore: release v0.2.0'
git push -u origin release/0.2.0
gh pr create --base main --title 'chore: release v0.2.0' --body-file release-pr.md
# once that pull request is merged into main:
git switch main && git pull
git tag v0.2.0
git push origin v0.2.0             # pushing the tag starts the release
```

`release-pr.md` is a scratch copy of `.github/PULL_REQUEST_TEMPLATE.md` filled in, never
committed: the Summary, its `**Release impact:**` line naming the level of this release,
the Test Plan, and the Checklist, the same body the `create-pr` skill writes. Filling the
body from the commit message instead (`--fill`) drops all four.

### Repository settings the release needs

A repository admin applies these once. Each is a remote write that needs sign-off, and
"Use this template" copies none of them.

1. **The `release` environment**, deployable only from the default branch and `v*` tags:

   ```bash
   REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
   gh api --method PUT "repos/$REPO/environments/release" --input - <<'JSON'
   {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   JSON
   gh api --method POST "repos/$REPO/environments/release/deployment-branch-policies" -f name=main -f type=branch
   gh api --method POST "repos/$REPO/environments/release/deployment-branch-policies" -f name='v*' -f type=tag
   ```

   A workflow that references an environment that does not exist creates it, with no
   protection rules or secrets
   (<https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>,
   checked 2026-09-30), so until this step releases behave as they did before the
   environment existed. With "Selected branches and tags", only refs matching the
   patterns can deploy, and environment secrets reach only the jobs that reference the
   environment
   (<https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments>,
   checked 2026-09-30). On a private repository, environments need GitHub Pro or Team
   (both pages). Once the policy exists, a dry run from any branch other than the
   default one is refused at the build job.

   The template configures no required reviewer: the human gate is the admin-only tag
   push. An app with more than one admin may add one under Settings › Environments ›
   release with no workflow change; it then also gates every dry run.

2. **The Apple secrets as secrets of the `release` environment**
   (`gh secret set <NAME> --env release`), not repository secrets. A repository that
   already has them at repository level keeps working, because repository secrets reach
   every job, but it should set each one on the environment and then delete the
   repository-level copy; that is a human's step on release secrets.

3. **The tag ruleset**, `.github/rulesets/release-tags.json`: only a repository admin may
   create, move, or delete a `v*` tag. Apply it once:

   ```bash
   gh api --method POST "repos/$REPO/rulesets" --input .github/rulesets/release-tags.json
   ```

   To update it later, get its id and send the file again:

   ```bash
   gh api "repos/$REPO/rulesets?includes_parents=false" --jq '.[] | select(.name == "release-tags") | .id'
   gh api --method PUT "repos/$REPO/rulesets/<id>" --input .github/rulesets/release-tags.json
   ```

   Unlike `main.json`, which has no bypass actor so that nobody skips the pull request,
   this ruleset has one: the repository admin role (`actor_id` 5 with `RepositoryRole`;
   <https://registry.terraform.io/providers/integrations/github/latest/docs/resources/repository_ruleset>,
   checked 2026-09-29). A creation rule with no bypass would stop everyone from
   releasing, and the bypass is also how a tag the preflight refused is deleted and
   re-pushed. Without the creation rule, anyone with write access could push a `v*` tag
   on a branch whose edited workflow drops the preflight, and the environment's `v*`
   policy would admit it. Like `main`'s, rulesets on a private repository need a paid
   plan.

## The two signing paths

### Ad hoc (the default)

With no Apple secrets in the repository, `signingIdentity: "-"` signs the app ad hoc,
with the hardened runtime and `Entitlements.plist`. No Apple Developer Program
membership is needed. Apple Silicon requires every app downloaded from the internet to
be at least ad-hoc signed, and an ad-hoc signature does not identify a developer, so
Gatekeeper still blocks the downloaded app until the user allows it in Privacy &
Security (<https://v2.tauri.app/distribute/sign/macos/>, checked 2026-09-28; see
[Opening an ad-hoc build](#opening-an-ad-hoc-build)). An ad-hoc build is not notarized:
Apple's notary service scans Developer ID signed software
(<https://developer.apple.com/developer-id/>, checked 2026-09-28), so the notarization
step never runs on this path.

### Developer ID, notarized

When all six secrets below exist, the build job imports the certificate into a
temporary keychain, checks that `security find-identity -v -p codesigning` lists
`APPLE_SIGNING_IDENTITY` there, and passes that identity to Tauri, which signs with it
instead of ad hoc; Tauri then submits the signed app to Apple's notary service and
staples the ticket. A step that runs only on this path is skipped by an `if:` on a
job-level flag, never by `continue-on-error`, and a step that runs whether the build
passed, failed, or was cancelled (`if: always()`) deletes the keychain after the build.

The secrets are all or nothing. When some but not all of the six are set, the build
job's first step fails and names the ones that are missing, so a forgotten secret never
yields a silently ad-hoc build. That includes the Developer ID three without the
notarization three: signing without notarizing is not offered, because Gatekeeper's
check (`spctl --assess`, the last verification step) rejects a Developer ID app that is
not notarized, and a downloaded copy is then blocked just as an ad-hoc one is. A
certificate or identity that does not match fails at the `find-identity` check, before
the build rather than inside it.

They are secrets of the `release` environment, not repository secrets (see
[Repository settings the release needs](#repository-settings-the-release-needs)):

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | Your **Developer ID Application** certificate and private key, exported as `.p12` and base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The password protecting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | The certificate's name in the keychain, e.g. `Developer ID Application: Jane Doe (ABCDE12345)` |
| `APPLE_ID` | The Apple Account email used for notarization |
| `APPLE_PASSWORD` | An app-specific password for that account, not the account password |
| `APPLE_TEAM_ID` | Your 10-character team identifier |

Tauri also accepts an App Store Connect API key for notarization (`APPLE_API_ISSUER`,
`APPLE_API_KEY`, and `APPLE_API_KEY_PATH`, a path to the downloaded key file); using it
instead of the Apple ID means changing the build job to write that file. The variable
names are Tauri's: <https://v2.tauri.app/distribute/sign/macos/> (checked 2026-09-28).
Signing and notarization need a paid
[Apple Developer Program](https://developer.apple.com/programs/) membership.

## Opening an ad-hoc build

A user who downloads an ad-hoc build sees macOS refuse to open it the first time. Since
macOS 15, Control-click › Open no longer bypasses Gatekeeper
(<https://developer.apple.com/news/?id=saqachfa>, checked 2026-09-28). Either:

- try to open the app once, then go to **System Settings › Privacy & Security**, find
  the message about MyApp under **Security**, click **Open Anyway**, and confirm with
  the login password. The button is offered for about an hour after the blocked
  attempt; afterwards the app opens normally
  (<https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac>,
  checked 2026-09-28); or
- remove the quarantine attribute from the copied app in Terminal:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/MyApp.app"
  ```

Say this in the release notes of an ad-hoc release, or better, configure the Developer
ID secrets above. None of this applies to a build made on the same Mac, which is never
quarantined.

## Verifying a build

The build job runs these checks on the built `.app` and fails before the artifact is
uploaded unless all pass, so the publish job never starts. `just smoke` runs the same signature, entitlement, and helper checks on a
local release build (`scripts/smoke.ts`), and `node scripts/smoke.ts --app <path>`
checks an already-built bundle.

```bash
APP="target/aarch64-apple-darwin/release/bundle/macos/MyApp.app"

# 1. The signature is valid, for the app and everything nested in it.
codesign --verify --deep --strict "$APP"

# 2. The entitlements the app carries equal src-tauri/Entitlements.plist: the same keys
#    with the same values. smoke.ts parses both with plutil and compares the dictionaries.
codesign -d --entitlements - --xml "$APP" | plutil -convert json -o - -
plutil -convert json -o - src-tauri/Entitlements.plist

# 3. The bundled helper is signed and runs.
codesign --verify --strict "$APP/Contents/MacOS/myapp-cli"
"$APP/Contents/MacOS/myapp-cli" --version

# 4. The launch smoke: the app starts windowless, logs `startup complete`, and exits 0.
node scripts/smoke.ts --app "$APP"

# 5. Developer ID builds only, which are always notarized: Gatekeeper accepts it (an
#    ad-hoc build, or a Developer ID one that is not notarized, is rejected here).
spctl --assess --type execute --verbose "$APP"
```

A user can check a downloaded release against the published checksums and provenance:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify "MyApp_0.2.0_aarch64.dmg" --repo tomada1114/tauri-template
```

## The App Sandbox is off

`Entitlements.plist` does not set `com.apple.security.app-sandbox`, which is Tauri's
default. It starts off so that an app can reach what the sandbox forbids — managing
launchd jobs for its bundled helper, for example, means writing `~/Library/LaunchAgents`
and running `launchctl`. What that costs:

- **The Mac App Store is out.** The sandbox is a store requirement; releases here ship
  through direct download anyway.
- **A bug reaches further.** An unsandboxed app can touch anything the user can, which
  is why the core bans direct I/O and every OS call sits in a reviewed adapter.

What stays on regardless: the hardened runtime, signing on both paths, and the
entitlements check before upload. Turning the sandbox on is an ADR decision, and so is
any entitlement: `Entitlements.plist` changes only with a human's sign-off, and the
release's entitlements comparison makes sure what ships is what that file says.

## Out of scope

- **An auto-updater.** A non-goal of the template; an app that wants one records the
  choice in an ADR.
- **The Mac App Store.** A different signing and provisioning pipeline, and it requires
  the App Sandbox.
- **Intel Macs.** See [What is built, for which Macs](#what-is-built-for-which-macs).
