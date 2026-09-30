// ipc-names fixture: an invoke outside commands.ts is compared too.
import { invoke } from "@tauri-apps/api/core";

export const refresh = () => invoke<CounterView>("get_counter");
