import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptError } from "./lib/fail.ts";
import type { RunOptions, RunResult, ScriptContext } from "./lib/script.ts";
import {
  canonicalJson,
  entitlementsJson,
  main,
  newestLog,
  parseSmokeArgs,
  startupLineFor,
} from "./smoke.ts";

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

const EMPTY_PLIST = "<plist><dict/></plist>";
const SIGNED_EMPTY = '<?xml version="1.0"?><plist><dict/></plist>';
const LIBRARY_VALIDATION = "com.apple.security.cs.disable-library-validation";
const plistWith = (value: "true" | "false"): string =>
  `<plist><dict><key>${LIBRARY_VALIDATION}</key><${value}/></dict></plist>`;

/**
 * What `plutil -convert json` prints for each plist these tests feed it; the real parser
 * runs in `just smoke`. An input missing here is one plutil cannot read.
 */
const PLUTIL: Readonly<Record<string, string>> = {
  [EMPTY_PLIST]: "{}",
  [SIGNED_EMPTY]: "{}",
  [plistWith("true")]: JSON.stringify({ [LIBRARY_VALIDATION]: true }),
  [plistWith("false")]: JSON.stringify({ [LIBRARY_VALIDATION]: false }),
};

function caught(action: () => void): ScriptError {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

function fakePlutil(input: string | undefined): RunResult {
  const json = input === undefined ? undefined : PLUTIL[input];
  return json === undefined
    ? { status: 1, stdout: "", stderr: "<stdin>: Encountered unexpected character" }
    : { status: 0, stdout: `${json}\n`, stderr: "" };
}

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions | undefined;
}

/**
 * A fake machine: `cargo metadata` names the target directory (`<root>/target` unless
 * told otherwise), `pnpm tauri build` creates the bundle there, `codesign` answers,
 * running the app without HOME exits 1 with its reason, and running it with HOME writes a
 * startup line for its pid into today's log — unless told otherwise.
 */
function fakeMachine(
  home: string,
  root: string,
  overrides: Partial<
    Record<
      "metadata" | "build" | "verify" | "entitlements" | "plutil" | "app" | "homeless" | "cli",
      Partial<RunResult>
    >
  > & {
    readonly logLine?: string;
    readonly targetDir?: string;
  } = {},
): { context: ScriptContext; calls: Call[]; lines: string[] } {
  const calls: Call[] = [];
  const lines: string[] = [];
  const ok: RunResult = { status: 0, stdout: "", stderr: "" };
  const targetDir = overrides.targetDir ?? join(root, "target");
  const run = (command: string, args: readonly string[], options?: RunOptions): RunResult => {
    calls.push({ command, args, options });
    if (command === "cargo" && args[0] === "metadata") {
      return {
        ...ok,
        stdout: JSON.stringify({ target_directory: targetDir }),
        ...overrides.metadata,
      };
    }
    if (command === "pnpm") {
      mkdirSync(join(targetDir, "release/bundle/macos/MyApp.app/Contents/MacOS"), {
        recursive: true,
      });
      return { ...ok, ...overrides.build };
    }
    if (command === "codesign" && args.includes("--entitlements")) {
      return { ...ok, stdout: SIGNED_EMPTY, ...overrides.entitlements };
    }
    if (command === "plutil") return { ...fakePlutil(options?.input), ...overrides.plutil };
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

function setup(entitlements = EMPTY_PLIST): { home: string; root: string } {
  const root = tempDir();
  writeFileSync(join(root, "Entitlements.plist"), "");
  mkdirSync(join(root, "src-tauri"), { recursive: true });
  writeFileSync(join(root, "src-tauri/Entitlements.plist"), entitlements);
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
      "a\n2026-01-01T00:00:00.000000Z  INFO myapp_lib: startup complete pid=12 smoke=true\n" +
      "2026-01-01T00:00:00.000000Z  INFO myapp_lib: startup complete pid=7 smoke=true\n";
    expect(startupLineFor(text, 7)).toBe(
      "2026-01-01T00:00:00.000000Z  INFO myapp_lib: startup complete pid=7 smoke=true",
    );
  });

  it("does not match a different pid that shares digits", () => {
    expect(startupLineFor("INFO myapp_lib: startup complete pid=77 smoke=true", 7)).toBeUndefined();
  });

  it("does not accept a UI message that quotes the startup line", () => {
    const forged = [
      "2026-01-01T00:00:00.000000Z ERROR ui: message=x startup complete pid=7",
      "2026-01-01T00:00:00.000000Z  WARN ui: message=INFO myapp_lib: startup complete pid=7",
      "2026-01-01T00:00:00.000000Z  INFO ui: startup complete pid=7",
    ].join("\n");
    expect(startupLineFor(forged, 7)).toBeUndefined();
    expect(
      startupLineFor(
        `${forged}\n2026-01-01T00:00:00.000000Z  INFO myapp_lib: startup complete pid=7`,
        7,
      ),
    ).toBe("2026-01-01T00:00:00.000000Z  INFO myapp_lib: startup complete pid=7");
  });
});

