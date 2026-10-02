//! The two bots' supply-chain cooldowns wait the same number of days: Dependabot's
//! `cooldown` and Renovate's `minimumReleaseAge`. One that waits more than the other holds
//! back a release the other bot already pulled, so the policy is no longer one number.
//!
//! Files, each optional (an absent one is not compared):
//! - `.github/dependabot.yml|.yaml`: every `updates[]` entry's `cooldown.default-days`, a
//!   whole number of days, and each `semver-major-days`, `semver-minor-days`, and
//!   `semver-patch-days` it sets (a whole number, 0 included, so `semver-patch-days: 0`
//!   disagrees with a 7-day policy instead of passing unseen).
//! - the Renovate config ([`read_renovate`]: the first Renovate file present): the
//!   top-level `minimumReleaseAge` (required) and any in `packageRules`, each a duration
//!   read by [`to_days`] (`7 days`, `1 week`, `168 hours`, `10080 minutes`). A JSON5
//!   config is unreadable here, never skipped.
//!
//! Every stated value must be a whole number of days, and all of them the same number.
//!
//! Errors: `ERR_CHECK_BOTS_UNREADABLE` (a config does not parse, or the Renovate config is
//! JSON5), `ERR_CHECK_BOTS_COOLDOWN_MISSING` (a present config states no cooldown, or one
//! that is not whole days), `ERR_CHECK_BOTS_COOLDOWN_DISAGREE` (the stated cooldowns are
//! not all the same number of days).

use std::cmp::Ordering;

use super::workflows::{DEPENDABOT_FILES, Renovate, read_renovate, read_yaml};
use super::yaml::{Key, Node, number_text};
use super::{Input, finding, read_file};
use crate::fail::FailureDetails;

const SEMVER_DAYS: [&str; 3] = [
    "semver-major-days",
    "semver-minor-days",
    "semver-patch-days",
];
const MINUTES_PER_DAY: f64 = 24.0 * 60.0;

fn unit_minutes(unit: &str) -> Option<f64> {
    match unit.to_ascii_lowercase().as_str() {
        "m" | "min" | "mins" | "minute" | "minutes" => Some(1.0),
        "h" | "hour" | "hours" => Some(60.0),
        "d" | "day" | "days" => Some(MINUTES_PER_DAY),
        "w" | "week" | "weeks" => Some(7.0 * MINUTES_PER_DAY),
        _ => None,
    }
}

/// A Renovate duration (`7 days`, `1 week`, `168 hours`) as whole days, else `None`.
fn to_days(value: &str) -> Option<f64> {
    let value = value.trim();
    let digits = value.find(|c: char| !c.is_ascii_digit())?;
    let (count, unit) = value.split_at(digits);
    let unit = unit.trim_start();
    if count.is_empty() || unit.is_empty() || !unit.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    whole_days(count.parse::<f64>().ok()? * unit_minutes(unit)?)
}

fn whole_days(minutes: f64) -> Option<f64> {
    (minutes.fract() == 0.0 && minutes > 0.0 && (minutes % MINUTES_PER_DAY) == 0.0)
        .then_some(minutes / MINUTES_PER_DAY)
}

struct Cooldown {
    /// `path:line` or `path`.
    place: String,
    setting: String,
    /// The value as JSON, or `None` when absent.
    value: Option<String>,
    /// The value in whole days, or `None` when it is absent or not whole days.
    days: Option<f64>,
}

#[derive(Default)]
struct Reading {
    cooldowns: Vec<Cooldown>,
    unreadable: Vec<String>,
}

fn unreadable(problem: String) -> Reading {
    Reading {
        cooldowns: Vec::new(),
        unreadable: vec![problem],
    }
}

