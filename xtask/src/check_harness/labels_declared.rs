//! Every label something in the repository applies is declared exactly once in
//! `.github/labels.yml`, and every label `.github/workflows/pr-label.yml` applies has a
//! release-notes category — so `just labels` creates every label the repository expects, never two
//! conflicting ones, and no merged pull request falls out of the release notes.
//!
//! Declared: each item's `name` in `.github/labels.yml` (required); two names differing
//! only in case are a duplicate, as GitHub compares them case-insensitively. Applied, from
//! whichever of these exist (YAML and JSON read with real parsers):
//! - `.github/ISSUE_TEMPLATE/*.yml|*.yaml`: the top-level `labels` (a list, or a
//!   comma-separated string);
//! - `.github/workflows/*.yml|*.yaml`: in each step's (and each job's) `run:`, a literal
//!   `--add-label`/`--label` value (comma lists split; a `$` variable skipped), and a
//!   `with:` input whose name ends in `labels` (`labels`, `ignoreLabels`; a list, or a
//!   string split on commas and newlines);
//! - `.github/dependabot.yml`: each `updates` entry's `labels`, or, for an entry without
//!   the key, Dependabot's default `dependencies` (its ecosystem label Dependabot creates
//!   itself, so it is not required); `labels: []` applies none;
//! - the Renovate config ([`read_renovate`]): every `labels`/`addLabels` string list; a
//!   JSON5 config is unreadable, never skipped;
//! - `.github/release.yml`: the labels its categories and `exclude` name (`*` aside);
//! - `.github/workflows/pr-label.yml`, when the root has one: the labels of the
//!   `TYPE_LABELS` its steps set in their `env`, read by [`read_type_map`] (a JSON object
//!   of `"type": "label"` string pairs, each reported at its key's line; any other shape,
//!   or no step setting it, is unreadable), each of which must also be listed by a release
//!   category.
//!
//! And, when the root has `.github/workflows/pr-label.yml`: every type a PR-title check accepts (the
//! `types` of each workflow step using amannn/action-semantic-pull-request, or the
//! action's defaults) is a key of `TYPE_LABELS`, so no accepted title goes unlabelled and
//! out of the release notes. Matching is exact, case included.
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` (no labels.yml), `ERR_CHECK_INPUT_UNREADABLE` (a file
//! above does not parse, labels.yml is not a list of named items or fails the checks
//! `just labels` makes — [`parse_label_manifest`], which `cargo xtask sync-labels` runs —
//! or pr-label.yml's `TYPE_LABELS` cannot be read), `ERR_CHECK_LABEL_DUPLICATE`,
//! `ERR_CHECK_LABEL_UNDECLARED`, `ERR_CHECK_LABEL_NO_CATEGORY`,
//! `ERR_CHECK_LABEL_TYPE_UNMAPPED`.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use regex::Regex;

use super::workflows::{Renovate, read_renovate, read_workflows, title_checks};
use super::yaml::{self, Keys, Node, Yaml};
use super::{Input, finding, has_extension, list_dir, pattern, read_file};
use crate::fail::FailureDetails;
use crate::sync_labels::parse_label_manifest;

const LABELS: &str = ".github/labels.yml";
const RELEASE: &str = ".github/release.yml";
const DEPENDABOT: &str = ".github/dependabot.yml";
const PR_LABEL: &str = ".github/workflows/pr-label.yml";
const TYPE_MAP: &str = "TYPE_LABELS";

struct Use {
    /// `path:line`, or a path alone.
    place: String,
    label: String,
    verb: &'static str,
    note: &'static str,
}

fn applies(place: String, label: String) -> Use {
    Use {
        place,
        label,
        verb: "applies",
        note: "",
    }
}

fn unreadable(path: &str, actual: impl Into<String>) -> FailureDetails {
    let shape = if path == LABELS {
        " as a YAML list of items that each have a `name`"
    } else {
        ""
    };
    finding(
        "ERR_CHECK_INPUT_UNREADABLE",
        format!("{path} could not be read for its labels"),
        format!("{path} to parse{shape}"),
        actual,
        format!("fix {path}, then rerun the check"),
    )
}

fn parse_yaml(root: &Path, path: &str, problems: &mut Vec<FailureDetails>) -> Option<Node> {
    let text = read_file(root, path)?;
    match yaml::parse(&text, Keys::MayRepeat) {
        Ok(document) => Some(document.root),
        Err(error) => {
            problems.push(unreadable(path, error.message));
            None
        }
    }
}

/// Each item of a string list, or of a string split on `separators`, with its line.
fn items(node: Option<&Node>, separators: &[char]) -> Vec<(String, usize)> {
    let Some(node) = node else {
        return Vec::new();
    };
    match &node.value {
        Yaml::Seq(list) => list
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .map(|label| (label.trim().to_owned(), item.line))
            })
            .collect(),
        Yaml::Str(text) => {
            let first = node.value_start_line();
            text.split('\n')
                .enumerate()
                .flat_map(|(index, line)| {
                    line.split(separators)
                        .map(str::trim)
                        .filter(|label| !label.is_empty())
                        .map(move |label| (label.to_owned(), first + index))
                })
                .collect()
        }
        Yaml::Null | Yaml::Bool(_) | Yaml::Number(_) | Yaml::Map(_) => Vec::new(),
    }
}

/// Literal `--add-label`/`--label` values in a `run:` script.
fn run_labels(node: Option<&Node>, flag: &Regex) -> Vec<(String, usize)> {
    let Some((text, first)) =
        node.and_then(|node| node.as_str().map(|text| (text, node.value_start_line())))
    else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (index, line) in text.split('\n').enumerate() {
        for captures in flag.captures_iter(line) {
            let value = &captures[1];
            let value = value.strip_prefix(['"', '\'']).unwrap_or(value);
            let value = value.strip_suffix(['"', '\'']).unwrap_or(value);
            found.extend(
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|label| !label.is_empty() && !label.starts_with('$'))
                    .map(|label| (label.to_owned(), first + index)),
            );
        }
    }
    found
}

fn yaml_files(root: &Path, dir: &str) -> Vec<String> {
    let mut names: Vec<String> = list_dir(root, dir)
        .into_iter()
        .filter(|(_, kind)| kind.is_file())
        .map(|(name, _)| name)
        .filter(|name| has_extension(name, &["yml", "yaml"]))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| format!("{dir}/{name}"))
        .collect()
}

fn form_uses(root: &Path, problems: &mut Vec<FailureDetails>) -> Vec<Use> {
    let mut uses = Vec::new();
    for path in yaml_files(root, ".github/ISSUE_TEMPLATE") {
        let Some(form) = parse_yaml(root, &path, problems) else {
            continue;
        };
        uses.extend(
            items(form.get("labels"), &[','])
                .into_iter()
                .map(|(label, line)| applies(format!("{path}:{line}"), label)),
        );
    }
    uses
}

fn workflow_uses(root: &Path, problems: &mut Vec<FailureDetails>) -> Vec<Use> {
    let flag = match pattern(r#"--(?:add-)?label(?:\s+|=)("[^"]*"|'[^']*'|[^\s;)|&]+)"#) {
        Ok(flag) => flag,
        Err(invalid) => {
            problems.push(invalid);
            return Vec::new();
        }
    };
    let mut uses = Vec::new();
    for path in yaml_files(root, ".github/workflows") {
        let Some(workflow) = parse_yaml(root, &path, problems) else {
            continue;
        };
        let mut found = Vec::new();
        for (_, job) in workflow
            .get("jobs")
            .map(|jobs| jobs.entries().collect::<Vec<_>>())
            .unwrap_or_default()
        {
            let steps = job.get("steps").map(Node::items).unwrap_or_default();
            for unit in std::iter::once(job).chain(steps) {
                found.extend(run_labels(unit.get("run"), &flag));
                for (key, value) in unit
                    .get("with")
                    .map(|inputs| inputs.pairs().collect::<Vec<_>>())
                    .unwrap_or_default()
                {
                    if key.to_lowercase().ends_with("labels") {
                        found.extend(items(Some(value), &[',', '\n']));
                    }
                }
            }
        }
        found.retain(|(label, _)| !label.contains("${{"));
        found.sort_by_key(|(_, line)| *line);
        uses.extend(
            found
                .into_iter()
                .map(|(label, line)| applies(format!("{path}:{line}"), label)),
        );
    }
    uses
}

fn dependabot_uses(root: &Path, problems: &mut Vec<FailureDetails>) -> Vec<Use> {
    let Some(config) = parse_yaml(root, DEPENDABOT, problems) else {
        return Vec::new();
    };
    let mut uses = Vec::new();
    for entry in config.get("updates").map(Node::items).unwrap_or_default() {
        if !entry.is_map() {
            continue;
        }
        match entry.get("labels") {
            None => uses.push(Use {
                place: format!("{DEPENDABOT}:{}", entry.line),
                label: "dependencies".to_owned(),
                verb: "applies",
                note: " (Dependabot's default for an entry with no labels key)",
            }),
            Some(labels) => uses.extend(
                items(Some(labels), &[','])
                    .into_iter()
                    .map(|(label, line)| applies(format!("{DEPENDABOT}:{line}"), label)),
            ),
        }
    }
    uses
}

fn renovate_labels(value: &serde_json::Value, labels: &mut Vec<String>) {
    match value {
        serde_json::Value::Array(list) => {
            for item in list {
                renovate_labels(item, labels);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, inner) in map {
                match inner {
                    serde_json::Value::Array(list) if key == "labels" || key == "addLabels" => {
                        labels.extend(
                            list.iter()
                                .filter_map(serde_json::Value::as_str)
                                .map(str::to_owned),
                        );
                    }
                    _ => renovate_labels(inner, labels),
                }
            }
        }
        serde_json::Value::Null
        | serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => {}
    }
}

fn renovate_uses(root: &Path, problems: &mut Vec<FailureDetails>) -> Vec<Use> {
    let (path, text, config) = match read_renovate(root) {
        None => return Vec::new(),
        Some(Renovate::Problem { path, problem }) => {
            problems.push(unreadable(&path, problem));
            return Vec::new();
        }
        Some(Renovate::Config { path, text, config }) => (path, text, config),
    };
    let mut labels = Vec::new();
    renovate_labels(&serde_json::Value::Object(config), &mut labels);
    labels
        .into_iter()
        .map(|label| {
            let quoted = yaml::json_string(&label);
            let line = text
                .split('\n')
                .position(|line| line.contains(&quoted))
                .map_or(0, |at| at + 1);
            applies(format!("{path}:{line}"), label)
        })
        .collect()
}

/// One `"type": "label"` pair of pr-label.yml's map, with its line.
#[derive(Debug, PartialEq, Eq)]
struct TypeLabel {
    kind: String,
    label: String,
    line: usize,
}

/// pr-label.yml's `TYPE_LABELS` map, as far as it can be read.
#[derive(Debug, PartialEq, Eq)]
enum TypeMap {
    /// No pr-label.yml: the map rules are skipped.
    Absent,
    /// pr-label.yml is not YAML, which the workflow scan already reports.
    NotYaml,
    /// Why the map cannot be read.
    Unreadable(String),
    /// Every step's pairs, each step's in source order.
    Read(Vec<TypeLabel>),
}

/// The line of `text` (0-based) whose JSON key is `kind`, written as `"kind"` then `:`.
fn key_line(text: &str, kind: &str) -> Option<usize> {
    let quoted = yaml::json_string(kind);
    text.split('\n').position(|line| {
        line.match_indices(&quoted)
            .any(|(at, _)| line[at + quoted.len()..].trim_start().starts_with(':'))
    })
}

/// One step's `TYPE_LABELS` value: a JSON object of string labels, its pairs sorted by the
/// line each key is written on (a key written another way counts as the value's first
/// line), or why it is not that.
fn type_labels(value: &Node) -> Result<Vec<TypeLabel>, String> {
    let start = value.value_start_line();
    let not_object =
        || format!("`{TYPE_MAP}` at line {start} is not a JSON object of string labels");
    let text = value.as_str().ok_or_else(not_object)?;
    let parsed: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| format!("`{TYPE_MAP}` at line {start} is not JSON ({error})"))?;
    let serde_json::Value::Object(map) = parsed else {
        return Err(not_object());
    };
    let mut pairs = Vec::new();
    for (kind, label) in map {
        let serde_json::Value::String(label) = label else {
            return Err(not_object());
        };
        let line = start + key_line(text, &kind).unwrap_or(0);
        pairs.push(TypeLabel { kind, label, line });
    }
    pairs.sort_by_key(|pair| pair.line);
    Ok(pairs)
}

/// The `TYPE_LABELS` of every step of pr-label.yml that sets one in its `env`.
fn read_type_map(root: &Path) -> TypeMap {
    let Some(text) = read_file(root, PR_LABEL) else {
        return TypeMap::Absent;
    };
    let Ok(document) = yaml::parse(&text, Keys::MayRepeat) else {
        return TypeMap::NotYaml;
    };
    let mut pairs = Vec::new();
    let mut found = false;
    for (_, job) in document
        .root
        .get("jobs")
        .map(|jobs| jobs.entries().collect::<Vec<_>>())
        .unwrap_or_default()
    {
        for step in job.get("steps").map(Node::items).unwrap_or_default() {
            let Some(value) = step.get("env").and_then(|env| env.get(TYPE_MAP)) else {
                continue;
            };
            found = true;
            match type_labels(value) {
                Ok(read) => pairs.extend(read),
                Err(problem) => return TypeMap::Unreadable(problem),
            }
        }
    }
    if found {
        TypeMap::Read(pairs)
    } else {
        TypeMap::Unreadable(format!("no step sets `{TYPE_MAP}` in its `env`"))
    }
}

/// The labels release.yml's categories and exclude name, and the categorised ones.
fn release_labels(
    root: &Path,
    problems: &mut Vec<FailureDetails>,
) -> Option<(Vec<Use>, BTreeSet<String>)> {
    let release = parse_yaml(root, RELEASE, problems)?;
    let changelog = release.get("changelog");
    let category_nodes: Vec<Option<&Node>> = changelog
        .and_then(|changelog| changelog.get("categories"))
        .map(Node::items)
        .unwrap_or_default()
        .iter()
        .map(|category| category.get("labels"))
        .collect();
    let categorised = category_nodes
        .iter()
        .flat_map(|node| items(*node, &[',']))
        .map(|(label, _)| label)
        .collect();
    let exclude = changelog
        .and_then(|changelog| changelog.get("exclude"))
        .and_then(|exclude| exclude.get("labels"));
    let mut named: Vec<(String, usize)> = category_nodes
        .into_iter()
        .chain(std::iter::once(exclude))
        .flat_map(|node| items(node, &[',']))
        .filter(|(label, _)| label != "*")
        .collect();
    named.sort_by_key(|(_, line)| *line);
    let uses = named
        .into_iter()
        .map(|(label, line)| Use {
            place: format!("{RELEASE}:{line}"),
            label,
            verb: "names",
            note: "",
        })
        .collect();
    Some((uses, categorised))
}

/// What `just labels` rejects in a labels.yml (the parser `cargo xtask sync-labels`
/// runs), or `None` when it would accept it.
fn manifest_problem(text: &str) -> Option<String> {
    parse_label_manifest(text).err()
}

/// The declared names with their lines, or `None` when labels.yml is unusable.
fn declared(root: &Path, problems: &mut Vec<FailureDetails>) -> Option<Vec<(String, usize)>> {
    let list = parse_yaml(root, LABELS, problems)?;
    let Yaml::Seq(entries) = &list.value else {
        problems.push(unreadable(LABELS, "the top level is not a list"));
        return None;
    };
    let mut names = Vec::new();
    for item in entries {
        let Some(name) = item
            .get("name")
            .filter(|name| name.as_str().is_some_and(|name| !name.is_empty()))
        else {
            problems.push(unreadable(
                LABELS,
                format!("the item at line {} has no name", item.line),
            ));
            return None;
        };
        names.push((name.as_str().unwrap_or_default().to_owned(), name.line));
    }
    Some(names)
}

/// The PR-title types a title check accepts that pr-label.yml's map does not label.
fn unmapped_types(root: &Path, pairs: &[TypeLabel]) -> Vec<FailureDetails> {
    let mut found = Vec::new();
    let mut mapped: Vec<&str> = Vec::new();
    for pair in pairs {
        if !mapped.contains(&pair.kind.as_str()) {
            mapped.push(&pair.kind);
        }
    }
    let shown = if mapped.is_empty() {
        "nothing".to_owned()
    } else {
        mapped.join(", ")
    };
    for title in title_checks(&read_workflows(root).0) {
        for kind in title
            .types
            .iter()
            .filter(|kind| !mapped.contains(&kind.as_str()))
        {
            found.push(finding(
                "ERR_CHECK_LABEL_TYPE_UNMAPPED",
                format!("{} accepts the PR-title type `{kind}`, which {PR_LABEL}'s {TYPE_MAP} does not map to a label", title.place),
                format!("every type a PR-title check accepts to be a key of {PR_LABEL}'s {TYPE_MAP}, so its pull requests are labelled and reach the release notes"),
                format!("{TYPE_MAP} maps: {shown}"),
                format!("add `\"{kind}\": \"<label>\"` to {TYPE_MAP} in {PR_LABEL} (a label {RELEASE} categorises), or drop `{kind}` from the title check's `types`"),
            ));
        }
    }
    found
}

