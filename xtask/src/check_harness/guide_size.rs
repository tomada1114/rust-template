//! `AGENTS.md` stays small enough to be read whole. Every session and every sub-agent
//! loads it before it knows its task, so each byte there is spent on every task, and the
//! rules every task needs (sign-off, validation) are only found while the file is short.
//! Text that belongs to one kind of file or one kind of change has a cheaper home that
//! loads on demand: a rule under `.claude/rules/`, or a skill. This check keeps the file
//! from growing back.
//!
//! The size is the file's length in bytes, as `wc -c AGENTS.md` prints it (invalid UTF-8,
//! which the file never holds, counts as its replacement characters).
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` (no AGENTS.md), `ERR_CHECK_GUIDE_SIZE`.

use super::{Input, finding, read_file};
use crate::fail::FailureDetails;

const GUIDE: &str = "AGENTS.md";
/// The cap, in bytes. Raising it is weakening a gate: it needs a human's sign-off.
const MAX_BYTES: usize = 20_000;

pub(crate) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let Some(text) = read_file(input.root, GUIDE) else {
        return vec![finding(
            "ERR_CHECK_INPUT_MISSING",
            format!("{GUIDE} does not exist"),
            format!("{GUIDE} at the root, at most {MAX_BYTES} bytes"),
            "no such file",
            "run the check against the repository root (--root DIR)",
        )];
    };
    let size = text.len();
    if size <= MAX_BYTES {
        return Vec::new();
    }
    vec![finding(
        "ERR_CHECK_GUIDE_SIZE",
        format!("{GUIDE} is over the {MAX_BYTES}-byte cap"),
        format!("at most {MAX_BYTES} bytes, so every session reads the whole guide"),
        format!("{size} bytes, {} over", size - MAX_BYTES),
        format!(
            "move what applies to one kind of file into a rule under .claude/rules/ and what applies to one kind of change into the skill that owns it, leaving a pointer in {GUIDE} (the authoring-skills skill says which); what every task needs stays"
        ),
    )]
}

#[cfg(test)]
mod tests {
    use super::{MAX_BYTES, run};
    use crate::check_harness::test_support::{codes, run_at};
    use crate::test_support::{temp_dir, write};

    fn check(agents: Option<&str>) -> Vec<crate::fail::FailureDetails> {
        let dir = temp_dir();
        if let Some(agents) = agents {
            write(dir.path(), "AGENTS.md", agents);
        }
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_a_guide_at_the_cap_and_below_it() {
        assert_eq!(check(Some("# Project Guide\n")), []);
        assert_eq!(check(Some(&"a".repeat(MAX_BYTES))), []);
    }

    #[test]
    fn fails_one_byte_over_the_cap_and_says_by_how_much() {
        let violations = check(Some(&"a".repeat(MAX_BYTES + 1)));
        assert_eq!(codes(&violations), ["ERR_CHECK_GUIDE_SIZE"]);
        assert_eq!(violations[0].actual, "20001 bytes, 1 over");
        assert!(violations[0].next.contains(".claude/rules/"));
    }

    #[test]
    fn counts_bytes_rather_than_characters() {
        // An em dash is one character and three bytes: 6,667 of them are under the cap as
        // characters and one byte over it as bytes.
        let dashes = "—".repeat(6_667);
        assert_eq!(dashes.chars().count(), 6_667);
        let violations = check(Some(&dashes));
        assert_eq!(codes(&violations), ["ERR_CHECK_GUIDE_SIZE"]);
        assert_eq!(violations[0].actual, "20001 bytes, 1 over");
        assert_eq!(check(Some(&"—".repeat(6_666))), []);
    }

    #[test]
    fn fails_without_the_guide() {
        assert_eq!(codes(&check(None)), ["ERR_CHECK_INPUT_MISSING"]);
    }
}
