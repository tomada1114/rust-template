//! Path-shaped commit rules: staged paths refused on their name alone. The union of
//! macos-app-template's `scripts/guard/paths.sh` and typescript-template's
//! `scripts/lib/guard/paths.mjs`, minus the Xcode-only `Local.xcconfig` rule.
//!
//! Deliberately NOT blocked:
//! - `.cer` and `.certSigningRequest`: a public certificate and a signing request hold no
//!   private key; `.key` collides with Keynote documents; `*.pub` is a public key;
//! - `.env.example`, `.env.sample`, `.env.template` (and the same `.envrc.*` samples):
//!   committed, secret-free samples;
//! - a bare `.envrc`: direnv projects commit it on purpose; only `.envrc.*` variants,
//!   which by convention hold per-machine values, are refused.
//!
//! Basename matches are case-insensitive (macOS file systems do not tell `Cert.P12` from
//! `cert.p12`); the `secrets` directory match is exact.

const SAMPLE_SUFFIXES: [&str; 3] = [".example", ".sample", ".template"];

/// One basename rule: a test on the lower-cased name, and why it is refused.
struct NameRule {
    test: fn(&str) -> bool,
    reason: &'static str,
}

const NAME_RULES: [NameRule; 9] = [
    NameRule {
        test: |name| matches!(extension(name), Some("p12" | "pfx")),
        reason: "a certificate exported with its private key (PKCS#12)",
    },
    NameRule {
        test: |name| extension(name) == Some("p8"),
        reason: "a PKCS#8 private key, such as an App Store Connect API key",
    },
    NameRule {
        test: |name| {
            matches!(
                extension(name),
                Some("provisionprofile" | "mobileprovision")
            )
        },
        reason: "a provisioning profile",
    },
    NameRule {
        test: |name| matches!(extension(name), Some("keychain" | "keychain-db")),
        reason: "a keychain",
    },
    NameRule {
        test: |name| extension(name) == Some("pem") && name.contains("key"),
        reason: "a PEM file named as a key",
    },
    NameRule {
        test: |name| name == ".netrc",
        reason: "a .netrc holds login credentials",
    },
    NameRule {
        test: |name| name == "credentials.json" || name == "secrets.json",
        reason: "a credentials or secrets file",
    },
    NameRule {
        test: |name| name.starts_with("private-key."),
        reason: "a file named as a private key",
    },
    NameRule {
        test: |name| matches!(name, "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519"),
        reason: "an SSH private key (its .pub twin is the public half)",
    },
];

/// What follows the last `.` of a (lower-cased) name: `p12` for `cert.p12` and for a bare
/// `.p12` alike.
fn extension(name: &str) -> Option<&str> {
    name.rsplit_once('.').map(|(_, extension)| extension)
}

fn is_sample(name: &str) -> bool {
    SAMPLE_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

/// Why a repository-relative path must not be committed, or `None` when it may be.
///
/// Both `/` and `\` separate segments, and empty and `.` segments are ignored.
#[must_use]
pub fn blocked_path_reason(path: &str) -> Option<&'static str> {
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    let (name, dirs) = parts
        .split_last()
        .map_or(("", &[][..]), |(name, dirs)| (*name, dirs));
    let lower = name.to_lowercase();

    if dirs.contains(&"secrets") {
        return Some("a path segment is `secrets`");
    }
    if dirs.last() == Some(&".claude") && name == "settings.local.json" {
        return Some(
            "Claude Code's local settings are per-user, gitignored, and can widen an agent's own permissions",
        );
    }
    if lower.starts_with(".envrc.") {
        return (!is_sample(&lower))
            .then_some("a direnv variant file (`.envrc.*`) can hold real values");
    }
    if lower == ".env" || lower.starts_with(".env.") {
        return (!is_sample(&lower))
            .then_some("an environment file (`.env` or `.env.*`) can hold real values");
    }
    NAME_RULES
        .iter()
        .find(|rule| (rule.test)(&lower))
        .map(|rule| rule.reason)
}

#[cfg(test)]
mod tests {
    use super::blocked_path_reason;

    #[test]
    fn blocks_secret_shaped_paths() {
        let cases = [
            (".env", "environment file"),
            ("src-tauri/.env.production", "environment file"),
            (".envrc.local", "direnv"),
            ("config/secrets/token.txt", "`secrets`"),
            (".claude/settings.local.json", "local settings"),
            ("nested/.claude/settings.local.json", "local settings"),
            ("DeveloperID.P12", "PKCS#12"),
            ("cert.pfx", "PKCS#12"),
            ("AuthKey_ABC123.p8", "PKCS#8"),
            ("profile.provisionprofile", "provisioning profile"),
            ("app.mobileprovision", "provisioning profile"),
            ("login.keychain-db", "keychain"),
            ("build.keychain", "keychain"),
            ("signing-key.pem", "PEM file named as a key"),
            (".netrc", ".netrc"),
            ("credentials.json", "credentials or secrets file"),
            ("secrets.json", "credentials or secrets file"),
            ("private-key.txt", "private key"),
            ("id_rsa", "SSH private key"),
            ("id_dsa", "SSH private key"),
            ("id_ecdsa", "SSH private key"),
            ("deploy/id_ed25519", "SSH private key"),
        ];
        for (path, reason) in cases {
            let found = blocked_path_reason(path);
            assert!(
                found.is_some_and(|text| text.contains(reason)),
                "{path}: expected a reason containing {reason:?}, got {found:?}"
            );
        }
    }

    #[test]
    fn allows_samples_public_material_and_ordinary_files() {
        let cases = [
            ".env.example",
            ".env.sample",
            "src/.env.template",
            ".envrc",
            ".envrc.example",
            "developer.cer",
            "request.certSigningRequest",
            "Presentation.key",
            "public-cert.pem",
            "id_rsa.pub",
            "docs/secrets-management.md",
            ".claude/settings.json",
            "settings.local.json",
            "src-tauri/Entitlements.plist",
            "Cargo.lock",
            "",
        ];
        for path in cases {
            assert_eq!(blocked_path_reason(path), None, "{path}");
        }
    }

    #[test]
    fn reads_windows_separators_and_ignores_empty_segments() {
        assert!(
            blocked_path_reason("config\\secrets\\a.txt").is_some_and(|r| r.contains("`secrets`"))
        );
        assert!(blocked_path_reason("./a//.env").is_some_and(|r| r.contains("environment file")));
    }
}
