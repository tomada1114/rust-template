import { Component, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { errorType, logError, logUnhandledErrors, logWarning, rootErrorLogging } from "./log";
import { mockCommands, rejectWith } from "./testing";

/** Mock `log_from_ui` and collect every entry it receives. */
function recordLog(): unknown[] {
  const entries: unknown[] = [];
  mockCommands({
    log_from_ui: (args) => {
      entries.push(args);
      return null;
    },
  });
  return entries;
}

function Throws(): ReactNode {
  throw new TypeError("secret detail");
}

class Boundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Render `element` into a detached root created with the app's error callbacks. Not
 * wrapped in `act`: inside it, React rethrows a render error instead of handing it to
 * the root's callbacks.
 */
function renderInRoot(element: ReactNode): Root {
  const root = createRoot(document.createElement("div"), rootErrorLogging);
  root.render(element);
  return root;
}

describe("log", () => {
  it("forwards warnings and errors to log_from_ui", async () => {
    const received: unknown[] = [];
    mockCommands({
      log_from_ui: (args) => {
        received.push(args);
        return null;
      },
    });
    await logWarning("w");
    await logError("e");
    expect(received).toEqual([
      { entry: { level: "warn", message: "w" } },
      { entry: { level: "error", message: "e" } },
    ]);
  });

  it("falls back to the console when the bridge fails", async () => {
    mockCommands({ log_from_ui: () => rejectWith(new Error("down")) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await logError("lost");
    expect(consoleError).toHaveBeenCalledWith("log_from_ui failed", expect.anything(), "lost");
  });
});

describe("errorType", () => {
  it.each([
    [new TypeError("x"), "TypeError"],
    [new Error("x"), "Error"],
    ["a string", "string"],
    [{ code: "storage" }, "object"],
    [null, "null"],
    [undefined, "undefined"],
  ])("names %o as %s", (error, expected) => {
    expect(errorType(error)).toBe(expected);
  });
});

describe("rootErrorLogging", () => {
  it("logs a child that throws during render, by type and not message", async () => {
    const entries = recordLog();
    const root = renderInRoot(createElement(Throws));
    await vi.waitFor(() => {
      expect(entries).toEqual([
        { entry: { level: "error", message: "uncaught render error: TypeError" } },
      ]);
    });
    root.unmount();
  });

  it("logs a render error an error boundary caught", async () => {
    const entries = recordLog();
    const root = renderInRoot(createElement(Boundary, null, createElement(Throws)));
    await vi.waitFor(() => {
      expect(entries).toEqual([
        {
          entry: {
            level: "error",
            message: "render error caught by an error boundary: TypeError",
          },
        },
      ]);
    });
    root.unmount();
  });

  it("logs a recoverable render error as a warning", async () => {
    const entries = recordLog();
    rootErrorLogging.onRecoverableError(new RangeError("x"));
    await vi.waitFor(() => {
      expect(entries).toEqual([
        { entry: { level: "warn", message: "render error React recovered from: RangeError" } },
      ]);
    });
  });
});

describe("logUnhandledErrors", () => {
  it("logs an uncaught error and an unhandled rejection until removed", async () => {
    const entries = recordLog();
    const remove = logUnhandledErrors(window);
    window.dispatchEvent(new ErrorEvent("error", { error: new SyntaxError("x") }));
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: new RangeError("y") }),
    );
    remove();
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: new EvalError("z") }),
    );
    await vi.waitFor(() => {
      expect(entries).toEqual([
        { entry: { level: "error", message: "uncaught error: SyntaxError" } },
        { entry: { level: "error", message: "unhandled promise rejection: RangeError" } },
      ]);
    });
  });
});
