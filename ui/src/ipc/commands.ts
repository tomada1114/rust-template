/**
 * One typed wrapper per Rust command. Besides `events.ts`, this is the only
 * module that imports `@tauri-apps/api`; the command names here must equal the ones in
 * `src-tauri/src/lib.rs`'s `generate_handler!` (a harness check compares them).
 */
import { invoke } from "@tauri-apps/api/core";

import type { CounterView, UiLogEntry } from "./types";

/** The counter as it is now. Rejects with a `CounterError`. */
export const getCounter = (): Promise<CounterView> => invoke<CounterView>("get_counter");
/** Add one. Rejects with a `CounterError` (`atMaximum` at the bound). */
export const increment = (): Promise<CounterView> => invoke<CounterView>("increment");
/** Subtract one. Rejects with a `CounterError` (`atMinimum` at the bound). */
export const decrement = (): Promise<CounterView> => invoke<CounterView>("decrement");
/** Back to the minimum. Rejects with a `CounterError`. */
export const reset = (): Promise<CounterView> => invoke<CounterView>("reset");
/** Write a UI warning or error to the app's log file. */
export const logFromUi = (entry: UiLogEntry): Promise<void> =>
  invoke<undefined>("log_from_ui", { entry });
