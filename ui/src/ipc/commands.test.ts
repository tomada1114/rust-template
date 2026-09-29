import { describe, expect, it } from "vitest";

import { decrement, getCounter, increment, logFromUi, reset } from "./commands";
import { mockCommands, rejectWith } from "./testing";

const VIEW = { value: 3, lastChangedAt: null };

describe("commands", () => {
  it("invokes each counter command by its Rust name and returns the view", async () => {
    const calls = mockCommands({
      get_counter: () => VIEW,
      increment: () => VIEW,
      decrement: () => VIEW,
      reset: () => VIEW,
    });
    expect(await getCounter()).toEqual(VIEW);
    expect(await increment()).toEqual(VIEW);
    expect(await decrement()).toEqual(VIEW);
    expect(await reset()).toEqual(VIEW);
    expect(calls).toEqual(["get_counter", "increment", "decrement", "reset"]);
  });

  it("passes the log entry under the argument name Rust expects", async () => {
    const received: unknown[] = [];
    mockCommands({
      log_from_ui: (args) => {
        received.push(args);
        return null;
      },
    });
    await logFromUi({ level: "warn", message: "careful" });
    expect(received).toEqual([{ entry: { level: "warn", message: "careful" } }]);
  });

  it("rejects with Rust's error payload", async () => {
    mockCommands({ increment: () => rejectWith({ code: "atMaximum" }) });
    await expect(increment()).rejects.toEqual({ code: "atMaximum" });
  });
});
