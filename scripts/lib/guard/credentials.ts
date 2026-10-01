/**
 * Content-shaped commit rules: text that must never land in a tracked file. The
 * union of macos-app-template's scripts/guard/credentials.sh and
 * typescript-template's scripts/lib/guard/credentials.mjs, plus the macOS signing
 * secrets a release pipeline names: a `*_PASSWORD` assignment, and the base64
 * `.p12` in `APPLE_CERTIFICATE` (or any base64 PKCS#12, recognised by its version-3
 * header).
 *
 * Literal shapes only, no entropy heuristic: each is anchored on a documented prefix
 * plus a minimum length, so prose that merely names a prefix passes. Each pattern is
 * written so its own source text does not match it — which is what lets this file be
 * committed through the guard that reads it — and tests assemble their fixtures at
 * runtime for the same reason.
 *
 * Deliberately NOT matched: Stripe test keys (they reach test mode only); a bare
 * 40-character AWS secret, which counts only right after an `aws_secret_access_key`
 * assignment; a `password` whose value is a `$VAR` or `${{ … }}` reference, a
 * masked `***`, or shorter than six characters — a release workflow names its
 * secrets that way — or whose key is camelCase code (`confirmPassword = …`); an
 * `.npmrc` `_authToken` that is a `${VAR}` reference; Slack's documented webhook
 * placeholder (an all-zero `T0…/B0…/` path followed by `X`s); and a public
 * certificate's base64 body, which is neither assigned to a `CERTIFICATE` key nor a PKCS#12.
 */

interface CredentialRule {
  readonly category: string;
  readonly pattern: RegExp;
}

export const CREDENTIAL_RULES: readonly CredentialRule[] = [
  { category: "private-key", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { category: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { category: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { category: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  {
    category: "aws-secret-access-key",
    pattern:
      /aws[-_]?secret[-_]?access[-_]?key[^:=\n]{0,3}[:=][^A-Za-z0-9/+\n]{0,3}[A-Za-z0-9/+]{40}/i,
  },
  { category: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { category: "openai-key", pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/ },
  { category: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/ },
  { category: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { category: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    category: "slack-webhook",
    pattern: /hooks\.slack\.com\/(?:services|workflows|triggers)\/(?!T0+\/B0+\/)[A-Za-z0-9+/]{43,}/,
  },
  { category: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { category: "stripe-live-key", pattern: /\b[spr]k_live_[0-9A-Za-z]{16,}/ },
  {
    category: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  { category: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36,}/ },
  { category: "npm-auth-token", pattern: /_authToken\s*=\s*(?!\$\{)\S/ },
  {
    category: "password",
    pattern: /(?<![A-Za-z0-9])password['"]?\s*[:=]\s*['"]?(?![$*<{])[^\s'"]{6,}/i,
  },
  {
    category: "signing-certificate",
    pattern: /CERTIFICATE['"]?\s*[:=]\s*['"]?MII[A-Za-z0-9+/]{100,}/,
  },
  {
    category: "signing-certificate",
    pattern: /\bMI[IJKL][A-Za-z0-9+/]{3}IBAzCC[A-Za-z0-9+/]{100,}/,
  },
];

/** The first credential category the text matches (never the matched text), or `null`. */
export function credentialCategory(text: string): string | null {
  return CREDENTIAL_RULES.find((rule) => rule.pattern.test(text))?.category ?? null;
}