/// A label declared twice, compared case-insensitively as GitHub does.
fn duplicates<'a>(names: impl Iterator<Item = &'a (String, usize)>) -> Vec<FailureDetails> {
    let mut violations = Vec::new();
    let mut first: HashMap<String, usize> = HashMap::new();
    for (name, line) in names {
        if let Some(earlier) = first.get(&name.to_lowercase()) {
            violations.push(finding(
                "ERR_CHECK_LABEL_DUPLICATE",
                format!("{LABELS}:{line} declares `{name}` again (first at line {earlier})"),
                format!("each label in exactly one item of {LABELS} (GitHub compares names case-insensitively)"),
                format!("a second item for `{name}`"),
                "merge the two items into one, keeping the color and description you mean",
            ));
        } else {
            first.insert(name.to_lowercase(), *line);
        }
    }
    violations
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let root = input.root;
    let Some(manifest) = read_file(root, LABELS) else {
        return vec![finding(
            "ERR_CHECK_INPUT_MISSING",
            format!("{LABELS} does not exist"),
            format!("the label declarations at {}/{LABELS}", root.display()),
            "no such file",
            "run the check against the repository root (--root DIR)",
        )];
    };
    let mut problems = Vec::new();
    let names = declared(root, &mut problems);
    let mut violations = duplicates(names.iter().flatten());
    // `just labels` parses through parse_label_manifest; a duplicate is already reported above.
    if names.is_some()
        && violations.is_empty()
        && let Some(problem) = manifest_problem(&manifest)
    {
        problems.push(unreadable(LABELS, problem));
    }

    let release = release_labels(root, &mut problems);
    let type_map = read_type_map(root);
    if let TypeMap::Unreadable(problem) = &type_map {
        let mut found = unreadable(PR_LABEL, problem.clone());
        found.expected = format!(
            "a step in {PR_LABEL} whose `env` sets `{TYPE_MAP}` to a JSON object mapping each PR-title type to a label"
        );
        found.next = format!(
            "restore that shape in {PR_LABEL}, or update xtask/src/check_harness/labels_declared.rs's reader in the same change"
        );
        problems.push(found);
    }
    let pairs = match &type_map {
        TypeMap::Read(pairs) => pairs.as_slice(),
        TypeMap::Absent | TypeMap::NotYaml | TypeMap::Unreadable(_) => &[],
    };
    let mut label_pr: Vec<&TypeLabel> = Vec::new();
    for pair in pairs {
        if !label_pr.iter().any(|seen| seen.label == pair.label) {
            label_pr.push(pair);
        }
    }

    let mut uses = form_uses(root, &mut problems);
    uses.extend(workflow_uses(root, &mut problems));
    uses.extend(dependabot_uses(root, &mut problems));
    uses.extend(renovate_uses(root, &mut problems));
    if let Some((release_uses, _)) = &release {
        uses.extend(release_uses.iter().map(|named| Use {
            place: named.place.clone(),
            label: named.label.clone(),
            verb: named.verb,
            note: named.note,
        }));
    }
    uses.extend(
        label_pr
            .iter()
            .map(|pair| applies(format!("{PR_LABEL}:{}", pair.line), pair.label.clone())),
    );
    if let Some(names) = &names {
        let known: BTreeSet<&str> = names.iter().map(|(name, _)| name.as_str()).collect();
        for found in uses
            .iter()
            .filter(|found| !known.contains(found.label.as_str()))
        {
            violations.push(finding(
                "ERR_CHECK_LABEL_UNDECLARED",
                format!("{} {} `{}`{}, which {LABELS} does not declare", found.place, found.verb, found.label, found.note),
                format!("every label an issue form, workflow, dependency bot, release category, or {PR_LABEL}'s {TYPE_MAP} uses to be declared in {LABELS}"),
                format!("no item named `{}` (names match exactly, case included)", found.label),
                format!("declare the label in {LABELS} (name, color, description), or change the file to a declared label; `just labels` then creates it"),
            ));
        }
    }
    // An unreadable release.yml is already reported; only a missing one leaves every label uncategorised.
    let release_unreadable = release.is_none() && read_file(root, RELEASE).is_some();
    if !release_unreadable {
        for pair in &label_pr {
            if release
                .as_ref()
                .is_some_and(|(_, categorised)| categorised.contains(&pair.label))
            {
                continue;
            }
            violations.push(finding(
                "ERR_CHECK_LABEL_NO_CATEGORY",
                format!("{PR_LABEL}:{} applies `{}`, which no {RELEASE} category lists", pair.line, pair.label),
                format!("every label {PR_LABEL}'s {TYPE_MAP} applies to be listed by a category in {RELEASE}, so its pull requests reach the release notes"),
                if release.is_none() { format!("no {RELEASE}") } else { format!("no category's labels include `{}`", pair.label) },
                format!("add `{}` to a category in {RELEASE}, or change the mapping in {PR_LABEL}'s {TYPE_MAP}", pair.label),
            ));
        }
    }
    if matches!(type_map, TypeMap::Read(_)) {
        violations.extend(unmapped_types(root, pairs));
    }
    problems.extend(violations);
    problems
}

