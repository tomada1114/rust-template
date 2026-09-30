// ipc-names fixture: the passing root's event listeners.
import { listen, once } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const COUNTER_CHANGED = "counter-changed";

export const onCounterChanged = (handler: (view: CounterView) => void) =>
  listen<CounterView>(COUNTER_CHANGED, (event) => {
    handler(event.payload);
  });
export const onSettingsChanged = () => getCurrentWindow().once("settings-changed", () => {});
