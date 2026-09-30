//! The app's domain logic.
//!
//! Core holds the rules and the state; it never touches the operating system. Time,
//! storage, and anything else outside the process reach it through *ports* — traits
//! declared here and implemented by `myapp-platform` (the real thing) or
//! `myapp-test-support` (fakes). See `docs/architecture.md`.
//!
//! Every type that crosses IPC to the UI lives in this crate and derives `ts_rs::TS`,
//! so `just bindings` can regenerate `ui/src/ipc/generated/` without building Tauri.

// Every `match` on a core enum names each variant, so adding a variant is a compile
// error at every place that must decide what it means (`.claude/rules/testing.md`).
#![deny(clippy::wildcard_enum_match_arm)]

pub mod counter;
pub mod log;
pub mod time;

pub use counter::{
    Counter, CounterError, CounterService, CounterView, StorageError, StorageErrorKind,
    StoredCounter, Tuning, TuningError, store::CounterStore,
};
pub use log::{UiLogEntry, UiLogLevel};
pub use time::{Clock, UnixMillis};
