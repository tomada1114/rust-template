//! `AGENTS.md` stays small enough to be read whole. Every session and every sub-agent
//! loads it before it knows its task, so each byte there is spent on every task, and the
//! rules every task needs (sign-off, validation) are only found while the file is short.
//! Text that belongs to one kind of file or one kind of change has a cheaper home that
//! loads on demand: a rule under `.claude/rules/`, or a skill. This check keeps the file
//! from growing back.
//!
//! The size is the file's length in bytes, as `wc -c AGENTS.md` counts them (invalid
//! UTF-8, which the file never holds, counts as its replacement characters), less the
//! `## Product` section: the line that is exactly `## Product` and every line after it up
//! to the next `## ` heading. That section is the app's own and has no other home, so
//! an app that describes itself at length is not pushed over the cap by it. A guide
//! with no such section is measured whole; saying it is missing is the product-section
//! check's job.
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
            format!(
                "{GUIDE} at the root, at most {MAX_BYTES} bytes outside its `## Product` section"
            ),
            "no such file",
            "run the check against the repository root (--root DIR)",
        )];
    };
    let product = product_bytes(&text);
    let size = text.len() - product;
    if size <= MAX_BYTES {
        return Vec::new();
    }
    vec![finding(
        "ERR_CHECK_GUIDE_SIZE",
        format!("{GUIDE} is over the {MAX_BYTES}-byte cap"),
        format!(
            "at most {MAX_BYTES} bytes outside the `## Product` section, so every session reads the whole guide"
        ),
        format!(
            "{size} bytes, {} over (the `## Product` section's {product} bytes are not counted)",
            size - MAX_BYTES
        ),
        format!(
            "move what applies to one kind of file into a rule under .claude/rules/ and what applies to one kind of change into the skill that owns it, leaving a pointer in {GUIDE} (the authoring-skills skill says which); what every task needs stays"
        ),
    )]
}

/// The bytes of the `## Product` section: its heading line and every line up to the next
/// `## ` heading (or the end), none when there is no such heading.
fn product_bytes(text: &str) -> usize {
    text.split_inclusive('\n')
        .skip_while(|line| line.trim_end_matches(['\n', '\r']) != "## Product")
        .enumerate()
        .take_while(|(index, line)| *index == 0 || !line.starts_with("## "))
        .map(|(_, line)| line.len())
        .sum()
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
        assert_eq!(
            violations[0].actual,
            "20001 bytes, 1 over (the `## Product` section's 0 bytes are not counted)"
        );
        assert!(violations[0].expected.contains("outside the `## Product`"));
        assert!(violations[0].next.contains(".claude/rules/"));
    }

    /// A guide whose Product section holds `product` bytes of body and whose other
    /// sections together hold exactly `rest` bytes.
    fn guide(product: usize, rest: usize) -> String {
        let before = "# Guide\n\n";
        let after = "## Quick Reference\n\n### Not a Product heading\n";
        let filler = "a".repeat(rest - before.len() - after.len());
        format!(
            "{before}## Product\n{}\n{after}{filler}",
            "p".repeat(product)
        )
    }

    #[test]
    fn leaves_the_product_section_out_of_the_count() {
        assert_eq!(check(Some(&guide(50_000, MAX_BYTES))), []);
        let violations = check(Some(&guide(50_000, MAX_BYTES + 1)));
        assert_eq!(codes(&violations), ["ERR_CHECK_GUIDE_SIZE"]);
        assert_eq!(
            violations[0].actual,
            "20001 bytes, 1 over (the `## Product` section's 50012 bytes are not counted)"
        );
    }

    #[test]
    fn counts_a_product_section_that_ends_the_file_and_only_an_exact_heading() {
        let last = format!(
            "{}\n## Product\n{}",
            "a".repeat(MAX_BYTES - 1),
            "p".repeat(9_000)
        );
        assert_eq!(check(Some(&last)), []);
        // `### Product` and `## Product notes` are not the section: both are counted.
        for heading in ["### Product", "## Product notes"] {
            let text = format!("{heading}\n{}", "a".repeat(MAX_BYTES));
            assert_eq!(
                codes(&check(Some(&text))),
                ["ERR_CHECK_GUIDE_SIZE"],
                "{heading}"
            );
        }
    }

    #[test]
    fn counts_bytes_rather_than_characters() {
        // An em dash is one character and three bytes: 6,667 of them are under the cap as
        // characters and one byte over it as bytes.
        let dashes = "—".repeat(6_667);
        assert_eq!(dashes.chars().count(), 6_667);
        let violations = check(Some(&dashes));
        assert_eq!(codes(&violations), ["ERR_CHECK_GUIDE_SIZE"]);
        assert!(violations[0].actual.starts_with("20001 bytes, 1 over"));
        assert_eq!(check(Some(&"—".repeat(6_666))), []);
    }

    #[test]
    fn fails_without_the_guide() {
        assert_eq!(codes(&check(None)), ["ERR_CHECK_INPUT_MISSING"]);
    }
}
