import { describe, expect, it, vi } from "vitest";

import { logError, logWarning } from "./log";
import { mockCommands, rejectWith } from "./testing";

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