fn dependabot(input: &Input<'_>) -> Reading {
    let Some(path) = DEPENDABOT_FILES
        .into_iter()
        .find(|path| read_file(input.root, path).is_some())
    else {
        return Reading::default();
    };
    let file = match read_yaml(input.root, path) {
        None => return Reading::default(),
        Some(Err(problem)) => return unreadable(problem),
        Some(Ok(file)) => file,
    };
    let mut cooldowns = Vec::new();
    let updates = file
        .root
        .get("updates")
        .map(Node::items)
        .unwrap_or_default();
    for (index, entry) in updates.iter().enumerate() {
        if !entry.is_map() {
            continue;
        }
        let ecosystem = entry
            .get("package-ecosystem")
            .and_then(Node::as_str)
            .map_or_else(|| format!("updates[{index}]"), str::to_owned);
        let who = format!("Dependabot `{ecosystem}`");
        let cooldown = entry.get("cooldown").filter(|cooldown| cooldown.is_map());
        let at = |key: &str| {
            file.at(&[
                Key::Name("updates"),
                Key::Index(index),
                Key::Name("cooldown"),
                Key::Name(key),
            ])
        };
        let value = cooldown.and_then(|cooldown| cooldown.get("default-days"));
        cooldowns.push(Cooldown {
            place: at("default-days"),
            setting: format!("{who} cooldown.default-days"),
            value: value.map(Node::to_json),
            days: value
                .and_then(Node::as_number)
                .and_then(|days| whole_days(days * MINUTES_PER_DAY)),
        });
        for key in SEMVER_DAYS {
            let Some(days) = cooldown.and_then(|cooldown| cooldown.get(key)) else {
                continue;
            };
            cooldowns.push(Cooldown {
                place: at(key),
                setting: format!("{who} cooldown.{key}"),
                value: Some(days.to_json()),
                days: days
                    .as_number()
                    .filter(|days| days.fract() == 0.0 && *days >= 0.0),
            });
        }
    }
    Reading {
        cooldowns,
        unreadable: Vec::new(),
    }
}

fn renovate(input: &Input<'_>) -> Reading {
    let (path, config) = match read_renovate(input.root) {
        None => return Reading::default(),
        Some(Renovate::Problem { problem, .. }) => return unreadable(problem),
        Some(Renovate::Config { path, config, .. }) => (path, config),
    };
    let mut entries = vec![(
        "minimumReleaseAge".to_owned(),
        config.get("minimumReleaseAge"),
    )];
    if let Some(serde_json::Value::Array(rules)) = config.get("packageRules") {
        for (index, rule) in rules.iter().enumerate() {
            if let Some(age) = rule.get("minimumReleaseAge") {
                entries.push((
                    format!("packageRules[{index}].minimumReleaseAge"),
                    Some(age),
                ));
            }
        }
    }
    Reading {
        cooldowns: entries
            .into_iter()
            .map(|(setting, value)| Cooldown {
                place: path.clone(),
                setting: format!("Renovate {setting}"),
                value: value.map(serde_json::Value::to_string),
                days: value.and_then(serde_json::Value::as_str).and_then(to_days),
            })
            .collect(),
        unreadable: Vec::new(),
    }
}

const NEXT: &str = "set every value named above to the one cooldown the policy states (7 days: `default-days: 7`, `\"minimumReleaseAge\": \"7 days\"`), all in one change";

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let readings = [dependabot(input), renovate(input)];
    let mut found: Vec<FailureDetails> = readings
        .iter()
        .flat_map(|reading| &reading.unreadable)
        .map(|problem| {
            finding(
                "ERR_CHECK_BOTS_UNREADABLE",
                "a dependency-cooldown config cannot be parsed",
                "dependabot.yml to be YAML, and the Renovate config JSON",
                problem.clone(),
                "fix the file's syntax (a JSON5 Renovate config is not read: rename it to renovate.json)",
            )
        })
        .collect();
    let cooldowns: Vec<&Cooldown> = readings
        .iter()
        .flat_map(|reading| &reading.cooldowns)
        .collect();
    for cooldown in cooldowns.iter().filter(|cooldown| cooldown.days.is_none()) {
        found.push(finding(
            "ERR_CHECK_BOTS_COOLDOWN_MISSING",
            format!(
                "{}: {} is {}",
                cooldown.place,
                cooldown.setting,
                if cooldown.value.is_none() { "not set" } else { "not a whole number of days" }
            ),
            "every Dependabot entry's cooldown.default-days (and any semver-*-days) and Renovate's minimumReleaseAge set to a whole number of days",
            cooldown.value.clone().unwrap_or_else(|| "absent".to_owned()),
            NEXT,
        ));
    }
    let stated: Vec<(&Cooldown, f64)> = cooldowns
        .iter()
        .filter_map(|cooldown| cooldown.days.map(|days| (*cooldown, days)))
        .collect();
    let disagree = stated.first().is_some_and(|(_, first)| {
        stated
            .iter()
            .any(|(_, days)| days.partial_cmp(first) != Some(Ordering::Equal))
    });
    if disagree {
        found.push(finding(
            "ERR_CHECK_BOTS_COOLDOWN_DISAGREE",
            "the supply-chain cooldowns are not the same number of days",
            "Dependabot's cooldown (default-days and every semver-*-days) and Renovate's minimumReleaseAge equal",
            stated
                .iter()
                .map(|(cooldown, days)| {
                    format!("{}: {} = {} day(s)", cooldown.place, cooldown.setting, number_text(*days))
                })
                .collect::<Vec<_>>()
                .join("; "),
            NEXT,
        ));
    }
    found
}

