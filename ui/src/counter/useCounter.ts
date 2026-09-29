/**
 * The counter screen's model: a thin mirror of the counter Rust owns. It loads through
 * `ipc/commands.ts`, follows `counter-changed` from `ipc/events.ts`, and decides nothing
 * itself (building-react-screens).
 */
import { useCallback, useEffect, useState } from "react";

import * as commands from "../ipc/commands";
import { isCounterError } from "../ipc/errors";
import { onCounterChanged } from "../ipc/events";
import { logError } from "../ipc/log";
import type { CounterError, CounterView } from "../ipc/types";

export type CounterState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: CounterError | null }
  | { readonly status: "ready"; readonly view: CounterView; readonly error: CounterError | null };

export interface UseCounter {
  readonly state: CounterState;
  readonly increment: () => Promise<void>;
  readonly decrement: () => Promise<void>;
  readonly reset: () => Promise<void>;
}

/** A rejection as the screen shows it: a known code, or `null` (logged) for anything else. */
function toCounterError(error: unknown, action: string): CounterError | null {
  if (isCounterError(error)) return error;
  void logError(`${action} failed without a counter error code`);
  return null;
}

export function useCounter(): UseCounter {
  const [state, setState] = useState<CounterState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    const showView = (view: CounterView): void => {
      if (active) setState({ status: "ready", view, error: null });
    };
    commands.getCounter().then(showView, (error: unknown) => {
      if (active) setState({ status: "failed", error: toCounterError(error, "get_counter") });
    });
    const unlisten = onCounterChanged(showView);
    return () => {
      active = false;
      void unlisten.then((stop) => {
        stop();
      });
    };
  }, []);

  const change = useCallback(async (name: string, action: () => Promise<CounterView>) => {
    try {
      const view = await action();
      setState({ status: "ready", view, error: null });
    } catch (error: unknown) {
      const code = toCounterError(error, name);
      setState((current) => (current.status === "ready" ? { ...current, error: code } : current));
    }
  }, []);

  return {
    state,
    increment: useCallback(() => change("increment", commands.increment), [change]),
    decrement: useCallback(() => change("decrement", commands.decrement), [change]),
    reset: useCallback(() => change("reset", commands.reset), [change]),
  };
}
