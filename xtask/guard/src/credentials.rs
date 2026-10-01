//! Content-shaped commit rules: text that must never land in a tracked file. The union of
//! macos-app-template's `scripts/guard/credentials.sh` and typescript-template's
//! `scripts/lib/guard/credentials.mjs`, plus the macOS signing secrets a release pipeline
//! names: a `*_PASSWORD` assignment, and the base64 `.p12` in `APPLE_CERTIFICATE` (or any
//! base64 PKCS#12, recognised by its version-3 header).
//!
//! Literal shapes only, no entropy heuristic: each is anchored on a documented prefix plus
//! a minimum length, so prose that merely names a prefix passes. Each pattern is written
//! so its own source text does not match it — which is what lets this file be committed
//! through the guard that reads it — and the tests assemble their fixtures at runtime for
//! the same reason.
//!
//! Word boundaries are ASCII (`(?-u:\b)`), so a letter outside ASCII before a token does
//! not hide it. The `regex` crate has no look-around, so the two rules that need one say
//! it another way: the npm `_authToken` and `password` values exclude a leading reference
//! character in the value's first character class, and the Slack webhook rule rejects the
//! documented placeholder path after matching (`exempt`).
//!
//! Deliberately NOT matched: Stripe test keys (they reach test mode only); a bare
//! 40-character AWS secret, which counts only right after an `aws_secret_access_key`
//! assignment; a `password` whose value is a `$VAR` or `${{ … }}` reference, a masked
//! `***`, or shorter than six characters — a release workflow names its secrets that way
//! — or whose key is camelCase code (`confirmPassword = …`); an `.npmrc` `_authToken`
//! that is a `${VAR}` reference; Slack's documented webhook placeholder (an all-zero
//! `T0…/B0…/` path followed by `X`s); and a public certificate's base64 body, which is
//! neither assigned to a `CERTIFICATE` key nor a PKCS#12.

use regex::Regex;

/// One rule as written: its category, its pattern, and, for a rule that would need a
/// negative look-ahead, a pattern the `body` capture must not start with.
struct RuleSource {
    category: &'static str,
    pattern: &'static str,
    exempt: Option<&'static str>,
}

fn rule(category: &'static str, pattern: &'static str) -> RuleSource {
    RuleSource {
        category,
        pattern,
        exempt: None,
    }
}

