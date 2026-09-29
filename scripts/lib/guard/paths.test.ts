import { describe, expect, it } from "vitest";

import { blockedPathReason } from "./paths.ts";

describe("blockedPathReason", () => {
  it.each([
    [".env", /environment file/],
    ["src-tauri/.env.production", /environment file/],
    [".envrc.local", /direnv/],
    ["config/secrets/token.txt", /`secrets`/],
    [".claude/settings.local.json", /local settings/],
    ["nested/.claude/settings.local.json", /local settings/],
    ["DeveloperID.P12", /PKCS#12/],
    ["cert.pfx", /PKCS#12/],
    ["AuthKey_ABC123.p8", /PKCS#8/],
    ["profile.provisionprofile", /provisioning profile/],
    ["app.mobileprovision", /provisioning profile/],
    ["login.keychain-db", /keychain/],
    ["build.keychain", /keychain/],
    ["signing-key.pem", /PEM file named as a key/],
    [".netrc", /\.netrc/],
    ["credentials.json", /credentials or secrets file/],
    ["secrets.json", /credentials or secrets file/],
    ["private-key.txt", /private key/],
    ["id_rsa", /SSH private key/],
    ["deploy/id_ed25519", /SSH private key/],
  ])("blocks %s", (path, reason) => {
    expect(blockedPathReason(path)).toMatch(reason);
  });

  it.each([
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
    "src-tauri/Entitlements.plist",
    "Cargo.lock",
  ])("allows %s", (path) => {
    expect(blockedPathReason(path)).toBeNull();
  });

  it("reads Windows separators and ignores empty segments", () => {
    expect(blockedPathReason("config\\secrets\\a.txt")).toMatch(/`secrets`/);
    expect(blockedPathReason("./a//.env")).toMatch(/environment file/);
  });
});
