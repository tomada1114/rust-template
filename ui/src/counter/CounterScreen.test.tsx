import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockCommands, rejectWith } from "../ipc/testing";
import { CounterScreen } from "./CounterScreen";

describe("CounterScreen", () => {
  it("shows the next value after Increment", async () => {
    mockCommands({
      get_counter: () => ({ value: 1, lastChangedAt: null }),
      increment: () => ({ value: 2, lastChangedAt: 1_700_000_000_000 }),
    });
    render(<CounterScreen />);
    // Queried by accessible name, not by the glyph: an unlabeled control fails here.
    await userEvent.click(await screen.findByRole("button", { name: "Increment" }));
    expect(await screen.findByRole("status")).toHaveTextContent("2");
    expect(screen.getByText(/^Last changed /)).toBeInTheDocument();
  });

  it("names the counter's region and every control", async () => {
    mockCommands({ get_counter: () => ({ value: 0, lastChangedAt: null }) });
    render(<CounterScreen />);
    expect(await screen.findByRole("region", { name: "Counter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrement" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByText("Not changed yet")).toBeInTheDocument();
  });

  it("shows the loading state before the counter arrives", () => {
    mockCommands({ get_counter: () => new Promise(() => undefined) });
    render(<CounterScreen />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("explains a rejected change in an alert and keeps the value", async () => {
    mockCommands({
      get_counter: () => ({ value: 0, lastChangedAt: null }),
      decrement: () => rejectWith({ code: "atMinimum" }),
    });
    render(<CounterScreen />);
    await userEvent.click(await screen.findByRole("button", { name: "Decrement" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already at its lowest value");
    expect(screen.getByRole("status")).toHaveTextContent("0");
  });

  it("resets through the Reset button", async () => {
    const calls = mockCommands({
      get_counter: () => ({ value: 5, lastChangedAt: null }),
      reset: () => ({ value: 0, lastChangedAt: 1 }),
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

  it("shows a generic message when loading fails without a code", async () => {
    mockCommands({
      get_counter: () => rejectWith(new Error("bridge down")),
      log_from_ui: () => null,
    });
    render(<CounterScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
  });

  it("can be operated from the keyboard", async () => {
    mockCommands({
      get_counter: () => ({ value: 1, lastChangedAt: null }),
      decrement: () => ({ value: 0, lastChangedAt: 2 }),
    });
    render(<CounterScreen />);
    await screen.findByRole("status");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Decrement" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("status")).toHaveTextContent("0");
  });
});
