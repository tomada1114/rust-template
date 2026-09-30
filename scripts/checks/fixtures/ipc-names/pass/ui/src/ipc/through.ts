// ipc-names fixture: calls reached through a local re-export, and through Tauri's internals.
import { invoke, once } from "./reexports";

declare global {
  interface Window {
    __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
  }
}

export const again = () => invoke<CounterView>("get_counter");
export const raw = () => window.__TAURI_INTERNALS__.invoke("increment");
const COUNTER_CHANGED_ONCE = "counter-changed";

export const onFirstChange = () => once(COUNTER_CHANGED_ONCE, () => {});
