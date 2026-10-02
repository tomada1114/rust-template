//! `AGENTS.md`'s `## Product` section matches which repository this is. It is the one
//! part of that file about the app rather than the harness — what it is, for whom, and
//! what it deliberately is not. In the template it is a `TODO:` skeleton; in an app the
//! bootstrap has produced, a surviving marker means an agent has no in-repo answer to "is
//! this in scope?". The bootstrap smoke relies on this check failing, with
//! `ERR_CHECK_PRODUCT_SECTION`, on a freshly bootstrapped app whose section is unfilled.
//!
//! The section is the lines after a line that is exactly `## Product`, up to the next `## `
//! heading. The repository is the template while the justfile's `bundle_id` is still the
//! template's placeholder bundle identifier, and an app once the bootstrap has replaced
//! it. In either, the section exists and names its `Non-goals`; in the template it holds
//! at least one `TODO:` (so filling it in here cannot make the app-side rule vacuous for
//! every app cut later); in an app it holds none. The marker is `TODO:` with its colon, so
//! prose about a to-do list is not mistaken for one.
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` (no AGENTS.md or justfile),
//! `ERR_CHECK_INPUT_UNREADABLE` (the justfile assigns no `bundle_id := "…"`),
//! `ERR_CHECK_PRODUCT_SECTION`.

use super::bundle_identifier::justfile_bundle_id;
use super::{Input, finding, read_file};
use crate::fail::FailureDetails;

const CONF: &str = "justfile";
// Split so the bootstrap's leftover-placeholder scan never finds the literal here: its
// absence from the justfile is what tells this check the bootstrap has run.
const PLACEHOLDER_IDENTIFIER: &str = concat!("com.example.", "my", "app");
const MARKER: &str = "TODO:";
const FILL_IT: &str = "write AGENTS.md's `## Product` section for this app (what it is and for whom, the core interaction, its non-goals, where those decisions are recorded) and delete every `TODO:` (the `starting-an-app` skill walks through it)";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Template,
    App,
}

fn product_violation(summary: String, mode: Mode, actual: String, next: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_PRODUCT_SECTION",
        summary,
        format!(
            "a `## Product` section naming its Non-goals, {}",
            match mode {
                Mode::Template => "left as a `TODO:` skeleton in the template",
                Mode::App => "holding no `TODO:` once the bootstrap has made this an app",
            }
        ),
        actual,
        next,
    )
}

fn identifier(input: &Input<'_>) -> Result<String, FailureDetails> {
    let Some(text) = read_file(input.root, CONF) else {
        return Err(finding(
            "ERR_CHECK_INPUT_MISSING",
            format!("{CONF} does not exist"),
            format!("{CONF}, whose bundle_id tells the template from an app"),
            "no such file",
            "run the check against the repository root (--root DIR)",
        ));
    };
    justfile_bundle_id(&text).ok_or_else(|| {
        finding(
            "ERR_CHECK_INPUT_UNREADABLE",
            format!("{CONF} has no readable bundle_id"),
            format!("{CONF} to assign `bundle_id := \"…\"` (either quote)"),
            "no such line",
            format!("fix {CONF}"),
        )
    })
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let Some(agents) = read_file(input.root, "AGENTS.md") else {
        return vec![finding(
            "ERR_CHECK_INPUT_MISSING",
            "AGENTS.md does not exist",
            "AGENTS.md at the root, with a `## Product` section",
            "no such file",
            "run the check against the repository root (--root DIR)",
        )];
    };
    let id = match identifier(input) {
        Ok(id) => id,
        Err(violation) => return vec![violation],
    };
    let mode = if id == PLACEHOLDER_IDENTIFIER {
        Mode::Template
    } else {
        Mode::App
    };

    let lines: Vec<&str> = agents.split('\n').collect();
    let Some(start) = lines.iter().position(|line| *line == "## Product") else {
        return vec![product_violation(
            "AGENTS.md has no `## Product` section".to_owned(),
            mode,
            "no `## Product` heading (it must be exactly that line)".to_owned(),
            FILL_IT,
        )];
    };
    let section: Vec<(usize, &str)> = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .take_while(|(_, line)| !line.starts_with("## "))
        .map(|(index, line)| (index + 1, *line))
        .collect();

    let mut violations = Vec::new();
    if !section.iter().any(|(_, text)| text.contains("Non-goals")) {
        violations.push(product_violation(
            "AGENTS.md's `## Product` section does not name its Non-goals".to_owned(),
            mode,
            "no `Non-goals` entry in the section".to_owned(),
            FILL_IT,
        ));
    }
    let markers: Vec<&(usize, &str)> = section
        .iter()
        .filter(|(_, text)| text.contains(MARKER))
        .collect();
    match mode {
        Mode::Template if markers.is_empty() => violations.push(product_violation(
            "AGENTS.md's `## Product` section is filled in while the template's placeholders remain".to_owned(),
            mode,
            format!("no `{MARKER}` marker, but {CONF}'s bundle_id is still the template's placeholder"),
            "restore the `TODO:` skeleton in the template: each app fills it in after the bootstrap, and this check then insists it does",
        )),
        Mode::Template => {}
        Mode::App => {
            for (line, text) in markers {
                violations.push(product_violation(
                    format!("AGENTS.md:{line} still holds a `{MARKER}` marker after the bootstrap"),
                    mode,
                    text.trim().to_owned(),
                    FILL_IT,
                ));
            }
        }
    }
    violations
}

