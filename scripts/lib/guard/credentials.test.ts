import { describe, expect, it } from "vitest";

import { credentialCategory } from "./credentials.ts";

// Every credential-shaped fixture is assembled at runtime, so this file itself never
// holds one: push protection, gitleaks, and the staged guard would all refuse it.
const repeat = (char: string, count: number): string => char.repeat(count);
const join = (...parts: string[]): string => parts.join("");

describe("credentialCategory", () => {
  it.each([
    ["private-key", join("-----BEGIN ", "RSA PRIVATE", " KEY-----\nabc")],
    ["private-key", join("-----BEGIN ", "PRIVATE", " KEY-----")],
    ["github-token", join("gh", "p_", repeat("a", 36))],
    ["github-token", join("github", "_pat_", repeat("B", 22))],
    ["aws-access-key-id", join("AK", "IA", "ABCDEFGHIJKLMNOP")],
    ["aws-access-key-id", join("AS", "IA", "ABCDEFGHIJKLMNOP")],
    ["aws-secret-access-key", join("aws_secret_access_key", " = ", repeat("a", 40))],
    ["aws-secret-access-key", join("AWS_SECRET_ACCESS_KEY", ": '", repeat("Z", 40), "'")],
    ["anthropic-key", join("sk-", "ant-", repeat("x", 24))],
    ["openai-key", join("sk-", "proj-", repeat("y", 40))],
    ["openai-key", join("sk-", repeat("A", 20), "T3Blbk", "FJ", repeat("B", 20))],
    ["openai-key", join("sk-", repeat("c", 32))],
    ["slack-token", join("xo", "xb-", "12345678", "-", repeat("q", 12))],
    ["google-api-key", join("AI", "za", repeat("k", 35))],
    ["stripe-live-key", join("sk", "_live_", repeat("9", 24))],
    ["stripe-live-key", join("rk", "_live_", repeat("9", 24))],
    [
      "jwt",
      join("ey", "J", repeat("a", 12), ".", "ey", "J", repeat("b", 12), ".", repeat("c", 12)),
    ],
    ["npm-token", join("np", "m_", repeat("n", 36))],
    ["npm-auth-token", join("//registry.npmjs.org/:_auth", "Token=", "abc")],
    ["password", join("pass", "word = ", "hunter2hunter2")],
    ["password", join("PASS", "WORD: 's3cretvalue'")],
    // The names release.yml and docs/distribution.md give this template's own secrets.
    ["password", join("APPLE_PASS", "WORD=", "abcd-efgh-ijkl-mnop")],
    ["password", join("export APPLE_CERTIFICATE_PASS", 'WORD="', "FakeFake123", '"')],
    ["password", join('{"pass', 'word": "', "FakeFake123", '"}')],
    ["password", join("db_pass", "word: ", "FakeFake123")],
    ["private-key", join("-----BEGIN ", "PGP PRIVATE", " KEY BLOCK-----")],
    [
      "slack-webhook",
      join("https://hooks.", "slack.com/services/", "T1234ABCD/", "B5678EFGH/", repeat("w", 24)),
    ],
    ["signing-certificate", join("APPLE_", "CERTIFICATE=", "MII", repeat("Q", 120))],
    // A base64 PKCS#12 (version 3) under any name: SEQUENCE, then INTEGER 3, then SEQUENCE.
    ["signing-certificate", join("P12_B64: ", "MIIJ5w", "IBAz", "CC", repeat("R", 120))],
  ])("finds %s", (category, text) => {
    expect(credentialCategory(`before\n${text}\nafter`)).toBe(category);
  });

  it.each([
    ["prose naming a prefix", "GitHub tokens start with ghp_ and AWS keys with AKIA."],
    ["a Stripe test key", join("sk", "_test_", repeat("9", 24))],
    ["a bare 40-character base64 string", repeat("a", 40)],
    [
      "a secret reference in a workflow",
      join("APPLE_", "PASSWORD: ${{ secrets.APPLE_", "PASSWORD }}"),
    ],
    ["a password read from the environment", join("pass", "word = $APP_PASSWORD")],
    ["a short password placeholder", join("pass", "word: ***")],
    ["an empty file", ""],
    ["a public certificate", join("-----BEGIN ", "CERTIFICATE-----")],
    [
      "a public certificate's base64 body",
      join("-----BEGIN ", "CERTIFICATE-----\n", "MIIDATCC", "AemgAwIBAgIU", repeat("S", 120)),
    ],
    ["a PGP public key", join("-----BEGIN ", "PGP PUBLIC", " KEY BLOCK-----")],
    [
      "an npm token read from the environment",
      join("//registry.npmjs.org/:_auth", "Token=${NPM_TOKEN}"),
    ],
    [
      "a signing secret passed through the environment",
      join(
        "APPLE_PASS",
        'WORD="$NOTARY_PASSWORD" CERTIFICATE: ${{ secrets.APPLE_',
        "CERTIFICATE }}",
      ),
    ],
    ["a generated keychain password", join("KEYCHAIN_PASS", "WORD=$(uuidgen)")],
    ["a camelCase field name", join("confirmPass", "word = document.body")],
    ["prose naming the Slack webhook host", "Post to hooks.slack.com/services/... from CI."],
  ])("allows %s", (_, text) => {
    expect(credentialCategory(text)).toBeNull();
  });
});