#[cfg(test)]
mod tests {
    use super::{TypeLabel, TypeMap, read_type_map, run};
    use crate::check_harness::test_support::{codes, run_at, summaries};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const LABELS: [&str; 7] = [
        "bug",
        "enhancement",
        "documentation",
        "chore",
        "dependencies",
        "ci",
        "priority: P1",
    ];

    fn declare(names: &[&str]) -> String {
        names
            .iter()
            .map(|name| {
                [
                    "- name: \"",
                    name,
                    "\"\n  color: \"ededed\"\n  description: \"x\"\n",
                ]
                .concat()
            })
            .collect()
    }

    fn all_labels(extra: &[&str]) -> String {
        let mut names = LABELS.to_vec();
        names.push("ignore-for-release");
        names.extend(extra);
        declare(&names)
    }

    const WORKFLOW: &str = "name: Label\non: pull_request\njobs:\n  label:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: example/semantic@0000000000000000000000000000000000000000 # v1.0.0\n        with:\n          ignoreLabels: |\n            dependencies\n      - run: |\n          gh pr edit 1 --add-label ci --label=bug\n          gh pr edit 1 --add-label \"$LABEL\"\n          gh pr edit 1 --remove-label stale\n";
    const DEPENDABOT: &str = "version: 2\nupdates:\n  - package-ecosystem: \"cargo\"\n    directory: \"/\"\n    labels:\n      - \"dependencies\"\n  - package-ecosystem: \"npm\"\n    directory: \"/\"\n  - package-ecosystem: \"github-actions\"\n    directory: \"/\"\n    labels: []\n";
    const RENOVATE: &str = "{\n  \"labels\": [\"dependencies\"],\n  \"packageRules\": [{ \"matchManagers\": [\"mise\"], \"addLabels\": [\"chore\"] }]\n}\n";
    const RELEASE: &str = "changelog:\n  exclude:\n    labels: [\"ignore-for-release\"]\n  categories:\n    - title: Features\n      labels: [enhancement]\n    - title: Fixes\n      labels: [bug]\n    - title: Docs\n      labels: [documentation]\n    - title: Maintenance\n      labels: [chore]\n    - title: Dependencies\n      labels: [dependencies]\n    - title: CI\n      labels: [ci]\n    - title: Other\n      labels: [\"*\"]\n";
    const TYPE_PAIRS: [(&str, &str); 6] = [
        ("feat", "enhancement"),
        ("fix", "bug"),
        ("docs", "documentation"),
        ("chore", "chore"),
        ("ci", "ci"),
        ("deps", "dependencies"),
    ];

