/**
 * The counter screen's model: a thin mirror of the counter Rust owns. It loads through
 * `ipc/commands.ts` and follows `counter-changed` from `ipc/events.ts`. It subscribes to
 * `counter-changed` before it loads, keeps the view with the highest revision
 * (`CounterView.revision`), and decides nothing else (building-react-screens).
 */
import { useCallback, useEffect, useState } from "react";

import * as commands from "../ipc/commands";
import { isCounterError } from "../ipc/errors";
import { onCounterChanged, type UnlistenFn } from "../ipc/events";
import { errorType, logError } from "../ipc/log";
import type { CounterError, CounterView } from "../ipc/types";

/**
 * Why the load or an action failed: the code Rust rejected with, or `"unexpected"` for
 * any other rejection, which is logged and shown as a generic sentence.
 */
export type CounterFailure = CounterError | "unexpected";

export type CounterState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: CounterFailure }
  | {
      readonly status: "ready";
      readonly view: CounterView;
      readonly error: CounterFailure | null;
      /** Failed changes since the last view; a new count re-mounts the alert so it is re-announced. */
      readonly errorCount: number;
    };

export interface UseCounter {
  readonly state: CounterState;
  readonly increment: () => Promise<void>;
  readonly decrement: () => Promise<void>;
  readonly reset: () => Promise<void>;
  /** Load again after a failed load. */
  readonly retry: () => void;
}

/** A rejection as the screen shows it: a known code, or `"unexpected"` (logged). */
function toCounterFailure(error: unknown, action: string): CounterFailure {
  if (isCounterError(error)) return error;
  void logError(`${action} failed without a counter error code: ${errorType(error)}`);
  return "unexpected";
}

/** The state once `view` arrives: ready with it, unless the view shown is newer. */
function withView(current: CounterState, view: CounterView): CounterState {
  if (current.status === "ready" && current.view.revision > view.revision) return current;
  return { status: "ready", view, error: null, errorCount: 0 };
}

/** The state once an action fails with `failure`. */
function withFailedAction(current: CounterState, failure: CounterFailure): CounterState {
  switch (current.status) {
    case "ready":
      return { ...current, error: failure, errorCount: current.errorCount + 1 };
    case "failed":
      return { status: "failed", error: failure };
    case "loading":
      return current;
  }
}

export function useCounter(): UseCounter {
  const [state, setState] = useState<CounterState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let stop: UnlistenFn | undefined;
    const show = (view: CounterView): void => {
      if (active) setState((current) => withView(current, view));
    };
    const load = (): void => {
      if (!active) return;
      commands.getCounter().then(show, (error: unknown) => {
        if (!active) return;
        const failure = toCounterFailure(error, "get_counter");
        setState((current) =>
          current.status === "ready" ? current : { status: "failed", error: failure },
        );
      });
    };
    onCounterChanged(show).then(
      (unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        load();
      },
      (error: unknown) => {
        void logError(`listening for counter-changed failed: ${errorType(error)}`);
        load();
      },
    );
    return () => {
      active = false;
      stop?.();
    };
  }, [attempt]);

  const change = useCallback(async (name: string, action: () => Promise<CounterView>) => {
    try {
      const view = await action();
      setState((current) => withView(current, view));
    } catch (error: unknown) {
      const failure = toCounterFailure(error, name);
      setState((current) => withFailedAction(current, failure));
    }
  }, []);

  const retry = useCallback(() => {
    setState((current) => (current.status === "failed" ? { status: "loading" } : current));
    setAttempt((count) => count + 1);
  }, []);

  return {
    state,
    increment: useCallback(() => change("increment", commands.increment), [change]),
    decrement: useCallback(() => change("decrement", commands.decrement), [change]),
    reset: useCallback(() => change("reset", commands.reset), [change]),
    retry,
  };
}
