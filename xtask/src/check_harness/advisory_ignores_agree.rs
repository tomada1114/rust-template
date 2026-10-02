//! OSV-Scanner and Dependency Review skip the same GitHub advisories. Both run on every
//! pull request, so a GHSA advisory ignored in one but not the other fails a required
//! check (or passes one unseen) for a reason the other tool already decided.
//!
//! Read:
//! - `osv-scanner.toml` (optional; absent means no ignores): the `id` of every
//!   `[[IgnoredVulns]]` entry that starts with `GHSA-` (Dependency Review knows no RUSTSEC
//!   id);
//! - `.github/workflows/dependency-review.yml` (optional; absent means nothing to
//!   compare): the `allow-ghsas` input, comma- or whitespace-separated, of every step that
//!   uses `actions/dependency-review-action`.
//!
//! Every such step's `allow-ghsas` must hold exactly the OSV GHSA ids, compared
//! case-insensitively.
//!
//! Errors: `ERR_CHECK_ADVISORY_UNREADABLE` (`osv-scanner.toml` or the workflow does not
//! parse), `ERR_CHECK_ADVISORY_DISAGREE` (a step's `allow-ghsas` differs from the OSV GHSA
//! ignores).

use std::collections::BTreeSet;

use super::workflows::{YamlFile, read_yaml};
use super::{Input, finding, first_line, read_file};
use crate::fail::FailureDetails;

const OSV: &str = "osv-scanner.toml";
const WORKFLOW: &str = ".github/workflows/dependency-review.yml";
const ACTION: &str = "actions/dependency-review-action@";

fn unreadable(path: &str, message: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_ADVISORY_UNREADABLE",
        format!("{path} does not parse"),
        format!("{path} to parse, so its advisory exceptions can be read"),
        first_line(message),
        format!("fix {path}"),
    )
}

/// The GHSA ids `osv-scanner.toml` ignores, upper-cased, or the parse error.
fn osv_ghsas(input: &Input<'_>) -> Result<BTreeSet<String>, String> {
    let Some(text) = read_file(input.root, OSV) else {
        return Ok(BTreeSet::new());
    };
    let parsed = text
        .parse::<toml::Table>()
        .map_err(|error| error.to_string())?;
    let Some(toml::Value::Array(entries)) = parsed.get("IgnoredVulns") else {
        return Ok(BTreeSet::new());
    };
    Ok(entries
        .iter()
        .filter_map(|entry| entry.get("id").and_then(toml::Value::as_str))
        .filter(|id| {
            id.get(..5)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("ghsa-"))
        })
        .map(str::to_uppercase)
        .collect())
}

/// The `allow-ghsas` of each dependency-review-action step, by step label.
fn review_steps(workflow: &YamlFile) -> Vec<(String, BTreeSet<String>)> {
    let Some(jobs) = workflow.root.get("jobs").filter(|jobs| jobs.is_map()) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (job_id, job) in jobs.pairs() {
        for (index, step) in job
            .get("steps")
            .map(super::yaml::Node::items)
            .unwrap_or_default()
            .iter()
            .enumerate()
        {
            if !step
                .get("uses")
                .and_then(|uses| uses.as_str())
                .is_some_and(|uses| uses.starts_with(ACTION))
            {
                continue;
            }
            let ids = step
                .get("with")
                .and_then(|inputs| inputs.get("allow-ghsas"))
                .and_then(|raw| raw.as_str())
                .map(|raw| {
                    raw.split(|c: char| c == ',' || c.is_whitespace())
                        .filter(|id| !id.is_empty())
                        .map(str::to_uppercase)
                        .collect()
                })
                .unwrap_or_default();
            found.push((format!("jobs.{job_id}.steps[{index}]"), ids));
        }
    }
    found
}