    const PR_LABEL: &str = ".github/workflows/pr-label.yml";

    /// pr-label.yml with `pairs` as its step's `TYPE_LABELS`; the first pair is on line 10.
    fn pr_label(pairs: &[(&str, &str)]) -> String {
        let entries: Vec<String> = pairs
            .iter()
            .map(|(kind, label)| format!("              \"{kind}\": \"{label}\""))
            .collect();
        pr_label_with(&format!(
            "|\n            {{\n{}\n            }}",
            entries.join(",\n")
        ))
    }

    /// pr-label.yml whose step sets `TYPE_LABELS: <value>` (line 8).
    fn pr_label_with(value: &str) -> String {
        format!(
            "name: Label PR\non: pull_request\njobs:\n  label:\n    runs-on: ubuntu-24.04\n    steps:\n      - env:\n          TYPE_LABELS: {value}\n        run: |\n          gh pr edit \"$PR_NUMBER\" --add-label \"$add\"\n"
        )
    }

    fn title_workflow(types: &str) -> String {
        format!(
            "name: Check PR title\non: pull_request\njobs:\n  main:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: amannn/action-semantic-pull-request@0000000000000000000000000000000000000000 # v6.1.1\n{types}"
        )
    }

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<FailureDetails> {
        let labels = all_labels(&[]);
        let pr = pr_label(&TYPE_PAIRS);
        let mut files: Vec<(&str, Option<&str>)> = vec![
            (".github/labels.yml", Some(&labels)),
            (
                ".github/ISSUE_TEMPLATE/bug.yml",
                Some("name: Bug\nlabels: [\"bug\"]\nbody: []\n"),
            ),
            (
                ".github/ISSUE_TEMPLATE/task.yml",
                Some("name: Task\nlabels:\n  - chore\nbody: []\n"),
            ),
            (
                ".github/ISSUE_TEMPLATE/feature.yaml",
                Some("name: Feature\nlabels: enhancement, documentation\n"),
            ),
            (
                ".github/ISSUE_TEMPLATE/config.yml",
                Some("blank_issues_enabled: false\n"),
            ),
            (".github/workflows/label.yml", Some(WORKFLOW)),
            (".github/dependabot.yml", Some(DEPENDABOT)),
            (".github/renovate.json", Some(RENOVATE)),
            (".github/release.yml", Some(RELEASE)),
            (PR_LABEL, Some(&pr)),
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

    fn undeclared(place: &str, label: &str) -> String {
        format!("{place} applies `{label}`, which .github/labels.yml does not declare")
    }

    #[test]
    fn passes_when_every_applied_label_is_declared_once_and_categorised() {
        assert_eq!(check(&[]), []);
        let dir = temp_dir();
        write(dir.path(), ".github/labels.yml", declare(&["bug"]));
        assert_eq!(run_at(dir.path(), run), []);
    }

    #[test]
    fn fails_on_a_duplicate_declaration() {
        let found = check(&[(".github/labels.yml", Some(&all_labels(&["bug"])))]);
        assert_eq!(
            summaries(&found),
            [".github/labels.yml:25 declares `bug` again (first at line 1)"]
        );
        let found = check(&[(".github/labels.yml", Some(&all_labels(&["Priority: p1"])))]);
        assert_eq!(codes(&found), ["ERR_CHECK_LABEL_DUPLICATE"]);
    }

    #[test]
    fn fails_on_a_labels_file_it_cannot_use() {
        for text in [
            "- name: [unclosed\n",
            "bug: {}\n",
            "- color: \"ededed\"\n",
            "- name: bug\n  color: \"EDEDED\"\n  description: \"x\"\n",
            "- name: bug\n  color: \"ededed\"\n",
            "- name: bug\n  color: \"ededed\"\n  name: bug\n  description: x\n",
            "- name: bug\n  description: x\n",
            &format!(
                "- name: bug\n  color: \"ededed\"\n  description: \"{}\"\n",
                "x".repeat(101)
            ),
        ] {
            assert!(
                codes(&check(&[(".github/labels.yml", Some(text))]))
                    .contains(&"ERR_CHECK_INPUT_UNREADABLE".to_owned()),
                "{text}"
            );
        }
        assert_eq!(
            codes(&check(&[(".github/labels.yml", None)])),
            ["ERR_CHECK_INPUT_MISSING"]
        );
    }

    #[test]
    fn validates_the_manifest_as_just_labels_does() {
        use super::manifest_problem;
        assert_eq!(manifest_problem(&declare(&["a", "b"])), None);
        assert_eq!(
            manifest_problem("- 1\n").as_deref(),
            Some("entry 1 is not a mapping")
        );
        assert_eq!(
            manifest_problem("- name: a\n").as_deref(),
            Some("a: color undefined")
        );
        assert_eq!(
            manifest_problem("- name: a\n  color: 123456\n").as_deref(),
            Some("a: color 123456")
        );
        assert_eq!(
            manifest_problem(&format!("{}{}", declare(&["a"]), declare(&["a"]))).as_deref(),
            Some("a is declared twice")
        );
    }

    #[test]
    fn fails_on_an_undeclared_label_in_an_issue_form() {
        for (text, summary) in [
            (
                "name: Bug\nlabels: [bug, \"needs triage\"]\n",
                undeclared(".github/ISSUE_TEMPLATE/bug.yml:2", "needs triage"),
            ),
            (
                "name: Task\nlabels:\n  - chore\n  - question\n",
                undeclared(".github/ISSUE_TEMPLATE/bug.yml:4", "question"),
            ),
            (
                "name: Task\nlabels: chore, wontfix\n",
                undeclared(".github/ISSUE_TEMPLATE/bug.yml:2", "wontfix"),
            ),
        ] {
            assert_eq!(
                summaries(&check(&[(".github/ISSUE_TEMPLATE/bug.yml", Some(text))])),
                [summary]
            );
        }
        let found = check(&[(".github/ISSUE_TEMPLATE/bug.yml", Some("labels: [bug\n"))]);
        assert_eq!(codes(&found), ["ERR_CHECK_INPUT_UNREADABLE"]);
    }

    #[test]
    fn fails_on_an_undeclared_label_a_workflow_applies() {
        let workflow = WORKFLOW.replace(
            "--remove-label stale",
            "--remove-label stale\n          gh issue edit 2 --add-label 'stale,ci' --label=triaged --label $X --label \"${{ inputs.x }}\"",
        );
        assert_eq!(
            summaries(&check(&[(".github/workflows/label.yml", Some(&workflow))])),
            [
                undeclared(".github/workflows/label.yml:15", "stale"),
                undeclared(".github/workflows/label.yml:15", "triaged")
            ]
        );
        let workflow = WORKFLOW.replace(
            "ignoreLabels: |\n            dependencies",
            "labels: triage, bug",
        );
        assert_eq!(
            summaries(&check(&[(".github/workflows/label.yml", Some(&workflow))])),
            [undeclared(".github/workflows/label.yml:9", "triage")]
        );
        let workflow = WORKFLOW.replace(
            "            dependencies",
            "            dependencies\n            renovate",
        );
        assert_eq!(
            summaries(&check(&[(".github/workflows/label.yml", Some(&workflow))])),
            [undeclared(".github/workflows/label.yml:11", "renovate")]
        );
        let workflow = WORKFLOW.replace(
            "ignoreLabels: |\n            dependencies",
            "labels: [bug, flaky]",
        );
        assert_eq!(
            summaries(&check(&[(".github/workflows/label.yml", Some(&workflow))])),
            [undeclared(".github/workflows/label.yml:9", "flaky")]
        );
        let found = check(&[(".github/workflows/broken.yaml", Some("jobs: [\n"))]);
        assert_eq!(codes(&found), ["ERR_CHECK_INPUT_UNREADABLE"]);
    }

    #[test]
    fn fails_on_an_undeclared_label_a_dependency_bot_applies() {
        let dependabot = DEPENDABOT.replace("- \"dependencies\"", "- rust");
        assert_eq!(
            summaries(&check(&[(".github/dependabot.yml", Some(&dependabot))])),
            [undeclared(".github/dependabot.yml:6", "rust")]
        );
        let without: Vec<&str> = LABELS
            .iter()
            .copied()
            .filter(|name| *name != "dependencies")
            .chain(["ignore-for-release"])
            .collect();
        let labels = declare(&without);
        let dependabot = DEPENDABOT.replace("    labels:\n      - \"dependencies\"\n", "");
        let release = RELEASE.replace("labels: [dependencies]", "labels: [chore]");
        let found = check(&[
            (".github/labels.yml", Some(&labels)),
            (".github/dependabot.yml", Some(&dependabot)),
            (".github/renovate.json", None),
            (".github/release.yml", Some(&release)),
            (".github/workflows/label.yml", None),
            (PR_LABEL, None),
        ]);
        let default = "applies `dependencies` (Dependabot's default for an entry with no labels key), which .github/labels.yml does not declare";
        assert_eq!(
            summaries(&found),
            [
                format!(".github/dependabot.yml:3 {default}"),
                format!(".github/dependabot.yml:5 {default}")
            ]
        );
        let found = check(&[("renovate.json5", Some("{ labels: ['tooling'] }\n"))]);
        assert_eq!(codes(&found), ["ERR_CHECK_INPUT_UNREADABLE"]);
        assert!(found[0].summary.contains("renovate.json5"));
        for path in [".github/renovate.json", "renovate.json"] {
            let renovate =
                RENOVATE.replace("\"addLabels\": [\"chore\"]", "\"addLabels\": [\"tooling\"]");
            let overrides = if path == "renovate.json" {
                vec![
                    (".github/renovate.json", None),
                    (path, Some(renovate.as_str())),
                ]
            } else {
                vec![(path, Some(renovate.as_str()))]
            };
            assert_eq!(
                summaries(&check(&overrides)),
                [undeclared(&format!("{path}:3"), "tooling")]
            );
        }
        assert_eq!(
            codes(&check(&[(".github/dependabot.yml", Some("updates: [\n"))])),
            ["ERR_CHECK_INPUT_UNREADABLE"]
        );
        assert_eq!(
            codes(&check(&[(".github/renovate.json", Some("{"))])),
            ["ERR_CHECK_INPUT_UNREADABLE"]
        );
    }

    #[test]
    fn fails_on_a_type_map_label_undeclared_or_uncategorised() {
        let pr = pr_label(&[("fix", "bug"), ("feat", "feature")]);
        let found = check(&[(PR_LABEL, Some(&pr))]);
        assert_eq!(
            summaries(&found),
            [
                undeclared(&format!("{PR_LABEL}:11"), "feature"),
                format!(
                    "{PR_LABEL}:11 applies `feature`, which no .github/release.yml category lists"
                ),
            ]
        );
        assert_eq!(
            codes(&found),
            ["ERR_CHECK_LABEL_UNDECLARED", "ERR_CHECK_LABEL_NO_CATEGORY"]
        );
        let release = RELEASE.replace("labels: [ci]", "labels: [chore]");
        assert_eq!(
            summaries(&check(&[(".github/release.yml", Some(&release))])),
            [format!(
                "{PR_LABEL}:14 applies `ci`, which no .github/release.yml category lists"
            )]
        );
        let found = check(&[(".github/release.yml", None)]);
        assert!(!found.is_empty());
        assert!(
            found
                .iter()
                .all(|found| found.code == "ERR_CHECK_LABEL_NO_CATEGORY"
                    && found.actual == "no .github/release.yml")
        );
        assert_eq!(
            check(&[(PR_LABEL, None), (".github/release.yml", None)]),
            []
        );
    }

    #[test]
    fn fails_when_the_type_map_cannot_be_read() {
        for workflow in [
            "name: Label PR\non: pull_request\n".to_owned(),
            "name: Label PR\non: pull_request\njobs:\n  label:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n".to_owned(),
            pr_label_with("\"{ nope\""),
            pr_label_with("\"[]\""),
            pr_label_with("'{\"fix\": 1}'"),
            pr_label_with("3"),
            pr_label_with("{fix: bug}"),
        ] {
            let found = check(&[(PR_LABEL, Some(&workflow))]);
            assert_eq!(codes(&found), ["ERR_CHECK_INPUT_UNREADABLE"], "{workflow}");
            assert!(found[0].summary.contains(PR_LABEL), "{workflow}");
        }
        let found = check(&[(PR_LABEL, Some("jobs: [\n"))]);
        assert_eq!(codes(&found), ["ERR_CHECK_INPUT_UNREADABLE"]);
    }

    fn read(workflow: &str) -> TypeMap {
        let dir = temp_dir();
        write(dir.path(), PR_LABEL, workflow);
        read_type_map(dir.path())
    }

    fn pair(kind: &str, label: &str, line: usize) -> TypeLabel {
        TypeLabel {
            kind: kind.to_owned(),
            label: label.to_owned(),
            line,
        }
    }

    #[test]
    fn reads_each_pair_of_the_map_at_its_keys_line_in_source_order() {
        assert_eq!(
            read(&pr_label(&[
                ("fix", "bug"),
                ("chore", "chore"),
                ("ci", "ci")
            ])),
            TypeMap::Read(vec![
                pair("fix", "bug", 10),
                pair("chore", "chore", 11),
                pair("ci", "ci", 12)
            ])
        );
        assert_eq!(read(&pr_label_with("'{}'")), TypeMap::Read(Vec::new()));
        let inline = read(&pr_label_with("'{\"fix\": \"bug\", \"\\u0063i\": \"ci\"}'"));
        let TypeMap::Read(mut pairs) = inline else {
            panic!("expected a map, got {inline:?}");
        };
        pairs.sort_by(|a, b| a.kind.cmp(&b.kind));
        assert_eq!(pairs, [pair("ci", "ci", 8), pair("fix", "bug", 8)]);
        let blank_first = pr_label_with("|\n\n            {\"fix\": \"bug\"}");
        assert_eq!(
            read(&blank_first),
            TypeMap::Read(vec![pair("fix", "bug", 10)])
        );
    }

    #[test]
    fn reads_every_step_that_sets_the_map() {
        let workflow = pr_label(&[("fix", "bug")]).replace(
            "    steps:\n",
            "    steps:\n      - run: echo first\n      - env:\n          TYPE_LABELS: '{\"ci\": \"ci\"}'\n",
        );
        assert_eq!(
            read(&workflow),
            TypeMap::Read(vec![pair("ci", "ci", 9), pair("fix", "bug", 13)])
        );
        assert_eq!(read_type_map(temp_dir().path()), TypeMap::Absent);
        assert_eq!(read("jobs: [\n"), TypeMap::NotYaml);
        let TypeMap::Unreadable(problem) = read(&pr_label_with("\"[1]\"")) else {
            panic!("expected an unreadable map");
        };
        assert_eq!(
            problem,
            "`TYPE_LABELS` at line 8 is not a JSON object of string labels"
        );
    }

    #[test]
    fn compares_title_types_with_the_type_map() {
        let types = |extra: &str| {
            title_workflow(&format!(
                "        with:\n          types: |\n            feat\n            fix\n            {extra}\n"
            ))
        };
        assert_eq!(
            check(&[(".github/workflows/title.yml", Some(&types("deps")))]),
            []
        );
        let found = check(&[(".github/workflows/title.yml", Some(&types("security")))]);
        assert_eq!(codes(&found), ["ERR_CHECK_LABEL_TYPE_UNMAPPED"]);
        assert!(
            found[0]
                .summary
                .contains(".github/workflows/title.yml:7 accepts the PR-title type `security`")
        );
        let found = check(&[(".github/workflows/title.yml", Some(&title_workflow("")))]);
        let kinds: Vec<String> = found
            .iter()
            .filter_map(|found| found.summary.split('`').nth(1).map(str::to_owned))
            .collect();
        assert_eq!(
            kinds,
            ["style", "refactor", "perf", "test", "build", "revert"]
        );
        assert_eq!(
            check(&[
                (".github/workflows/title.yml", Some(&title_workflow(""))),
                (PR_LABEL, None)
            ]),
            []
        );
    }

    #[test]
    fn fails_on_a_release_category_naming_an_undeclared_label() {
        let release = RELEASE.replace("labels: [bug]", "labels: [bug, regression]");
        assert_eq!(
            summaries(&check(&[(".github/release.yml", Some(&release))])),
            [".github/release.yml:8 names `regression`, which .github/labels.yml does not declare"]
        );
        assert_eq!(
            codes(&check(&[(".github/release.yml", Some("changelog: [\n"))])),
            ["ERR_CHECK_INPUT_UNREADABLE"]
        );
    }
}