describe("canonicalJson", () => {
  it("prints equal dictionaries alike whatever their key order", () => {
    expect(canonicalJson({ b: true, a: { d: 1, c: ["x", "y"] } })).toBe(
      canonicalJson({ a: { c: ["x", "y"], d: 1 }, b: true }),
    );
  });

  it("tells apart a flipped value and a reordered array", () => {
    expect(canonicalJson({ a: true })).not.toBe(canonicalJson({ a: false }));
    expect(canonicalJson(["x", "y"])).not.toBe(canonicalJson(["y", "x"]));
  });
});

describe("entitlementsJson", () => {
  const run = (_: string, __: readonly string[], options?: RunOptions): RunResult =>
    fakePlutil(options?.input);

  it("parses a plist through plutil on stdin", () => {
    const calls: Call[] = [];
    const recording = (command: string, args: readonly string[], options?: RunOptions) => {
      calls.push({ command, args, options });
      return run(command, args, options);
    };
    expect(entitlementsJson(recording, plistWith("false"))).toEqual({
      json: canonicalJson({ [LIBRARY_VALIDATION]: false }),
    });
    expect(calls).toEqual([
      {
        command: "plutil",
        args: ["-convert", "json", "-o", "-", "-"],
        options: { input: plistWith("false") },
      },
    ]);
  });

  it("reads codesign's empty output as no entitlements, without plutil", () => {
    expect(entitlementsJson(run, " \n")).toEqual({ json: "{}" });
  });

  it("reports a plist plutil cannot read", () => {
    expect(entitlementsJson(run, "<plist><dict>")).toEqual({
      error: expect.stringContaining("plutil could not read it") as unknown,
    });
  });

  it("reports output that is not JSON", () => {
    const garbled = (): RunResult => ({ status: 0, stdout: "not json", stderr: "" });
    expect(entitlementsJson(garbled, EMPTY_PLIST)).toEqual({
      error: "plutil printed no JSON: not json",
    });
  });
});

