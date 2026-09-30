import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { emitEvent, eventInternals, mockCommands, rejectWith } from "../ipc/testing";
import type { CounterView } from "../ipc/types";
import { useCounter } from "./useCounter";

const ONE: CounterView = { value: 1, lastChangedAt: null };
const TWO: CounterView = { value: 2, lastChangedAt: 1_700_000_000_000 };

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
    const calls = mockCommands({ get_counter: () => ONE, increment: () => TWO });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await act(() => result.current.increment());
    expect(result.current.state).toEqual({
      status: "ready",
      view: TWO,
      error: null,
      errorCount: 0,
    });
    expect(calls).toContain("increment");
  });

  it("calls decrement and reset", async () => {
    const calls = mockCommands({
      get_counter: () => TWO,
      decrement: () => ONE,
      reset: () => ({ value: 0, lastChangedAt: 5 }),
    });
    const { result } = renderHook(() => useCounter());
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    await act(() => result.current.decrement());
    expect(result.current.state).toEqual({
      status: "ready",
      view: ONE,
      error: null,
      errorCount: 0,
    });
    await act(() => result.current.reset());
    expect(result.current.state).toEqual({
      status: "ready",
      view: { value: 0, lastChangedAt: 5 },
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
        const view = first ? ONE : TWO;
        first = false;
        return view;
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
      view: ONE,
      error: null,
      errorCount: 0,
    });
  });

  it("counts repeated rejections and resets the count on the next success", async () => {
    mockCommands({
      get_counter: () => TWO,
      increment: () => rejectWith({ code: "atMaximum" }),
      decrement: () => ONE,
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
      view: ONE,
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
      expect(result.current.state).toEqual({ status: "failed", error: "unexpected" });
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
    await act(() => emitEvent("counter-changed", TWO));
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "ready",
        view: TWO,
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
});
