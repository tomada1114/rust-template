//! Fakes for every `myapp-core` port, and one contract function per port (design D2).
//!
//! A contract function holds the behaviour every implementation of a port must have.
//! `myapp-core`'s integration tests run it against the fake here; `myapp-platform`'s
//! tests run the same function against the real adapter — so the fake cannot drift
//! from the real thing without a test failing.
//!
//! This crate is a `[dev-dependencies]` entry only; a harness check fails if a normal
//! dependency edge points at it. Its functions are library code, not tests, so they
//! compare `Result`s with `assert_eq!` instead of unwrapping.

mod clock;
mod counter_store;

pub use clock::{FixedClock, clock_contract};
pub use counter_store::{FailingCounterStore, InMemoryCounterStore, counter_store_contract};
