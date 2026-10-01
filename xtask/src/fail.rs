//! The failure contract every task follows: the first stderr line is
//! `ERR_<STAGE>_<WHAT>: <summary>`, then `Expected:`, `Actual:`, and `Next:`, and the
//! process exits 1 (or the exit code the error names, such as a Claude Code hook's 2). A
//! message never contains a secret.

use std::fmt;

/// The four lines a failure explains itself with, plus its code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FailureDetails {
    pub(crate) code: String,
    pub(crate) summary: String,
    pub(crate) expected: String,
    pub(crate) actual: String,
    pub(crate) next: String,
}

/// A failure that already knows how to explain itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScriptError {
    /// Boxed: a task's `Result` stays a pointer wide on its success path.
    pub(crate) details: Box<FailureDetails>,
    /// The process exit code: 1 unless the caller needs another (a Claude Code hook
    /// uses 2).
    pub(crate) exit_code: u8,
}

impl ScriptError {
    /// A failure that exits 1.
    pub(crate) fn new(
        code: &str,
        summary: impl Into<String>,
        expected: impl Into<String>,
        actual: impl Into<String>,
        next: impl Into<String>,
    ) -> Self {
        Self {
            details: Box::new(FailureDetails {
                code: code.to_owned(),
                summary: summary.into(),
                expected: expected.into(),
                actual: actual.into(),
                next: next.into(),
            }),
            exit_code: 1,
        }
    }

    /// The same failure with another exit code.
    pub(crate) fn with_exit_code(mut self, exit_code: u8) -> Self {
        self.exit_code = exit_code;
        self
    }

    /// A failure no task names a code for: an I/O error it did not expect, say. It is
    /// reported as `ERR_INTERNAL_UNEXPECTED`, exit 1.
    pub(crate) fn unexpected(what: &str, error: &dyn fmt::Display) -> Self {
        Self::new(
            "ERR_INTERNAL_UNEXPECTED",
            format!("{what}: {error}"),
            "the task to finish or fail with a named ERR_ code",
            "an unexpected error",
            "report this as a bug in the task, with the command you ran",
        )
    }

    /// The code, as the first word of the first line.
    #[cfg(test)]
    pub(crate) fn code(&self) -> &str {
        &self.details.code
    }
}

impl fmt::Display for ScriptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let details = &self.details;
        write!(
            f,
            "{}: {}\nExpected: {}\nActual: {}\nNext: {}",
            details.code, details.summary, details.expected, details.actual, details.next
        )
    }
}

/// What a task returns.
pub(crate) type TaskResult = Result<(), ScriptError>;

#[cfg(test)]
mod tests {
    use super::ScriptError;

    #[test]
    fn prints_the_four_line_report() {
        let error = ScriptError::new("ERR_X_Y", "it broke", "it works", "it broke", "fix it");
        assert_eq!(
            error.to_string(),
            "ERR_X_Y: it broke\nExpected: it works\nActual: it broke\nNext: fix it"
        );
        assert_eq!(error.exit_code, 1);
        assert_eq!(error.clone().with_exit_code(2).exit_code, 2);
        assert_eq!(error.code(), "ERR_X_Y");
    }

    #[test]
    fn reports_an_unexpected_error_under_its_own_code() {
        let error = ScriptError::unexpected("reading x", &"denied");
        assert_eq!(error.code(), "ERR_INTERNAL_UNEXPECTED");
        assert_eq!(error.details.summary, "reading x: denied");
    }
}