#[cfg(test)]
mod tests {
    use super::{run, to_days};
    use crate::check_harness::test_support::{codes, run_at};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const DEPENDABOT: &str = "version: 2\nupdates:\n  - package-ecosystem: cargo\n    directory: /\n    cooldown:\n      default-days: 7\n  - package-ecosystem: github-actions\n    directory: /\n    cooldown:\n      default-days: 7\n";
    const RENOVATE: &str = r#"{"minimumReleaseAge":"7 days","packageRules":[{"matchManagers":["mise"],"minimumReleaseAge":"1 week"},{"enabled":true}]}"#;

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<FailureDetails> {
        let mut files = vec![
            (".github/dependabot.yml", Some(DEPENDABOT)),
            (".github/renovate.json", Some(RENOVATE)),
        ];
        for (path, content) in overrides {
            files.retain(|(existing, _)| existing != path);
            files.push((path, *content));
        }
        let dir = temp_dir();
        for (path, content) in files {
            if let Some(content) = content {
                write(dir.path(), path, content);
            }
        }
        run_at(dir.path(), run)
    }

    fn with_semver(lines: &str) -> String {
        DEPENDABOT.replacen(
            "default-days: 7\n  - ",
            &format!("default-days: 7\n{lines}  - "),
            1,
        )
    }