/// Every rule, in the order they are tried.
fn rule_sources() -> [RuleSource; 19] {
    [
        rule(
            "private-key",
            r"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----",
        ),
        rule("github-token", r"(?-u:\b)gh[pousr]_[A-Za-z0-9]{36,}"),
        rule("github-token", r"(?-u:\b)github_pat_[A-Za-z0-9_]{20,}"),
        rule(
            "aws-access-key-id",
            r"(?-u:\b)(?:AKIA|ASIA)[A-Z0-9]{16}(?-u:\b)",
        ),
        rule(
            "aws-secret-access-key",
            r"(?i)aws[-_]?secret[-_]?access[-_]?key[^:=\n]{0,3}[:=][^A-Za-z0-9/+\n]{0,3}[A-Za-z0-9/+]{40}",
        ),
        rule("anthropic-key", r"(?-u:\b)sk-ant-[A-Za-z0-9_-]{20,}"),
        rule(
            "openai-key",
            r"(?-u:\b)sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}",
        ),
        rule(
            "openai-key",
            r"(?-u:\b)sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}",
        ),
        rule("openai-key", r"(?-u:\b)sk-[A-Za-z0-9]{20,}(?-u:\b)"),
        rule("slack-token", r"(?-u:\b)xox[abprs]-[A-Za-z0-9-]{10,}"),
        RuleSource {
            category: "slack-webhook",
            pattern: r"hooks\.slack\.com/(?:services|workflows|triggers)/(?P<body>[A-Za-z0-9+/]{43,})",
            exempt: Some(r"^T0+/B0+/"),
        },
        rule("google-api-key", r"(?-u:\b)AIza[0-9A-Za-z_-]{35}"),
        rule("stripe-live-key", r"(?-u:\b)[spr]k_live_[0-9A-Za-z]{16,}"),
        rule(
            "jwt",
            r"(?-u:\b)eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        ),
        rule("npm-token", r"(?-u:\b)npm_[A-Za-z0-9]{36,}"),
        // The value's first character is anything but a `${` reference.
        rule(
            "npm-auth-token",
            r"_authToken\s*=\s*(?:[^\s$]|\$(?:[^{]|\z))",
        ),
        // Not preceded by a letter or digit; the value's first character is not `$*<{`.
        rule(
            "password",
            r#"(?i)(?:^|[^A-Za-z0-9])password['"]?\s*[:=]\s*['"]?[^\s'"$*<{][^\s'"]{5,}"#,
        ),
        rule(
            "signing-certificate",
            r#"CERTIFICATE['"]?\s*[:=]\s*['"]?MII[A-Za-z0-9+/]{100,}"#,
        ),
        rule(
            "signing-certificate",
            r"(?-u:\b)MI[IJKL][A-Za-z0-9+/]{3}IBAzCC[A-Za-z0-9+/]{100,}",
        ),
    ]
}

/// One compiled rule.
struct Compiled {
    category: &'static str,
    pattern: Regex,
    exempt: Option<Regex>,
}

impl Compiled {
    fn matches(&self, text: &str) -> bool {
        let Some(exempt) = &self.exempt else {
            return self.pattern.is_match(text);
        };
        self.pattern.captures_iter(text).any(|found| {
            found
                .name("body")
                .is_some_and(|body| !exempt.is_match(body.as_str()))
        })
    }
}

/// The credential shapes, compiled once per run.
pub struct CredentialRules {
    rules: Vec<Compiled>,
}

impl CredentialRules {
    /// Compile every rule.
    ///
    /// # Errors
    ///
    /// A pattern the `regex` crate rejects; the tests compile every one, so this only
    /// happens to an edit that was never tested.
    pub fn new() -> Result<Self, regex::Error> {
        let rules = rule_sources()
            .iter()
            .map(|source| {
                Ok(Compiled {
                    category: source.category,
                    pattern: Regex::new(source.pattern)?,
                    exempt: source.exempt.map(Regex::new).transpose()?,
                })
            })
            .collect::<Result<Vec<_>, regex::Error>>()?;
        Ok(Self { rules })
    }

    /// The first credential category the text matches (never the matched text), or
    /// `None`.
    #[must_use]
    pub fn category(&self, text: &str) -> Option<&'static str> {
        self.rules
            .iter()
            .find(|rule| rule.matches(text))
            .map(|rule| rule.category)
    }
}

#[cfg(test)]
mod tests {
    use super::CredentialRules;

    // Every credential-shaped fixture is assembled at runtime, so this file itself never
    // holds one: push protection, gitleaks, and the staged guard would all refuse it.
    fn repeat(text: &str, count: usize) -> String {
        text.repeat(count)
    }

    fn join(parts: &[&str]) -> String {
        parts.concat()
    }

