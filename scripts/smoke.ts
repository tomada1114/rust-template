/**
 * `just smoke`: the launch smoke (design D15, D22). Builds the release `.app` (app bundle
 * only — never a disk image locally), checks its signature, its entitlements, and the
 * bundled helper, then runs the app's executable directly with `MYAPP_SMOKE=1` — never
 * through `open`, which would activate it. In smoke mode the app shows no window, takes
 * no focus, logs `startup complete pid=<pid>`, and exits 0; this script requires both.
 * It first runs the executable in smoke mode with `HOME` unset, which must fail startup
 * cleanly: exit 1 (not a signal) and `HOME is not set` on stderr.
 *
 * Failure codes: ERR_SMOKE_ARGS, ERR_SMOKE_HOME, ERR_SMOKE_BUILD, ERR_SMOKE_APP_MISSING,
 * ERR_SMOKE_CODESIGN, ERR_SMOKE_ENTITLEMENTS, ERR_SMOKE_SIDECAR, ERR_SMOKE_STARTUP_ERROR,
 * ERR_SMOKE_EXIT, ERR_SMOKE_STARTUP_LINE.
 *
 * Usage: node scripts/smoke.ts [--app <path to MyApp.app>]
 * With --app it checks an already-built bundle (the release workflow's artifact) instead
 * of building one.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

const BUNDLE_IDENTIFIER = "com.example.myapp";
const APP_NAME = "MyApp";
const EXECUTABLE = "myapp";
const HELPER = "myapp-cli";
const SMOKE_ENV = "MYAPP_SMOKE";
const LOG_PREFIX = "myapp";
const LAUNCH_TIMEOUT_MS = 60_000;
/** What the app prints when startup fails for want of `HOME` (`StartupError::NoHome`). */
const NO_HOME_MESSAGE = "HOME is not set";

export interface SmokeOptions {
  readonly build: boolean;
  readonly app: string | undefined;
}

export function parseSmokeArgs(argv: readonly string[]): SmokeOptions {
  if (argv.length === 0) return { build: true, app: undefined };
  const [flag, app, ...rest] = argv;
  if (flag !== "--app" || app === undefined || rest.length > 0) {
    throw new ScriptError({
      code: "ERR_SMOKE_ARGS",
      summary: "unrecognised arguments",
      expected: "no arguments, or --app <path to the .app bundle>",
      actual: argv.join(" "),
      next: "run `just smoke`",
    });
  }
  return { build: false, app };
}

/** The newest `<prefix>.*.log` in `dir` by modification time (file names are dated in UTC). */
export function newestLog(dir: string, prefix: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(`${prefix}.`) && name.endsWith(".log"))
    .map((name) => join(dir, name))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path;
}

/**
 * The shell's own `startup complete` line written by the process with this pid, if any:
 * an optional timestamp, `INFO`, then a target other than `ui` (the bootstrap renames the
 * shell's crate, so its target is not spelled out) — a UI message quoting the text never
 * matches.
 */
export function startupLineFor(text: string, pid: number): string | undefined {
  const pattern = new RegExp(
    `^(?:\\S+\\s+)?INFO (?!ui:)[A-Za-z0-9_:]+: startup complete pid=${String(pid)}\\b`,
  );
  return text.split("\n").find((line) => pattern.test(line));
}

/** The keys an entitlements plist grants, sorted. */
export function entitlementKeys(plist: string): string[] {
  return [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1] ?? "").sort();
}

function fail(
  code: string,
  summary: string,
  expected: string,
  actual: string,
  next: string,
): never {
  throw new ScriptError({ code, summary, expected, actual, next });
}

/** The environment without signing variables: a local build never signs as a developer. */
function withoutSigning(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("APPLE_")));
}

function withoutHome(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== "HOME"));
}

