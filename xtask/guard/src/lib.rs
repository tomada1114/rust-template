//! The staged guard's rules, judged by `cargo xtask check-staged` (the pre-commit hook):
//! a staged path refused on its name alone ([`blocked_path_reason`]), and staged content
//! refused on its shape ([`CredentialRules`]).
//!
//! A crate of its own so that `just test-xtask` can hold it to a higher coverage floor
//! (lines 90, functions 100) than the rest of xtask: it is the most security-critical
//! code in the repository. A new rule needs a test case beside it.

mod credentials;
mod paths;

pub use credentials::CredentialRules;
pub use paths::blocked_path_reason;
