/**
 * One typed `listen` per Rust event (design D4). The event names here must equal the
 * `pub const`s the shell emits (a harness check compares them).
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CounterView } from "./types";

/** Equals `COUNTER_CHANGED` in `src-tauri/src/commands.rs`. */
export const COUNTER_CHANGED = "counter-changed";

export type { UnlistenFn };

/** Call `handler` with the new view whenever any window, or the app, changes the counter. */
export const onCounterChanged = (handler: (view: CounterView) => void): Promise<UnlistenFn> =>
  listen<CounterView>(COUNTER_CHANGED, (event) => {
    handler(event.payload);
  });
