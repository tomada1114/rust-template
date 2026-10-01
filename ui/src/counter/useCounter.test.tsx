import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { emitEvent, eventInternals, mockCommands, rejectWith } from "../ipc/testing";
import type { CounterView } from "../ipc/types";
import { useCounter } from "./useCounter";

// Revisions follow what Rust produces: a load in a fresh process is 0, and each later
// saved change is one higher.
const ONE: CounterView = { value: 1, lastChangedAt: null, revision: 0 };
const TWO: CounterView = { value: 2, lastChangedAt: 1_700_000_000_000, revision: 0 };
const at = (view: CounterView, revision: number): CounterView => ({ ...view, revision });
const view = (value: number, revision: number): CounterView => ({
  value,
  lastChangedAt: 1,
  revision,
});

/** A command reply the test releases when it chooses. */
function held(): {
  readonly reply: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { reply: () => promise, resolve, reject };
}

/**
 * Let every promise already queued run, so a reply the test released has reached the
 * hook: a zero-delay task runs only after all pending microtasks.
 */
const settle = (): Promise<void> =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

describe("useCounter", () => {
  it("starts loading, then shows the counter Rust returns", async () => {
    mockCommands({ get_counter: () => ONE });
    const { result } = renderHook(() => useCounter());
    expect(result.current.state).toEqual({ status: "loading" });
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "ready",
        view: ONE,
        error: null,
        errorCount: 0,
      });
    });
  });

  it("shows the new view after increment", async () => {
    const calls = mockCommands({ get_counter: () => ONE, increment: () => at(TWO, 1) });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await act(() => result.current.increment());
    expect(result.current.state).toEqual({
      status: "ready",
      view: at(TWO, 1),
      error: null,
      errorCount: 0,
    });
    expect(calls).toContain("increment");
  });

  it("calls decrement and reset", async () => {
    const calls = mockCommands({
      get_counter: () => TWO,
      decrement: () => at(ONE, 1),
      reset: () => ({ value: 0, lastChangedAt: 5, revision: 2 }),
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await act(() => result.current.decrement());
    expect(result.current.state).toEqual({
      status: "ready",
      view: at(ONE, 1),
      error: null,
      errorCount: 0,
    });
    await act(() => result.current.reset());
    expect(result.current.state).toEqual({
      status: "ready",
      view: { value: 0, lastChangedAt: 5, revision: 2 },
      error: null,
      errorCount: 0,
    });
    expect(calls).toEqual(expect.arrayContaining(["decrement", "reset"]));
  });

  it("keeps the view and holds the error code when Rust rejects a change", async () => {
    mockCommands({
      get_counter: () => TWO,
      increment: () => rejectWith({ code: "atMaximum" }),
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await act(() => result.current.increment());
    expect(result.current.state).toEqual({
      status: "ready",
      view: TWO,
      error: { code: "atMaximum" },
      errorCount: 1,
    });
  });

  it("clears the error after the next successful change", async () => {
    let first = true;
    mockCommands({
      get_counter: () => TWO,
      increment: () => rejectWith({ code: "atMaximum" }),
      decrement: () => {
        const reply = first ? at(ONE, 1) : at(TWO, 2);
        first = false;
        return reply;
      },
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await act(() => result.current.increment());
    await act(() => result.current.decrement());
    expect(result.current.state).toEqual({
      status: "ready",
      view: at(ONE, 1),
      error: null,
      errorCount: 0,
    });
  });

  it("counts repeated rejections and resets the count on the next success", async () => {
    mockCommands({
      get_counter: () => TWO,
      increment: () => rejectWith({ code: "atMaximum" }),
      decrement: () => at(ONE, 1),
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await act(() => result.current.increment());
    await act(() => result.current.increment());
    expect(result.current.state).toEqual({
      status: "ready",
      view: TWO,
      error: { code: "atMaximum" },
      errorCount: 2,
    });
    await act(() => result.current.decrement());
    expect(result.current.state).toEqual({
      status: "ready",
      view: at(ONE, 1),
      error: null,
      errorCount: 0,
    });
  });

  it("fails with the error code when the first load is rejected", async () => {
    mockCommands({ get_counter: () => rejectWith({ code: "storage", kind: "corrupt" }) });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "failed",
        error: { code: "storage", kind: "corrupt" },
        errorCount: 0,
      });
    });
  });

  it("fails as unexpected, and logs, when the rejection is not a CounterError", async () => {
    const calls = mockCommands({
      get_counter: () => rejectWith(new Error("bridge down")),
      log_from_ui: () => null,
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "failed",
        error: "unexpected",
        errorCount: 0,
      });
    });
    await waitFor(() => {
      expect(calls).toContain("log_from_ui");
    });
  });

  it("keeps the view and replaces an earlier error when a change fails without a code", async () => {
    let first = true;
    mockCommands({
      get_counter: () => TWO,
      increment: () => {
        const payload = first ? { code: "atMaximum" } : new Error("bridge down");
        first = false;
        return rejectWith(payload);
      },
      log_from_ui: () => null,
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await act(() => result.current.increment());
    await act(() => result.current.increment());
    expect(result.current.state).toEqual({
      status: "ready",
      view: TWO,
      error: "unexpected",
      errorCount: 2,
    });
  });

  it("names the rejection's type, never its message, in the log line", async () => {
    const messages: unknown[] = [];
    mockCommands({
      get_counter: () => rejectWith(new TypeError("secret detail")),
      log_from_ui: (args) => {
        messages.push(args);
        return null;
      },
    });
    renderHook(() => useCounter());
    await waitFor(() => {
      expect(messages).toEqual([
        {
          entry: {
            level: "error",
            message: "get_counter failed without a counter error code: TypeError",
          },
        },
      ]);
    });
  });

  it("logs, and still loads, when listening for counter-changed fails", async () => {
    const messages: unknown[] = [];
    mockCommands(
      {
        get_counter: () => ONE,
        "plugin:event|listen": () => rejectWith(new RangeError("no event plugin")),
        log_from_ui: (args) => {
          messages.push(args);
          return null;
        },
      },
      { mockEvents: false },
    );
    const { result, unmount } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "ready",
        view: ONE,
        error: null,
        errorCount: 0,
      });
    });
    await waitFor(() => {
      expect(messages).toEqual([
        {
          entry: {
            level: "error",
            message: "listening for counter-changed failed: RangeError",
          },
        },
      ]);
    });
    unmount();
  });

  it("follows counter-changed events, which the shell emits after any window's change", async () => {
    mockCommands({ get_counter: () => ONE });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await act(() => emitEvent("counter-changed", at(TWO, 1)));
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "ready",
        view: at(TWO, 1),
        error: null,
        errorCount: 0,
      });
    });
  });

  it("stops listening when unmounted", async () => {
    mockCommands({ get_counter: () => ONE });
    const unregister = vi.spyOn(eventInternals(), "unregisterListener");
    const { result, unmount } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    unmount();
    await waitFor(() => {
      expect(unregister).toHaveBeenCalledWith("counter-changed", expect.any(Number));
    });
  });

  it("keeps an event that arrived while the load was pending over the older load", async () => {
    const load = held();
    const calls = mockCommands({ get_counter: load.reply });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(calls).toContain("get_counter");
    });
    await act(() => emitEvent("counter-changed", view(7, 2)));
    load.resolve(view(6, 1));
    await settle();
    expect(result.current.state).toEqual({
      status: "ready",
      view: view(7, 2),
      error: null,
      errorCount: 0,
    });
  });

  it("subscribes before it loads, so an event emitted during the load is seen", async () => {
    mockCommands({
      get_counter: async () => {
        await emitEvent("counter-changed", view(7, 2));
        return view(6, 1);
      },
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await settle();
    expect(result.current.state).toEqual({
      status: "ready",
      view: view(7, 2),
      error: null,
      errorCount: 0,
    });
  });

  it("keeps a newer event over an older reply to its own change", async () => {
    const reply = held();
    mockCommands({ get_counter: () => view(7, 1), increment: reply.reply });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.increment();
    });
    await act(() => emitEvent("counter-changed", view(9, 3)));
    reply.resolve(view(8, 2));
    await act(() => pending);
    expect(result.current.state).toEqual({
      status: "ready",
      view: view(9, 3),
      error: null,
      errorCount: 0,
    });
  });

  it("takes a view with the same revision as the one shown, since it arrived later", async () => {
    mockCommands({ get_counter: () => view(5, 0) });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await act(() => emitEvent("counter-changed", view(6, 0)));
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "ready",
        view: view(6, 0),
        error: null,
        errorCount: 0,
      });
    });
  });

  it("keeps the view an event showed when the load then fails", async () => {
    const load = held();
    const calls = mockCommands({ get_counter: load.reply });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(calls).toContain("get_counter");
    });
    await act(() => emitEvent("counter-changed", view(7, 1)));
    load.reject({ code: "storage", kind: "unavailable" });
    await settle();
    expect(result.current.state).toEqual({
      status: "ready",
      view: view(7, 1),
      error: null,
      errorCount: 0,
    });
  });

  it("leaves the failed state when an event arrives", async () => {
    mockCommands({ get_counter: () => rejectWith({ code: "storage", kind: "corrupt" }) });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    await act(() => emitEvent("counter-changed", view(0, 1)));
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "ready",
        view: view(0, 1),
        error: null,
        errorCount: 0,
      });
    });
  });

  it("loads again on retry after a failed load", async () => {
    let first = true;
    const calls = mockCommands({
      get_counter: () => {
        if (!first) return ONE;
        first = false;
        return rejectWith({ code: "storage", kind: "unavailable" });
      },
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "failed",
        error: { code: "storage", kind: "unavailable" },
        errorCount: 0,
      });
    });
    act(() => {
      result.current.retry();
    });
    expect(result.current.state).toEqual({ status: "loading" });
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "ready",
        view: ONE,
        error: null,
        errorCount: 0,
      });
    });
    expect(calls.filter((cmd) => cmd === "get_counter")).toHaveLength(2);
  });

  it("leaves a ready state alone on retry", async () => {
    mockCommands({ get_counter: () => ONE });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    act(() => {
      result.current.retry();
    });
    expect(result.current.state).toEqual({
      status: "ready",
      view: ONE,
      error: null,
      errorCount: 0,
    });
  });

  it("resets from the failed state", async () => {
    mockCommands({
      get_counter: () => rejectWith({ code: "storage", kind: "corrupt" }),
      reset: () => view(0, 1),
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    await act(() => result.current.reset());
    expect(result.current.state).toEqual({
      status: "ready",
      view: view(0, 1),
      error: null,
      errorCount: 0,
    });
  });

  it("shows why a reset from the failed state failed", async () => {
    mockCommands({
      get_counter: () => rejectWith({ code: "storage", kind: "corrupt" }),
      reset: () => rejectWith({ code: "storage", kind: "unavailable" }),
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    await act(() => result.current.reset());
    expect(result.current.state).toEqual({
      status: "failed",
      error: { code: "storage", kind: "unavailable" },
      errorCount: 1,
    });
  });

  it("stops listening, and never loads, when unmounted before listening starts", async () => {
    const calls = mockCommands({ get_counter: () => ONE });
    const unregister = vi.spyOn(eventInternals(), "unregisterListener");
    const { unmount } = renderHook(() => useCounter());
    unmount();
    await waitFor(() => {
      expect(unregister).toHaveBeenCalledWith("counter-changed", expect.any(Number));
    });
    expect(calls).not.toContain("get_counter");
  });
});
