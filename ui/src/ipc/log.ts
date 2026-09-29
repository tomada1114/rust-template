/**
 * Forward the UI's warnings and errors to the app's log file through `log_from_ui`
 * (design D7). The one module in ui/src/ allowed to use `console`: when the bridge
 * itself is down, the WebView's console is the only place left to say so.
 */
import type { RootOptions } from "react-dom/client";

import { logFromUi } from "./commands";

async function forward(level: "warn" | "error", message: string): Promise<void> {
  try {
    await logFromUi({ level, message });
  } catch (error: unknown) {
    console.error("log_from_ui failed", error, message);
  }
}

/** Log a problem the UI recovered from. The message must carry no user data. */
export const logWarning = (message: string): Promise<void> => forward("warn", message);

/** Log a failure. The message must carry no user data. */
export const logError = (message: string): Promise<void> => forward("error", message);

/**
 * What kind of value was thrown, for a log line: an `Error`'s name (`TypeError`), or
 * `typeof` for anything else (`string`, `object`). Never the message, which may carry
 * user data.
 */
export function errorType(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (error === null) return "null";
  return typeof error;
}

/**
 * The React root's error callbacks (`createRoot(container, rootErrorLogging)`), so an
 * error thrown while rendering reaches the log file instead of only the WebView console.
 * An uncaught one also unmounts the whole tree.
 */
export const rootErrorLogging = {
  onUncaughtError: (error: unknown) => {
    void logError(`uncaught render error: ${errorType(error)}`);
  },
  onCaughtError: (error: unknown) => {
    void logError(`render error caught by an error boundary: ${errorType(error)}`);
  },
  onRecoverableError: (error: unknown) => {
    void logWarning(`render error React recovered from: ${errorType(error)}`);
  },
} satisfies RootOptions;

/**
 * Log what escapes every handler: an uncaught exception outside rendering (`error`) and
 * a promise rejection no one caught (`unhandledrejection`). Returns a function that
 * removes both listeners.
 */
export function logUnhandledErrors(target: Window): () => void {
  const onError = (event: ErrorEvent): void => {
    void logError(`uncaught error: ${errorType(event.error)}`);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    void logError(`unhandled promise rejection: ${errorType(event.reason)}`);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