fn listed<'a>(ids: impl Iterator<Item = &'a String>) -> String {
    let ids: Vec<&str> = ids.map(String::as_str).collect();
    if ids.is_empty() {
        "none".to_owned()
    } else {
        ids.join(", ")
    }
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let expected = match osv_ghsas(input) {
        Ok(expected) => expected,
        Err(message) => return vec![unreadable(OSV, &message)],
    };
    let workflow = match read_yaml(input.root, WORKFLOW) {
        None => return Vec::new(),
        Some(Err(message)) => return vec![unreadable(WORKFLOW, &message)],
        Some(Ok(workflow)) => workflow,
    };
    review_steps(&workflow)
        .into_iter()
        .filter(|(_, actual)| *actual != expected)
        .map(|(label, actual)| {
            finding(
                "ERR_CHECK_ADVISORY_DISAGREE",
                format!("{WORKFLOW} {label} allow-ghsas differs from {OSV}'s GHSA ignores"),
                format!("allow-ghsas to list exactly {OSV}'s GHSA ids: {}", listed(expected.iter())),
                format!(
                    "missing: {}; not ignored by OSV: {}",
                    listed(expected.difference(&actual)),
                    listed(actual.difference(&expected))
                ),
                format!("make {WORKFLOW}'s allow-ghsas and {OSV}'s GHSA [[IgnoredVulns]] list the same ids, each with its reason and expiry (a gate change: the changing-gates skill)"),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{WORKFLOW, run};
    use crate::check_harness::test_support::{codes, run_at};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const OSV: &str = "[[IgnoredVulns]]\nid = \"GHSA-wrw7-89jp-8q8g\"\nignoreUntil = 2026-12-27T00:00:00Z\nreason = \"Linux-only\"\n\n[[IgnoredVulns]]\nid = \"RUSTSEC-2024-0370\"\nignoreUntil = 2026-12-27T00:00:00Z\nreason = \"Linux-only\"\n";

    fn workflow(allow: Option<&str>) -> String {
        let allow = allow
            .map(|ids| format!("          allow-ghsas: {ids}\n"))
            .unwrap_or_default();
        format!(
            "name: Dependency Review\non:\n  pull_request:\njobs:\n  dependency-review:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0\n        with:\n{allow}          allow-licenses: MIT\n"
        )
    }

    fn check(osv: Option<&str>, review: Option<&str>) -> Vec<FailureDetails> {
        let dir = temp_dir();
        if let Some(osv) = osv {
            write(dir.path(), "osv-scanner.toml", osv);
        }
        if let Some(review) = review {
            write(dir.path(), WORKFLOW, review);
        }
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_when_allow_ghsas_lists_exactly_the_osv_ghsa_ignores() {
        assert_eq!(
            check(Some(OSV), Some(&workflow(Some("GHSA-wrw7-89jp-8q8g")))),
            []
        );
        let osv = format!("{OSV}\n[[IgnoredVulns]]\nid = \"GHSA-aaaa-bbbb-cccc\"\n");
        let review = workflow(Some("ghsa-aaaa-bbbb-cccc, GHSA-wrw7-89jp-8q8g"));
        assert_eq!(check(Some(&osv), Some(&review)), []);
    }

    #[test]
    fn fails_when_the_lists_disagree() {
        let found = check(Some(OSV), Some(&workflow(None)));
        assert_eq!(codes(&found), ["ERR_CHECK_ADVISORY_DISAGREE"]);
        assert_eq!(
            found[0].actual,
            "missing: GHSA-WRW7-89JP-8Q8G; not ignored by OSV: none"
        );
        assert!(found[0].summary.contains("jobs.dependency-review.steps[1]"));
        let found = check(
            Some(OSV),
            Some(&workflow(Some("GHSA-wrw7-89jp-8q8g GHSA-xxxx-yyyy-zzzz"))),
        );
        assert_eq!(
            found[0].actual,
            "missing: none; not ignored by OSV: GHSA-XXXX-YYYY-ZZZZ"
        );
        let found = check(Some(""), Some(&workflow(Some("GHSA-wrw7-89jp-8q8g"))));
        assert_eq!(codes(&found), ["ERR_CHECK_ADVISORY_DISAGREE"]);
    }

    #[test]
    fn treats_an_absent_osv_file_as_no_ignores() {
        let found = check(None, Some(&workflow(Some("GHSA-wrw7-89jp-8q8g"))));
        assert_eq!(codes(&found), ["ERR_CHECK_ADVISORY_DISAGREE"]);
        assert_eq!(check(None, Some(&workflow(None))), []);
    }

    #[test]
    fn ignores_malformed_ignored_vulns() {
        assert_eq!(
            check(Some("IgnoredVulns = \"none\"\n"), Some(&workflow(None))),
            []
        );
        let odd = "IgnoredVulns = [1, { id = 2 }, { id = \"GHSA-wrw7-89jp-8q8g\" }]\n";
        assert_eq!(
            check(Some(odd), Some(&workflow(Some("GHSA-wrw7-89jp-8q8g")))),
            []
        );
    }

    #[test]
    fn passes_without_the_workflow_or_a_review_step() {
        assert_eq!(check(Some(OSV), None), []);
        let other = "jobs:\n  a:\n    steps:\n      - run: echo\n      - uses: actions/checkout@v1\n  b: 1\n";
        assert_eq!(check(Some(OSV), Some(other)), []);
        assert_eq!(check(Some(OSV), Some("name: x\n")), []);
    }

    #[test]
    fn fails_when_a_file_does_not_parse() {
        let review = workflow(Some("GHSA-wrw7-89jp-8q8g"));
        assert_eq!(
            codes(&check(Some("[[IgnoredVulns\n"), Some(&review))),
            ["ERR_CHECK_ADVISORY_UNREADABLE"]
        );
        assert_eq!(
            codes(&check(Some(OSV), Some("jobs: [\n"))),
            ["ERR_CHECK_ADVISORY_UNREADABLE"]
        );
    }
}