#[cfg(test)]
mod tests {
    use super::{PLACEHOLDER_IDENTIFIER, run};
    use crate::check_harness::test_support::{codes, run_at, summaries};
    use crate::test_support::{temp_dir, write};

    const SKELETON: &str = "# Project Guide

## Overview

A template.

## Product

**TODO: in the template this section is a placeholder.**

- **What it is, and who it is for** — TODO: one paragraph.
- **Non-goals** — TODO: what this app deliberately does not do.

## Quick Reference

```bash
just check  # TODO: this marker is outside the section
```
";

    const FILLED_SECTION: &str = "## Product

A menu-bar TODO list app for people who plan their day in the morning; the reasoning is
in docs/TODO.md.

- **Non-goals** — sync, sharing, and reminders.

### Where these decisions are recorded

docs/architecture/.

";

    fn filled() -> String {
        let start = SKELETON.find("## Product").expect("section");
        let end = SKELETON.find("## Quick Reference").expect("next");
        format!("{}{FILLED_SECTION}{}", &SKELETON[..start], &SKELETON[end..])
    }

    fn conf(identifier: &str) -> String {
        format!(
            "set shell := [\"bash\", \"-euo\", \"pipefail\", \"-c\"]\n\nbundle_id := \"{identifier}\"\n"
        )
    }

    fn fixture(agents: Option<&str>, justfile: Option<&str>) -> tempfile::TempDir {
        let dir = temp_dir();
        if let Some(agents) = agents {
            write(dir.path(), "AGENTS.md", agents);
        }
        if let Some(justfile) = justfile {
            write(dir.path(), "justfile", justfile);
        }
        dir
    }

    fn check(agents: Option<&str>, justfile: Option<&str>) -> Vec<crate::fail::FailureDetails> {
        let dir = fixture(agents, justfile);
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_the_skeleton_in_the_template_and_a_filled_section_in_an_app() {
        assert_eq!(
            check(Some(SKELETON), Some(&conf(PLACEHOLDER_IDENTIFIER))),
            []
        );
        assert_eq!(check(Some(&filled()), Some(&conf("com.acme.widget"))), []);
    }

    #[test]
    fn fails_on_each_marker_left_in_an_app_with_its_line() {
        let violations = check(Some(SKELETON), Some(&conf("com.acme.widget")));
        assert_eq!(
            summaries(&violations),
            [9, 11, 12].map(|line| format!(
                "AGENTS.md:{line} still holds a `TODO:` marker after the bootstrap"
            ))
        );
        assert!(
            violations
                .iter()
                .all(|found| found.code == "ERR_CHECK_PRODUCT_SECTION"
                    && found.next.contains("the `starting-an-app` skill"))
        );
    }

    #[test]
    fn fails_on_a_filled_section_while_the_placeholder_remains() {
        let violations = check(Some(&filled()), Some(&conf(PLACEHOLDER_IDENTIFIER)));
        assert_eq!(codes(&violations), ["ERR_CHECK_PRODUCT_SECTION"]);
        assert!(violations[0].actual.contains("no `TODO:` marker"));
    }

    #[test]
    fn fails_without_a_section_or_its_non_goals() {
        for identifier in [PLACEHOLDER_IDENTIFIER, "com.acme.widget"] {
            let agents = filled().replace("## Product\n", "## Purpose\n");
            let violations = check(Some(&agents), Some(&conf(identifier)));
            assert_eq!(codes(&violations), ["ERR_CHECK_PRODUCT_SECTION"]);
            assert!(violations[0].actual.contains("no `## Product` heading"));
        }
        let agents = filled().replace("- **Non-goals** — sync, sharing, and reminders.\n", "");
        let violations = check(Some(&agents), Some(&conf("com.acme.widget")));
        assert_eq!(codes(&violations), ["ERR_CHECK_PRODUCT_SECTION"]);
        assert!(violations[0].actual.contains("Non-goals"));
    }

    #[test]
    fn fails_on_missing_or_unreadable_inputs() {
        assert_eq!(
            codes(&check(None, Some(&conf(PLACEHOLDER_IDENTIFIER)))),
            ["ERR_CHECK_INPUT_MISSING"]
        );
        assert_eq!(
            codes(&check(Some(SKELETON), None)),
            ["ERR_CHECK_INPUT_MISSING"]
        );
        for text in ["log_prefix := \"x\"\n", "bundle_id := com.example.x\n"] {
            assert_eq!(
                codes(&check(Some(SKELETON), Some(text))),
                ["ERR_CHECK_INPUT_UNREADABLE"]
            );
        }
    }
}
