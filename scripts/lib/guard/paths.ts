/**
 * Path-shaped commit rules: staged paths refused on their name alone (design D11).
 * The union of macos-app-template's scripts/guard/paths.sh and typescript-template's
 * scripts/lib/guard/paths.mjs, minus the Xcode-only `Local.xcconfig` rule.
 *
 * Deliberately NOT blocked:
 * - `.cer` and `.certSigningRequest`: a public certificate and a signing request hold
 *   no private key; `.key` collides with Keynote documents; `*.pub` is a public key;
 * - `.env.example`, `.env.sample`, `.env.template` (and the same `.envrc.*`
 *   samples): committed, secret-free samples;
 * - a bare `.envrc`: direnv projects commit it on purpose; only `.envrc.*` variants,
 *   which by convention hold per-machine values, are refused.
 *
 * Basename matches are case-insensitive (macOS file systems do not tell `Cert.P12`
 * from `cert.p12`); the `secrets` directory match is exact. A new rule needs a case in
 * paths.test.ts.
 */

const SAMPLE_SUFFIXES = [".example", ".sample", ".template"];

interface NameRule {
  readonly test: (lowerName: string) => boolean;
  readonly reason: string;
}

const NAME_RULES: readonly NameRule[] = [
  {
    test: (name) => name.endsWith(".p12") || name.endsWith(".pfx"),
    reason: "a certificate exported with its private key (PKCS#12)",
  },
  {
    test: (name) => name.endsWith(".p8"),
    reason: "a PKCS#8 private key, such as an App Store Connect API key",
  },
  {
    test: (name) => name.endsWith(".provisionprofile") || name.endsWith(".mobileprovision"),
    reason: "a provisioning profile",
  },
  {
    test: (name) => name.endsWith(".keychain") || name.endsWith(".keychain-db"),
    reason: "a keychain",
  },
  {
    test: (name) => name.endsWith(".pem") && name.includes("key"),
    reason: "a PEM file named as a key",
  },
  { test: (name) => name === ".netrc", reason: "a .netrc holds login credentials" },
  {
    test: (name) => name === "credentials.json" || name === "secrets.json",
    reason: "a credentials or secrets file",
  },
  { test: (name) => name.startsWith("private-key."), reason: "a file named as a private key" },
  {
    test: (name) => /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name),
    reason: "an SSH private key (its .pub twin is the public half)",
  },
];

const isSample = (name: string): boolean => SAMPLE_SUFFIXES.some((suffix) => name.endsWith(suffix));

/** Why a repository-relative path must not be committed, or `null` when it may be. */
export function blockedPathReason(path: string): string | null {
  const parts = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  const name = parts.at(-1) ?? "";
  const lower = name.toLowerCase();

  if (parts.slice(0, -1).includes("secrets")) return "a path segment is `secrets`";
  if (parts.slice(-2).join("/") === ".claude/settings.local.json") {
    return "Claude Code's local settings are per-user, gitignored, and can widen an agent's own permissions";
  }
  if (lower.startsWith(".envrc.")) {
    return isSample(lower) ? null : "a direnv variant file (`.envrc.*`) can hold real values";
  }
  if (lower === ".env" || lower.startsWith(".env.")) {
    return isSample(lower) ? null : "an environment file (`.env` or `.env.*`) can hold real values";
  }
  return NAME_RULES.find((rule) => rule.test(lower))?.reason ?? null;
}
