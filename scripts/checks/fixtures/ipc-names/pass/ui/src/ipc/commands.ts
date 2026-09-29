// ipc-names fixture: the passing root's command wrappers.
import { invoke } from "@tauri-apps/api/core";

const LOG_FROM_UI = "log_from_ui";

// invoke("commented_out") is not a call.
export const getCounter = () => invoke<CounterView>("get_counter");
export const increment = () => invoke<Result<CounterView, Map<string, number>>>(`increment`);
export const logFromUi = (entry: UiLogEntry) => invoke<undefined>(LOG_FROM_UI, { entry });
