//! A log line the UI asks the shell to record (`log_from_ui`).

use serde::Deserialize;
use ts_rs::TS;

/// How serious a UI log entry is. The UI forwards only warnings and errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UiLogLevel {
    /// Something unexpected that the UI recovered from.
    Warn,
    /// Something failed.
    Error,
}

/// One entry from the UI's `ipc/log.ts`. The message must carry no user data: it is
/// written to the log file, on one line and cut to a bounded length.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UiLogEntry {
    /// Severity.
    pub level: UiLogLevel,
    /// What happened, in developer terms (never user-facing wording).
    pub message: String,
}

/// Appended to a message [`UiLogEntry::loggable_message`] had to cut.
const TRUNCATED: &str = "…[truncated]";

impl UiLogEntry {
    /// The most characters of an escaped message that reach the log. A UI error is a
    /// sentence in developer terms; anything longer is a runaway string, not detail.
    pub const MAX_MESSAGE_CHARS: usize = 1_000;

    /// The message as one log line can carry it: every control character and Unicode
    /// line or paragraph separator escaped (`\n`, `\u{2028}`, …), so the message cannot
    /// start a line of its own that a reader of the log would take for the app's, and cut
    /// to [`Self::MAX_MESSAGE_CHARS`] characters, never inside an escape, followed by a
    /// marker when it was cut.
    ///
    /// ```
    /// use myapp_core::{UiLogEntry, UiLogLevel};
    ///
    /// let entry = UiLogEntry {
    ///     level: UiLogLevel::Warn,
    ///     message: "failed\nstartup complete".to_owned(),
    /// };
    /// assert_eq!(entry.loggable_message(), "failed\\nstartup complete");
    /// ```
    #[must_use]
    pub fn loggable_message(&self) -> String {
        let mut loggable = String::new();
        let mut chars = 0;
        for character in self.message.chars() {
            let escape = needs_escape(character).then(|| character.escape_default());
            let width = escape.as_ref().map_or(1, ExactSizeIterator::len);
            if chars + width > Self::MAX_MESSAGE_CHARS {
                loggable.push_str(TRUNCATED);
                return loggable;
            }
            chars += width;
            match escape {
                Some(escape) => loggable.extend(escape),
                None => loggable.push(character),
            }
        }
        loggable
    }
}

/// Whether `character` could break or rewrite a log line if written as is.
fn needs_escape(character: char) -> bool {
    character.is_control() || matches!(character, '\u{2028}' | '\u{2029}')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(message: &str) -> UiLogEntry {
        UiLogEntry {
            level: UiLogLevel::Error,
            message: message.to_owned(),
        }
    }

    #[test]
    fn a_plain_message_is_logged_unchanged() {
        assert_eq!(
            entry("get_counter failed: ünïcode ok").loggable_message(),
            "get_counter failed: ünïcode ok"
        );
    }

    #[test]
    fn every_line_breaking_character_is_escaped() {
        for (raw, logged) in [
            ("a\nb", "a\\nb"),
            ("a\rb", "a\\rb"),
            ("a\r\nb", "a\\r\\nb"),
            ("a\tb", "a\\tb"),
            ("a\u{0b}b", "a\\u{b}b"),
            ("a\u{0c}b", "a\\u{c}b"),
            ("a\u{1b}[2Jb", "a\\u{1b}[2Jb"),
            ("a\u{85}b", "a\\u{85}b"),
            ("a\u{2028}b", "a\\u{2028}b"),
            ("a\u{2029}b", "a\\u{2029}b"),
        ] {
            assert_eq!(entry(raw).loggable_message(), logged, "{raw:?}");
        }
    }

    #[test]
    fn a_message_at_the_limit_is_kept_whole() {
        let message = "x".repeat(UiLogEntry::MAX_MESSAGE_CHARS);
        assert_eq!(entry(&message).loggable_message(), message);
    }

    #[test]
    fn a_longer_message_is_cut_at_the_limit_and_marked() {
        let message = "é".repeat(UiLogEntry::MAX_MESSAGE_CHARS + 1);
        let expected = format!("{}…[truncated]", "é".repeat(UiLogEntry::MAX_MESSAGE_CHARS));
        assert_eq!(entry(&message).loggable_message(), expected);
    }

    #[test]
    fn a_cut_never_splits_an_escape() {
        let message = format!("{}\n", "x".repeat(UiLogEntry::MAX_MESSAGE_CHARS - 1));
        let expected = format!(
            "{}…[truncated]",
            "x".repeat(UiLogEntry::MAX_MESSAGE_CHARS - 1)
        );
        assert_eq!(entry(&message).loggable_message(), expected);
    }

    #[test]
    fn escapes_count_toward_the_limit() {
        let message = "\n".repeat(UiLogEntry::MAX_MESSAGE_CHARS);
        let expected = format!(
            "{}…[truncated]",
            "\\n".repeat(UiLogEntry::MAX_MESSAGE_CHARS / 2)
        );
        assert_eq!(entry(&message).loggable_message(), expected);
    }
}