    fn base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
                if i <= chunk.len() {
                    out.push(char::from(ALPHABET[((n >> shift) & 63) as usize]));
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    fn rules() -> CredentialRules {
        CredentialRules::new().expect("every rule compiles")
    }

    #[test]
    fn finds_each_token_shape() {
        let cases: Vec<(&str, String)> = vec![
            (
                "private-key",
                join(&["-----BEGIN ", "RSA PRIVATE", " KEY-----\nabc"]),
            ),
            (
                "private-key",
                join(&["-----BEGIN ", "PRIVATE", " KEY-----"]),
            ),
            ("github-token", join(&["gh", "p_", &repeat("a", 36)])),
            ("github-token", join(&["github", "_pat_", &repeat("B", 22)])),
            ("aws-access-key-id", join(&["AK", "IA", "ABCDEFGHIJKLMNOP"])),
            ("aws-access-key-id", join(&["AS", "IA", "ABCDEFGHIJKLMNOP"])),
            (
                "aws-secret-access-key",
                join(&["aws_secret_access_key", " = ", &repeat("a", 40)]),
            ),
            (
                "aws-secret-access-key",
                join(&["AWS_SECRET_ACCESS_KEY", ": '", &repeat("Z", 40), "'"]),
            ),
            ("anthropic-key", join(&["sk-", "ant-", &repeat("x", 24)])),
            ("openai-key", join(&["sk-", "proj-", &repeat("y", 40)])),
            (
                "openai-key",
                join(&["sk-", &repeat("A", 20), "T3Blbk", "FJ", &repeat("B", 20)]),
            ),
            ("openai-key", join(&["sk-", &repeat("c", 32)])),
            (
                "slack-token",
                join(&["xo", "xb-", "12345678", "-", &repeat("q", 12)]),
            ),
            ("google-api-key", join(&["AI", "za", &repeat("k", 35)])),
            ("stripe-live-key", join(&["sk", "_live_", &repeat("9", 24)])),
            ("stripe-live-key", join(&["rk", "_live_", &repeat("9", 24)])),
            (
                "jwt",
                join(&[
                    "ey",
                    "J",
                    &repeat("a", 12),
                    ".",
                    "ey",
                    "J",
                    &repeat("b", 12),
                    ".",
                    &repeat("c", 12),
                ]),
            ),
        ];
        let rules = rules();
        for (category, text) in cases {
            assert_eq!(
                rules.category(&format!("before\n{text}\nafter")),
                Some(category),
                "{text}"
            );
        }
    }

    #[test]
    fn finds_each_assignment_and_key_file_shape() {
        let p12_large = join(&[
            "P12_B64: ",
            &base64(&[0x30, 0x82, 0x40, 0x00, 0x02, 0x01, 0x03, 0x30, 0x82]),
            &repeat("R", 120),
        ]);
        let cases: Vec<(&str, String)> = vec![
            ("npm-token", join(&["np", "m_", &repeat("n", 36)])),
            (
                "npm-auth-token",
                join(&["//registry.npmjs.org/:_auth", "Token=", "abc"]),
            ),
            (
                "npm-auth-token",
                join(&["//registry.npmjs.org/:_auth", "Token=", "$HOME"]),
            ),
            ("password", join(&["pass", "word = ", "hunter2hunter2"])),
            ("password", join(&["PASS", "WORD: 's3cretvalue'"])),
            // The names a macOS release pipeline gives its signing secrets.
            (
                "password",
                join(&["APPLE_PASS", "WORD=", "abcd-efgh-ijkl-mnop"]),
            ),
            (
                "password",
                join(&[
                    "export APPLE_CERTIFICATE_PASS",
                    "WORD=\"",
                    "FakeFake123",
                    "\"",
                ]),
            ),
            (
                "password",
                join(&["{\"pass", "word\": \"", "FakeFake123", "\"}"]),
            ),
            ("password", join(&["db_pass", "word: ", "FakeFake123"])),
            (
                "private-key",
                join(&["-----BEGIN ", "PGP PRIVATE", " KEY BLOCK-----"]),
            ),
            (
                "slack-webhook",
                join(&[
                    "https://hooks.",
                    "slack.com/services/",
                    "T1234ABCD/",
                    "B5678EFGH/",
                    &repeat("w", 24),
                ]),
            ),
            (
                "signing-certificate",
                join(&["APPLE_", "CERTIFICATE=", "MII", &repeat("Q", 120)]),
            ),
            // A base64 PKCS#12 (version 3) under any name: SEQUENCE, then INTEGER 3, then
            // SEQUENCE.
            (
                "signing-certificate",
                join(&["P12_B64: ", "MIIJ5w", "IBAz", "CC", &repeat("R", 120)]),
            ),
            // A DER length of 0x4000 or more moves the third base64 character from I to
            // J/K/L.
            ("signing-certificate", p12_large),
        ];
        let rules = rules();
        for (category, text) in cases {
            assert_eq!(
                rules.category(&format!("before\n{text}\nafter")),
                Some(category),
                "{text}"
            );
        }
    }

    #[test]
    fn finds_a_token_after_a_letter_outside_ascii() {
        let text = join(&["\u{e9}", "gh", "p_", &repeat("a", 36)]);
        assert_eq!(rules().category(&text), Some("github-token"));
    }

    #[test]
    fn finds_a_real_webhook_after_a_placeholder_one() {
        let placeholder = join(&[
            "https://hooks.",
            "slack.com/services/",
            "T00000000/",
            "B00000000/",
            &repeat("X", 24),
        ]);
        let real = join(&[
            "https://hooks.",
            "slack.com/services/",
            "T1234ABCD/",
            "B5678EFGH/",
            &repeat("w", 24),
        ]);
        assert_eq!(
            rules().category(&format!("{placeholder}\n{real}")),
            Some("slack-webhook")
        );
    }

    #[test]
    fn allows_what_is_not_a_credential() {
        let cases: Vec<(&str, String)> = vec![
            (
                "prose naming a prefix",
                "GitHub tokens start with ghp_ and AWS keys with AKIA.".to_owned(),
            ),
            (
                "a Stripe test key",
                join(&["sk", "_test_", &repeat("9", 24)]),
            ),
            ("a bare 40-character base64 string", repeat("a", 40)),
            (
                "a secret reference in a workflow",
                join(&["APPLE_", "PASSWORD: ${{ secrets.APPLE_", "PASSWORD }}"]),
            ),
            (
                "a password read from the environment",
                join(&["pass", "word = $APP_PASSWORD"]),
            ),
            ("a short password placeholder", join(&["pass", "word: ***"])),
            ("an empty file", String::new()),
            (
                "a public certificate",
                join(&["-----BEGIN ", "CERTIFICATE-----"]),
            ),
            (
                "a public certificate's base64 body",
                join(&[
                    "-----BEGIN ",
                    "CERTIFICATE-----\n",
                    "MIIDATCC",
                    "AemgAwIBAgIU",
                    &repeat("S", 120),
                ]),
            ),
            (
                "a PGP public key",
                join(&["-----BEGIN ", "PGP PUBLIC", " KEY BLOCK-----"]),
            ),
            (
                "an npm token read from the environment",
                join(&["//registry.npmjs.org/:_auth", "Token=${NPM_TOKEN}"]),
            ),
            (
                "an npm token read from the environment, spaced",
                join(&["//registry.npmjs.org/:_auth", "Token = ${NPM_TOKEN}"]),
            ),
            (
                "a signing secret passed through the environment",
                join(&[
                    "APPLE_PASS",
                    "WORD=\"$NOTARY_PASSWORD\" CERTIFICATE: ${{ secrets.APPLE_",
                    "CERTIFICATE }}",
                ]),
            ),
            (
                "a generated keychain password",
                join(&["KEYCHAIN_PASS", "WORD=$(uuidgen)"]),
            ),
            (
                "a camelCase field name",
                join(&["confirmPass", "word = document.body"]),
            ),
            (
                "Slack's documented webhook placeholder",
                join(&[
                    "https://hooks.",
                    "slack.com/services/",
                    "T00000000/",
                    "B00000000/",
                    &repeat("X", 24),
                ]),
            ),
            (
                "prose naming the Slack webhook host",
                "Post to hooks.slack.com/services/... from CI.".to_owned(),
            ),
        ];
        let rules = rules();
        for (label, text) in cases {
            assert_eq!(rules.category(&text), None, "{label}");
        }
    }

    #[test]
    fn its_own_source_matches_no_rule() {
        let source = include_str!("credentials.rs");
        assert_eq!(rules().category(source), None);
    }
}
