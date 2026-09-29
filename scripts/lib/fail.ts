/**
 * The failure contract every repository script follows (design D12): the first stderr
 * line is `ERR_<STAGE>_<WHAT>: <summary>`, then `Expected:`, `Actual:`, and `Next:`,
 * and the process exits 1 (or the exit code the error names, such as a hook's 2). A
 * message never contains a secret.
 */
export interface FailureDetails {
  readonly code: string;
  readonly summary: string;
  readonly expected: string;
  readonly actual: string;
  readonly next: string;
}

/** A failure that already knows how to explain itself. */
export class ScriptError extends Error {
  readonly details: FailureDetails;
  /** The process exit code; 1 unless the caller needs another (a Claude Code hook uses 2). */
  readonly exitCode: number;

  constructor(details: FailureDetails, options: { readonly exitCode?: number } = {}) {
    super(`${details.code}: ${details.summary}`);
    this.name = "ScriptError";
    this.details = details;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** The four-line report for a failure. */
export function formatFailure(details: FailureDetails): string {
  return [
    `${details.code}: ${details.summary}`,
    `Expected: ${details.expected}`,
    `Actual: ${details.actual}`,
    `Next: ${details.next}`,
  ].join("\n");
}

/**
 * Run a script's `main`, turning a thrown {@link ScriptError} into the failure report
 * and its exit code. Any other error is reported as `ERR_INTERNAL_UNEXPECTED`, exit 1.
 */
export async function runMain(
  main: () => Promise<void> | void,
  io: { error: (line: string) => void; exit: (code: number) => void } = {
    error: (line) => {
      process.stderr.write(`${line}\n`);
    },
    exit: (code) => {
      process.exitCode = code;
    },
  },
): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    const details: FailureDetails =
      error instanceof ScriptError
        ? error.details
        : {
            code: "ERR_INTERNAL_UNEXPECTED",
            summary: error instanceof Error ? error.message : String(error),
            expected: "the script to finish or fail with a named ERR_ code",
            actual: "an unexpected exception",
            next: "report this as a bug in the script, with the command you ran",
          };
    io.error(formatFailure(details));
    io.exit(error instanceof ScriptError ? error.exitCode : 1);
  }
}