export function main(context: ScriptContext): void {
  const options = parseSmokeArgs(context.argv);
  const { root, run, log } = context;
  const home = context.env["HOME"];
  if (home === undefined || home === "") {
    fail(
      "ERR_SMOKE_HOME",
      "HOME is not set",
      "HOME to name the user's home directory",
      "unset",
      "run from a login shell",
    );
  }

  let app = options.app ?? join(root, "target", "release", "bundle", "macos", `${APP_NAME}.app`);
  if (options.build) {
    log("smoke: building the release app bundle (no disk image)");
    const built = run("pnpm", ["tauri", "build", "--bundles", "app", "--", "--locked"], {
      cwd: root,
      inherit: true,
      env: withoutSigning(context.env),
    });
    if (built.status !== 0) {
      fail(
        "ERR_SMOKE_BUILD",
        "the release build failed",
        "`pnpm tauri build --bundles app -- --locked` to exit 0",
        `exit status ${String(built.status)}`,
        "read the build output above, fix it, and rerun `just smoke`",
      );
    }
    app = join(root, "target", "release", "bundle", "macos", `${APP_NAME}.app`);
  }
  if (!existsSync(app)) {
    fail(
      "ERR_SMOKE_APP_MISSING",
      "the app bundle is not there",
      app,
      "no such directory",
      "build it with `just smoke` (no --app), or pass the right path",
    );
  }

  const verify = run("codesign", ["--verify", "--deep", "--strict", app]);
  if (verify.status !== 0) {
    fail(
      "ERR_SMOKE_CODESIGN",
      "the app's signature does not verify",
      "`codesign --verify --deep --strict` to exit 0",
      verify.stderr.trim(),
      "check bundle.macOS.signingIdentity in src-tauri/tauri.conf.json",
    );
  }
  const helper = join(app, "Contents", "MacOS", HELPER);
  const helperSigned = run("codesign", ["--verify", "--strict", helper]);
  if (helperSigned.status !== 0) {
    fail(
      "ERR_SMOKE_CODESIGN",
      "the bundled helper is not signed",
      `a valid signature on ${HELPER}`,
      helperSigned.stderr.trim(),
      "rebuild with `just smoke`; Tauri signs externalBin files with the app",
    );
  }
  const granted = run("codesign", ["-d", "--entitlements", "-", "--xml", app]);
  const expected = entitlementKeys(
    readFileSync(join(root, "src-tauri", "Entitlements.plist"), "utf8"),
  );
  const actual = entitlementKeys(granted.stdout);
  if (granted.status !== 0 || actual.join(",") !== expected.join(",")) {
    fail(
      "ERR_SMOKE_ENTITLEMENTS",
      "the app's entitlements differ from src-tauri/Entitlements.plist",
      `[${expected.join(", ")}]`,
      `[${actual.join(", ")}]`,
      "rebuild; if it persists, check bundle.macOS.entitlements in tauri.conf.json",
    );
  }
  log(`smoke: signature and entitlements [${actual.join(", ")}] verified`);

  const version = run(helper, ["--version"]);
  if (version.status !== 0) {
    fail(
      "ERR_SMOKE_SIDECAR",
      "the bundled helper does not run",
      `${HELPER} --version to exit 0`,
      `exit status ${String(version.status)}`,
      "check scripts/build-sidecar.ts and bundle.externalBin",
    );
  }
  log(`smoke: bundled helper answers "${version.stdout.trim()}"`);

  const executable = join(app, "Contents", "MacOS", EXECUTABLE);
  const homeless = run(executable, [], {
    env: { ...withoutHome(withoutSigning(context.env)), [SMOKE_ENV]: "1" },
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
  if (homeless.status !== 1 || !homeless.stderr.includes(NO_HOME_MESSAGE)) {
    fail(
      "ERR_SMOKE_STARTUP_ERROR",
      "a startup error did not exit 1 with its reason",
      `exit status 1 and "${NO_HOME_MESSAGE}" on stderr when HOME is unset`,
      homeless.status === null
        ? `no exit (a signal or a timeout: ${homeless.stderr.trim()})`
        : `exit status ${String(homeless.status)}, stderr: ${homeless.stderr.trim()}`,
      "check that run() in src-tauri/src/lib.rs reports StartupError and exits 1",
    );
  }
  log(`smoke: with HOME unset the app exits 1: ${homeless.stderr.trim()}`);

  const launched = run(executable, [], {
    env: { ...withoutSigning(context.env), [SMOKE_ENV]: "1" },
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
  if (launched.status !== 0) {
    fail(
      "ERR_SMOKE_EXIT",
      "the app did not exit 0 in smoke mode",
      `exit 0 within ${String(LAUNCH_TIMEOUT_MS)} ms`,
      launched.status === null
        ? `no exit (${launched.stderr.trim()})`
        : `exit status ${String(launched.status)}`,
      "read the app's log with `just logs`",
    );
  }
  const logDir = join(home, "Library", "Logs", BUNDLE_IDENTIFIER);
  const logFile = newestLog(logDir, LOG_PREFIX);
  const line =
    logFile === undefined
      ? undefined
      : startupLineFor(readFileSync(logFile, "utf8"), launched.pid ?? 0);
  if (line === undefined) {
    const listing = existsSync(logDir) ? readdirSync(logDir).join(", ") : "(no log directory)";
    fail(
      "ERR_SMOKE_STARTUP_LINE",
      "the app exited 0 but logged no startup line for its pid",
      `"startup complete pid=${String(launched.pid)}" in the newest ${LOG_PREFIX}.*.log`,
      `files in ${logDir}: ${listing}`,
      "check that run() still logs `startup complete` with the pid",
    );
  }
  log(`smoke: ${line}`);
}

if (import.meta.main) await runScript(main);
