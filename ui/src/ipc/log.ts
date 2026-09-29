/**
 * Forward the UI's warnings and errors to the app's log file through `log_from_ui`
 * (design D7). The one module in ui/src/ allowed to use `console`: when the bridge
 * itself is down, the WebView's console is the only place left to say so.
 */
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
