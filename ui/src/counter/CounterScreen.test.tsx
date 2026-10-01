import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { counterCopy } from "../copy/counter";
import { mockCommands, rejectWith } from "../ipc/testing";
import { CounterScreen } from "./CounterScreen";

describe("CounterScreen", () => {
  it("shows the next value after Increment", async () => {
    mockCommands({
      get_counter: () => ({ value: 1, lastChangedAt: null, revision: 0 }),
      increment: () => ({ value: 2, lastChangedAt: 1_700_000_000_000, revision: 1 }),
    });
    render(<CounterScreen />);
    // Queried by accessible name, not by the glyph: an unlabeled control fails here.
    await userEvent.click(await screen.findByRole("button", { name: "Increment" }));
    expect(await screen.findByRole("status")).toHaveTextContent("2");
    expect(screen.getByText(/^Last changed /)).toBeInTheDocument();
  });

  it("names the counter's region and every control", async () => {
    mockCommands({ get_counter: () => ({ value: 0, lastChangedAt: null, revision: 0 }) });
    render(<CounterScreen />);
    expect(await screen.findByRole("region", { name: "Counter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrement" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByText("Not changed yet")).toBeInTheDocument();
  });

  it("names the value's status after the counter's title", async () => {
    mockCommands({ get_counter: () => ({ value: 4, lastChangedAt: null, revision: 0 }) });
    render(<CounterScreen />);
    expect(await screen.findByRole("status", { name: "Counter" })).toHaveTextContent("4");
  });

  it("mounts a new alert for a second identical failure, so it is announced again", async () => {
    mockCommands({
      get_counter: () => ({ value: 0, lastChangedAt: null, revision: 0 }),
      decrement: () => rejectWith({ code: "atMinimum" }),
    });
    render(<CounterScreen />);
    const decrement = await screen.findByRole("button", { name: "Decrement" });
    await userEvent.click(decrement);
    const first = await screen.findByRole("alert");
    await userEvent.click(decrement);
    await waitFor(() => {
      expect(screen.getByRole("alert")).not.toBe(first);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("already at its lowest value");
  });

  it("shows the loading state before the counter arrives", () => {
    mockCommands({ get_counter: () => new Promise(() => undefined) });
    render(<CounterScreen />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("explains a rejected change in an alert and keeps the value", async () => {
    mockCommands({
      get_counter: () => ({ value: 0, lastChangedAt: null, revision: 0 }),
      decrement: () => rejectWith({ code: "atMinimum" }),
    });
    render(<CounterScreen />);
    await userEvent.click(await screen.findByRole("button", { name: "Decrement" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already at its lowest value");
    expect(screen.getByRole("status")).toHaveTextContent("0");
  });

  it("shows the generic sentence in an alert when a change fails without a code", async () => {
    mockCommands({
      get_counter: () => ({ value: 3, lastChangedAt: null, revision: 0 }),
      increment: () => rejectWith(new Error("bridge down")),
      log_from_ui: () => null,
    });
    render(<CounterScreen />);
    await userEvent.click(await screen.findByRole("button", { name: "Increment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(counterCopy.unexpected);
    expect(screen.getByRole("status")).toHaveTextContent("3");
  });

  it("resets through the Reset button", async () => {
    const calls = mockCommands({
      get_counter: () => ({ value: 5, lastChangedAt: null, revision: 0 }),
      reset: () => ({ value: 0, lastChangedAt: 1, revision: 1 }),
    });
    render(<CounterScreen />);
    await userEvent.click(await screen.findByRole("button", { name: "Reset" }));
    expect(await screen.findByRole("status")).toHaveTextContent("0");
    expect(calls).toContain("reset");
  });

  it("shows why the counter could not load", async () => {
    mockCommands({ get_counter: () => rejectWith({ code: "storage", kind: "corrupt" }) });
    render(<CounterScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be read");
  });

  it("offers Retry and Reset when the saved counter cannot be read, and Reset replaces it", async () => {
    const calls = mockCommands({
      get_counter: () => rejectWith({ code: "storage", kind: "corrupt" }),
      reset: () => ({ value: 0, lastChangedAt: 1, revision: 1 }),
    });
    render(<CounterScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be read");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(await screen.findByRole("status")).toHaveTextContent("0");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls).toContain("reset");
  });

  it("mounts a new alert when Reset fails twice the same way on the error screen", async () => {
    mockCommands({
      get_counter: () => rejectWith({ code: "storage", kind: "corrupt" }),
      reset: () => rejectWith({ code: "storage", kind: "corrupt" }),
    });
    render(<CounterScreen />);
    const loadAlert = await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).not.toBe(loadAlert);
    });
    const first = screen.getByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).not.toBe(first);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("could not be read");
  });

  it("offers only Retry when the counter is unavailable, and Retry loads it", async () => {
    let first = true;
    mockCommands({
      get_counter: () => {
        if (!first) return { value: 3, lastChangedAt: null, revision: 0 };
        first = false;
        return rejectWith({ code: "storage", kind: "unavailable" });
      },
    });
    render(<CounterScreen />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    await userEvent.click(retry);
    expect(await screen.findByRole("status")).toHaveTextContent("3");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a generic message when loading fails without a code", async () => {
    mockCommands({
      get_counter: () => rejectWith(new Error("bridge down")),
      log_from_ui: () => null,
    });
    render(<CounterScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });

  it("can be operated from the keyboard", async () => {
    mockCommands({
      get_counter: () => ({ value: 1, lastChangedAt: null, revision: 0 }),
      decrement: () => ({ value: 0, lastChangedAt: 2, revision: 1 }),
    });
    render(<CounterScreen />);
    await screen.findByRole("status");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Decrement" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("status")).toHaveTextContent("0");
  });
});
