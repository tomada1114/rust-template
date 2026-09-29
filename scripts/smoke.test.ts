import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunOptions, RunResult, ScriptContext } from "./lib/script.ts";
import { entitlementKeys, main, newestLog, parseSmokeArgs, startupLineFor } from "./smoke.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  dirs.push(dir);
  return dir;
}

const LOG_DIR = "Library/Logs/com.example.myapp";
const PID = 4242;

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions | undefined;
}

/**
 * A fake machine: `pnpm tauri build` creates the bundle, `codesign` answers, running the
 * app without HOME exits 1 with its reason, and running it with HOME writes a startup
 * line for its pid into today's log — unless told otherwise.
 */
function fakeMachine(
  home: string,
  root: string,
  overrides: Partial<
    Record<"build" | "verify" | "entitlements" | "app" | "homeless" | "cli", Partial<RunResult>>
  > & {
    readonly logLine?: string;
  } = {},
): { context: ScriptContext; calls: Call[]; lines: string[] } {
  const calls: Call[] = [];
  const lines: string[] = [];
  const ok: RunResult = { status: 0, stdout: "", stderr: "" };
  const run = (command: string, args: readonly string[], options?: RunOptions): RunResult => {
    calls.push({ command, args, options });
    if (command === "pnpm") {
      mkdirSync(join(root, "target/release/bundle/macos/MyApp.app/Contents/MacOS"), {
        recursive: true,
      });
      return { ...ok, ...overrides.build };
    }
    if (command === "codesign" && args.includes("--entitlements")) {
      return {
        ...ok,
        stdout: '<?xml version="1.0"?><plist><dict/></plist>',
        ...overrides.entitlements,
      };
    }
    if (command === "codesign") return { ...ok, ...overrides.verify };
    if (command.endsWith("/myapp-cli"))
      return { ...ok, stdout: "myapp-cli 0.1.0\n", ...overrides.cli };
    if (command.endsWith("/myapp") && options?.env?.["HOME"] === undefined) {
      return {
        status: 1,
        stdout: "",
        stderr: "error: the app could not start: HOME is not set\n",
        ...overrides.homeless,
      };
    }
    if (command.endsWith("/myapp")) {
      mkdirSync(join(home, LOG_DIR), { recursive: true });
      writeFileSync(
        join(home, LOG_DIR, "myapp.2026-09-28.log"),
        overrides.logLine ?? `INFO myapp_lib: startup complete pid=${String(PID)} smoke=true\n`,
      );
      return { ...ok, pid: PID, ...overrides.app };
    }
    throw new Error(`unexpected command ${command}`);
  };
  return {
    context: {
      argv: [],
      env: { HOME: home, APPLE_SIGNING_IDENTITY: "leak", PATH: "/bin" },
      root,
      run,
      log: (line) => {
        lines.push(line);
      },
    },
    calls,
    lines,
  };
}

function setup(): { home: string; root: string } {
  const root = tempDir();
  writeFileSync(join(root, "Entitlements.plist"), "");
  mkdirSync(join(root, "src-tauri"), { recursive: true });
  writeFileSync(join(root, "src-tauri/Entitlements.plist"), "<plist><dict/></plist>");
  return { home: tempDir(), root };
}

describe("parseSmokeArgs", () => {
  it("builds by default", () => {
    expect(parseSmokeArgs([])).toEqual({ build: true, app: undefined });
  });

  it("takes a prebuilt app and skips the build", () => {
    expect(parseSmokeArgs(["--app", "/x/MyApp.app"])).toEqual({
      build: false,
      app: "/x/MyApp.app",
    });
  });

  it("rejects anything else", () => {
    expect(() => parseSmokeArgs(["--fast"])).toThrow(/ERR_SMOKE_ARGS/);
    expect(() => parseSmokeArgs(["--app"])).toThrow(/ERR_SMOKE_ARGS/);
  });
});

describe("newestLog", () => {
  it("picks the newest file with the prefix, ignoring the helper's files", () => {
    const dir = tempDir();
    for (const [name, age] of [
      ["myapp.2026-09-27.log", 100],
      ["myapp.2026-09-28.log", 10],
      ["myapp-cli.2026-09-28.log", 0],
    ] as const) {
      writeFileSync(join(dir, name), "");
      const when = new Date(Date.now() - age * 1000);
      utimesSync(join(dir, name), when, when);
    }
    expect(newestLog(dir, "myapp")).toBe(join(dir, "myapp.2026-09-28.log"));
  });

  it("returns undefined for a missing or empty directory", () => {
    expect(newestLog(join(tempDir(), "absent"), "myapp")).toBeUndefined();
    expect(newestLog(tempDir(), "myapp")).toBeUndefined();
  });
});

describe("startupLineFor", () => {
  it("finds the startup line carrying the pid", () => {
    const text =
      "a\nINFO startup complete pid=12 smoke=true\nINFO startup complete pid=7 smoke=true\n";
    expect(startupLineFor(text, 7)).toBe("INFO startup complete pid=7 smoke=true");
  });

  it("does not match a different pid that shares digits", () => {
    expect(startupLineFor("INFO startup complete pid=77 smoke=true", 7)).toBeUndefined();
  });
});