    #[test]
    fn passes_when_every_cooldown_is_seven_days_or_absent() {
        assert_eq!(check(&[]), []);
        let none = [
            (".github/dependabot.yml", None),
            (".github/renovate.json", None),
        ];
        assert_eq!(check(&none), []);
        let other_files = [
            (".github/renovate.json", None),
            (
                "renovate.json",
                Some(r#"{"minimumReleaseAge":"168 hours"}"#),
            ),
            (".github/dependabot.yml", None),
            (".github/dependabot.yaml", Some(DEPENDABOT)),
        ];
        assert_eq!(check(&other_files), []);
        let semver = with_semver(
            "      semver-major-days: 7\n      semver-minor-days: 7\n      semver-patch-days: 7\n",
        );
        assert_eq!(check(&[(".github/dependabot.yml", Some(&semver))]), []);
    }

    #[test]
    fn rejects_a_cooldown_that_differs_naming_every_value() {
        let three = DEPENDABOT.replacen("default-days: 7\n  - ", "default-days: 3\n  - ", 1);
        let found = check(&[(".github/dependabot.yml", Some(&three))]);
        assert_eq!(codes(&found), ["ERR_CHECK_BOTS_COOLDOWN_DISAGREE"]);
        assert!(found[0].actual.contains(
            ".github/dependabot.yml:6: Dependabot `cargo` cooldown.default-days = 3 day(s)"
        ));
        assert!(found[0].actual.contains(
            ".github/dependabot.yml:10: Dependabot `github-actions` cooldown.default-days = 7 day(s)"
        ));
        assert!(found[0].actual.contains(
            ".github/renovate.json: Renovate packageRules[0].minimumReleaseAge = 7 day(s)"
        ));
        for (path, content) in [
            (".github/renovate.json", r#"{"minimumReleaseAge":"3 days"}"#),
            (
                ".github/renovate.json",
                r#"{"minimumReleaseAge":"7 days","packageRules":[{"minimumReleaseAge":"14 days"}]}"#,
            ),
        ] {
            assert_eq!(
                codes(&check(&[(path, Some(content))])),
                ["ERR_CHECK_BOTS_COOLDOWN_DISAGREE"],
                "{content}"
            );
        }
        let patch = with_semver("      semver-patch-days: 0\n");
        let found = check(&[(".github/dependabot.yml", Some(&patch))]);
        assert_eq!(codes(&found), ["ERR_CHECK_BOTS_COOLDOWN_DISAGREE"]);
        assert!(found[0].actual.contains(
            ".github/dependabot.yml:7: Dependabot `cargo` cooldown.semver-patch-days = 0 day(s)"
        ));
        let major = with_semver("      semver-major-days: 14\n");
        assert_eq!(
            codes(&check(&[(".github/dependabot.yml", Some(&major))])),
            ["ERR_CHECK_BOTS_COOLDOWN_DISAGREE"]
        );
    }

    #[test]
    fn rejects_a_cooldown_that_is_absent_or_not_whole_days() {
        let without = DEPENDABOT.replacen("    cooldown:\n      default-days: 7\n", "", 1);
        let found = check(&[(".github/dependabot.yml", Some(&without))]);
        assert_eq!(codes(&found), ["ERR_CHECK_BOTS_COOLDOWN_MISSING"]);
        assert_eq!(found[0].actual, "absent");
        assert!(found[0].summary.ends_with("is not set"));
        let words =
            DEPENDABOT.replacen("default-days: 7\n  - ", "default-days: \"a week\"\n  - ", 1);
        let found = check(&[(".github/dependabot.yml", Some(&words))]);
        assert_eq!(codes(&found), ["ERR_CHECK_BOTS_COOLDOWN_MISSING"]);
        assert_eq!(found[0].actual, "\"a week\"");
        let half = with_semver("      semver-minor-days: 1.5\n");
        for (path, content) in [
            (".github/dependabot.yml", half.as_str()),
            (".github/renovate.json", "{}"),
            (
                ".github/renovate.json",
                r#"{"minimumReleaseAge":"5 hours"}"#,
            ),
        ] {
            assert_eq!(
                codes(&check(&[(path, Some(content))])),
                ["ERR_CHECK_BOTS_COOLDOWN_MISSING"],
                "{content}"
            );
        }
    }

    #[test]
    fn reports_each_config_it_cannot_parse() {
        let found = check(&[
            (".github/dependabot.yml", Some("updates: [\n")),
            (".github/renovate.json", Some("{ // json5 }")),
        ]);
        assert_eq!(codes(&found), ["ERR_CHECK_BOTS_UNREADABLE"; 2]);
        for path in [
            "renovate.json5",
            ".github/renovate.json5",
            ".gitlab/renovate.json5",
            ".renovaterc.json5",
        ] {
            let found = check(&[(".github/renovate.json", None), (path, Some("{}\n"))]);
            assert_eq!(codes(&found), ["ERR_CHECK_BOTS_UNREADABLE"]);
            assert!(found[0].actual.contains(path));
        }
        assert_eq!(
            codes(&check(&[("renovate.json5", Some("{}\n"))])),
            ["ERR_CHECK_BOTS_UNREADABLE"]
        );
    }

    #[test]
    fn reads_renovate_durations_as_whole_days() {
        for (text, days) in [
            ("7 days", Some(7.0)),
            ("1 day", Some(1.0)),
            ("2 weeks", Some(14.0)),
            ("1w", Some(7.0)),
            ("48h", Some(2.0)),
            ("10080 minutes", Some(7.0)),
            ("7d", Some(7.0)),
            (" 7 Days ", Some(7.0)),
            ("36 hours", None),
            ("soon", None),
            ("7", None),
            ("7 fortnights", None),
            ("7 days!", None),
        ] {
            assert_eq!(to_days(text), days, "{text}");
        }
    }
}
