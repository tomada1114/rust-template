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
| Signing identity | `"-"` (ad hoc) unless Developer ID secrets exist | `bundle.macOS.signingIdentity` |
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
checked 2026-09-28), so only the release workflow on a CI runner builds one. Every
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

`.github/workflows/release.yml` runs on a macOS runner. It never re-signs the app by
hand: Tauri signs the bundle and the helper inside it itself, with the identity and the
entitlements `tauri.conf.json` names, so the entitlements cannot be lost by a second
signing pass.

1. **Trigger.** Pushing a `v*` tag (a human act), or running the workflow by hand with
   `dry_run: true`, which builds and uploads the `.dmg` as a workflow artifact without
   creating a release.
2. **Version check.** The tag must equal the version in `Cargo.toml`
   (`[workspace.package]`), `src-tauri/tauri.conf.json`, and `package.json`;
   otherwise the job fails.
3. **Tests.** The core and UI tests run again: nothing unverified ships.
4. **Build.** `pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg --
   --locked` (the `--locked` goes to cargo), signed as described below. Rust's build
   cache is not used on this path.
5. **Verify** the built app before anything is uploaded (see
   [Verifying a build](#verifying-a-build)).
6. **Publish.** A `SHA256SUMS` file, a build-provenance attestation
   (`actions/attest-build-provenance`), and `gh release create` with the `.dmg`; the
   release notes come from the categories in `.github/release.yml`.

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
gh pr create --fill
# once that pull request is merged into main:
git switch main && git pull
git tag v0.2.0
git push origin v0.2.0             # pushing the tag starts the release
```

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

When the `APPLE_CERTIFICATE` secret exists, the release job imports the certificate into
a temporary keychain and passes `APPLE_SIGNING_IDENTITY` to Tauri, which signs with it
instead of ad hoc. When the notarization secrets exist too, Tauri submits the signed app
to Apple's notary service and staples the ticket. Each step is skipped by an `if:` on a
step-level check of its secrets — never by `continue-on-error` — so a missing secret
means a clearly ad-hoc release, not a silently failed signing step.

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
instead of the Apple ID means changing the release job to write that file. The variable
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

The release job runs these checks on the built `.app` and fails before upload unless
all pass. `just smoke` runs the same signature, entitlement, and helper checks on a
local release build (`scripts/smoke.ts`), and `node scripts/smoke.ts --app <path>`
checks an already-built bundle.

```bash
APP="target/aarch64-apple-darwin/release/bundle/macos/MyApp.app"

# 1. The signature is valid, for the app and everything nested in it.
codesign --verify --deep --strict "$APP"

# 2. The entitlements the app carries equal src-tauri/Entitlements.plist.
codesign -d --entitlements - --xml "$APP"

# 3. The bundled helper is signed and runs.
codesign --verify --strict "$APP/Contents/MacOS/myapp-cli"
"$APP/Contents/MacOS/myapp-cli" --version

# 4. The launch smoke: the app starts windowless, logs `startup complete`, and exits 0.
node scripts/smoke.ts --app "$APP"

# 5. Developer ID builds only: Gatekeeper accepts it (an ad-hoc build is rejected here).
spctl --assess --type execute --verbose "$APP"
```

A user can check a downloaded release against the published checksums and provenance:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify "MyApp_0.2.0_aarch64.dmg" --repo tomada1114/tauri-template
```

## The App Sandbox is off

`Entitlements.plist` does not set `com.apple.security.app-sandbox`, which is Tauri's
default. The first app cut from this template manages launchd jobs: it must write
`~/Library/LaunchAgents` and run `launchctl`, which the sandbox forbids. What that
costs:

- **The Mac App Store is out.** The sandbox is a store requirement; this template ships
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