describe("entitlementKeys", () => {
  it("lists the keys of a plist, sorted", () => {
    expect(entitlementKeys("<dict><key>b</key><true/><key>a</key><true/></dict>")).toEqual([
      "a",
      "b",
    ]);
    expect(entitlementKeys("<dict/>")).toEqual([]);
  });
});

describe("main", () => {
  it("builds the app bundle only, verifies it, runs it in smoke mode, and finds its startup line", () => {
    const { home, root } = setup();
    const { context, calls, lines } = fakeMachine(home, root);
    main(context);

    const build = calls[0];
    expect(build?.command).toBe("pnpm");
    expect(build?.args).toEqual(["tauri", "build", "--bundles", "app"]);
    expect(build?.options?.env?.["APPLE_SIGNING_IDENTITY"]).toBeUndefined();

    const app = join(root, "target/release/bundle/macos/MyApp.app");
    expect(calls.map((c) => c.command)).toEqual([
      "pnpm",
      "codesign",
      "codesign",
      "codesign",
      join(app, "Contents/MacOS/myapp-cli"),
      join(app, "Contents/MacOS/myapp"),
      join(app, "Contents/MacOS/myapp"),
    ]);
    const homeless = calls.at(-2);
    expect(homeless?.options?.env).not.toHaveProperty("HOME");
    expect(homeless?.options?.env?.["MYAPP_SMOKE"]).toBe("1");
    expect(homeless?.options?.env?.["APPLE_SIGNING_IDENTITY"]).toBeUndefined();
    expect(homeless?.options?.timeoutMs).toBeGreaterThan(0);
    expect(lines).toContainEqual(expect.stringContaining("HOME unset the app exits 1"));
    const launch = calls.at(-1);
    expect(launch?.options?.env?.["HOME"]).toBe(home);
    expect(launch?.options?.env?.["MYAPP_SMOKE"]).toBe("1");
    expect(launch?.options?.timeoutMs).toBeGreaterThan(0);
    expect(lines.at(-1)).toContain(`startup complete pid=${String(PID)}`);
  });

  it("uses a prebuilt app without building", () => {
    const { home, root } = setup();
    const app = join(root, "elsewhere/MyApp.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    const { context, calls } = fakeMachine(home, root);
    main({ ...context, argv: ["--app", app] });
    expect(calls.some((c) => c.command === "pnpm")).toBe(false);
    expect(calls.at(-1)?.command).toBe(join(app, "Contents/MacOS/myapp"));
  });

  const failures: [string, Parameters<typeof fakeMachine>[2], RegExp][] = [
    ["the build fails", { build: { status: 1 } }, /ERR_SMOKE_BUILD/],
    [
      "the signature does not verify",
      { verify: { status: 1, stderr: "invalid" } },
      /ERR_SMOKE_CODESIGN/,
    ],
    [
      "the entitlements differ",
      { entitlements: { stdout: "<dict><key>com.apple.security.app-sandbox</key><true/></dict>" } },
      /ERR_SMOKE_ENTITLEMENTS/,
    ],
    ["the bundled helper does not run", { cli: { status: 1 } }, /ERR_SMOKE_SIDECAR/],
    [
      "the app starts without HOME",
      { homeless: { status: 0, stderr: "" } },
      /ERR_SMOKE_STARTUP_ERROR/,
    ],
    [
      "the app dies by a signal without HOME",
      { homeless: { status: null, stderr: "" } },
      /ERR_SMOKE_STARTUP_ERROR/,
    ],
    [
      "the app exits 1 without HOME but does not say why",
      { homeless: { stderr: "" } },
      /ERR_SMOKE_STARTUP_ERROR/,
    ],
    ["the app exits non-zero", { app: { status: 1 } }, /ERR_SMOKE_EXIT/],
    ["the app times out", { app: { status: null, stderr: "ETIMEDOUT" } }, /ERR_SMOKE_EXIT/],
    ["the startup line is missing", { logLine: "INFO something else\n" }, /ERR_SMOKE_STARTUP_LINE/],
  ];
  it.each(failures)("fails when %s", (_, overrides, code) => {
    const { home, root } = setup();
    const { context } = fakeMachine(home, root, overrides);
    expect(() => {
      main(context);
    }).toThrow(code);
  });

  it("fails when HOME is not set", () => {
    const { home, root } = setup();
    const { context } = fakeMachine(home, root);
    expect(() => {
      main({ ...context, env: {} });
    }).toThrow(/ERR_SMOKE_HOME/);
  });

  it("fails when the prebuilt app does not exist", () => {
    const { home, root } = setup();
    const { context } = fakeMachine(home, root);
    expect(() => {
      main({ ...context, argv: ["--app", join(root, "missing.app")] });
    }).toThrow(/ERR_SMOKE_APP_MISSING/);
  });
});
