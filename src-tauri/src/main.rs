//! The app's entry point. Everything lives in the library (`lib.rs`), so tests and the
//! binary share one composition root.

fn main() {
    myapp_lib::run();
}
