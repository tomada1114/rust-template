/**
 * The IPC types the rest of the UI may use. They are generated from core's Rust types
 * (`just bindings`) into `./generated/`, which only `ui/src/ipc/` imports; everything
 * else imports from here.
 */
export type { CounterError } from "./generated/CounterError";
export type { CounterView } from "./generated/CounterView";
export type { StorageErrorKind } from "./generated/StorageErrorKind";
export type { UiLogEntry } from "./generated/UiLogEntry";
export type { UiLogLevel } from "./generated/UiLogLevel";
export type { UnixMillis } from "./generated/UnixMillis";