describe("main", () => {
  it("builds the app bundle only, verifies it, runs it in smoke mode, and finds its startup line", () => {
    const { home, root } = setup();
    const { context, calls, lines } = fakeMachine(home, root);
    main(context);

    expect(calls[0]?.command).toBe("cargo");
    expect(calls[0]?.args[0]).toBe("metadata");
    // Where the Tauri CLI runs cargo, so a relative CARGO_TARGET_DIR resolves the same way.
    expect(calls[0]?.options?.cwd).toBe(join(root, "src-tauri"));
    const build = calls[1];
    expect(build?.command).toBe("pnpm");
    expect(build?.args).toEqual(["tauri", "build", "--bundles", "app", "--", "--locked"]);
    expect(build?.options?.env?.["APPLE_SIGNING_IDENTITY"]).toBeUndefined();

    const app = join(root, "target/release/bundle/macos/MyApp.app");
    expect(calls.map((c) => c.command)).toEqual([
      "cargo",
      "pnpm",
      "codesign",
      "codesign",
      "codesign",
      "plutil",
      "plutil",
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

  it("finds the bundle under the target directory cargo metadata reports (CARGO_TARGET_DIR)", () => {
    const { home, root } = setup();
    const targetDir = tempDir();
    const { context, calls, lines } = fakeMachine(home, root, { targetDir });
    main(context);
    const app = join(targetDir, "release/bundle/macos/MyApp.app");
    expect(calls.find((c) => c.command === "codesign")?.args.at(-1)).toBe(app);
    expect(calls.at(-1)?.command).toBe(join(app, "Contents/MacOS/myapp"));
    expect(lines.at(-1)).toContain(`startup complete pid=${String(PID)}`);
  });

  it("does not fall back to ./target when the bundle is elsewhere", () => {
    const { home, root } = setup();
    mkdirSync(join(root, "target/release/bundle/macos/MyApp.app/Contents/MacOS"), {
      recursive: true,
    });
    const { context } = fakeMachine(home, root, { targetDir: tempDir() });
    const { run } = context;
    const noBundle: typeof run = (command, args, options) =>
      command === "pnpm" ? { status: 0, stdout: "", stderr: "" } : run(command, args, options);
    expect(() => {
      main({ ...context, run: noBundle });
    }).toThrow(/ERR_SMOKE_APP_MISSING/);
  });

  it("uses a prebuilt app without building or asking cargo", () => {
    const { home, root } = setup();
    const app = join(root, "elsewhere/MyApp.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    const { context, calls } = fakeMachine(home, root);
    main({ ...context, argv: ["--app", app] });
    expect(calls.some((c) => c.command === "pnpm" || c.command === "cargo")).toBe(false);
    expect(calls.at(-1)?.command).toBe(join(app, "Contents/MacOS/myapp"));
  });

  const failures: [string, Parameters<typeof fakeMachine>[2], RegExp][] = [
    [
      "cargo metadata fails",
      { metadata: { status: 101, stderr: "error: no Cargo.toml" } },
      /ERR_SMOKE_TARGET_DIR/,
    ],
    [
      "cargo metadata names no target directory",
      { metadata: { stdout: "{}" } },
      /ERR_SMOKE_TARGET_DIR/,
    ],
    ["the build fails", { build: { status: 1 } }, /ERR_SMOKE_BUILD/],
    [
      "the signature does not verify",
      { verify: { status: 1, stderr: "invalid" } },
      /ERR_SMOKE_CODESIGN/,
    ],
    [
      "the app grants an entitlement the file does not",
      { entitlements: { stdout: plistWith("true") } },
      /ERR_SMOKE_ENTITLEMENTS/,
    ],
    [
      "the app's entitlements cannot be read",
      { entitlements: { status: 1, stderr: "code object is not signed at all" } },
      /ERR_SMOKE_ENTITLEMENTS/,
    ],
    [
      "plutil cannot parse the entitlements",
      { entitlements: { stdout: "<plist><dict>" } },
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

  it("passes when the app carries the file's entitlements, values included", () => {
    const { home, root } = setup(plistWith("false"));
    const { context, lines } = fakeMachine(home, root, {
      entitlements: { stdout: plistWith("false") },
    });
    main(context);
    expect(lines).toContainEqual(expect.stringContaining(`"${LIBRARY_VALIDATION}":false`));
  });

  it("fails when an entitlement's value is flipped though its key is the same", () => {
    const { home, root } = setup(plistWith("false"));
    const { context } = fakeMachine(home, root, { entitlements: { stdout: plistWith("true") } });
    const error = caught(() => {
      main(context);
    });
    expect(error.details.code).toBe("ERR_SMOKE_ENTITLEMENTS");
    expect(error.details.expected).toBe(canonicalJson({ [LIBRARY_VALIDATION]: false }));
    expect(error.details.actual).toBe(canonicalJson({ [LIBRARY_VALIDATION]: true }));
  });

  it("fails when src-tauri/Entitlements.plist cannot be parsed", () => {
    const { home, root } = setup("<plist><dict>");
    const { context } = fakeMachine(home, root);
    const error = caught(() => {
      main(context);
    });
    expect(error.details.code).toBe("ERR_SMOKE_ENTITLEMENTS");
    expect(error.details.expected).toContain(
      "src-tauri/Entitlements.plist: plutil could not read it",
    );
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
