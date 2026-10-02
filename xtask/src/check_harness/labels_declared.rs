//! Every label something in the repository applies is declared exactly once in
//! `.github/labels.yml`, and every label `scripts/label-pr.ts` applies has a release-notes
//! category — so `just labels` creates every label the repository expects, never two
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
//! - `scripts/label-pr.ts`, when the root has one: the labels of its `TYPE_LABELS` map,
//!   read from the root's own copy by [`read_type_labels`] (a `new Map([…])` of
//!   `["type", "label"]` string pairs; any other shape is unreadable), each of which must
//!   also be listed by a release category.
//!
//! And, when the root has `scripts/label-pr.ts`: every type a PR-title check accepts (the
//! `types` of each workflow step using amannn/action-semantic-pull-request, or the
//! action's defaults) is a key of `TYPE_LABELS`, so no accepted title goes unlabelled and
//! out of the release notes. Matching is exact, case included.
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` (no labels.yml), `ERR_CHECK_INPUT_UNREADABLE` (a file
//! above does not parse, labels.yml is not a list of named items or fails the checks
//! `just labels` makes — `scripts/lib/labels.ts`'s `parseLabelManifest` — or label-pr's
//! map is not a literal it can read), `ERR_CHECK_LABEL_DUPLICATE`,
//! `ERR_CHECK_LABEL_UNDECLARED`, `ERR_CHECK_LABEL_NO_CATEGORY`,
//! `ERR_CHECK_LABEL_TYPE_UNMAPPED`.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use regex::Regex;

use super::workflows::{Renovate, read_renovate, read_workflows, title_checks};
use super::yaml::{self, Keys, Node, Yaml};
use super::{Input, finding, first_line, has_extension, list_dir, pattern, read_file};
use crate::fail::FailureDetails;

const LABELS: &str = ".github/labels.yml";
const RELEASE: &str = ".github/release.yml";
const DEPENDABOT: &str = ".github/dependabot.yml";
const LABEL_PR: &str = "scripts/label-pr.ts";
const TYPE_MAP: &str = "TYPE_LABELS";
/// GitHub's limit on a label description, as `parseLabelManifest` enforces it.
const MAX_DESCRIPTION: usize = 100;

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

/// One `["type", "label"]` entry of label-pr's map, with its line.
#[derive(Debug, PartialEq, Eq)]
struct TypeLabel {
    kind: String,
    label: String,
    line: usize,
}

#[derive(Debug, PartialEq, Eq)]
enum Tok {
    Ident(String),
    Str(String),
    Punct(char),
    Other,
}

/// The string literal (or template) opening at `at`: its token, a template with a
/// substitution being `Other`, and the index after its closing quote. `line` counts the
/// newlines inside it.
fn string_literal(chars: &[char], start: usize, line: &mut usize) -> (Tok, usize) {
    let quote = chars[start];
    let mut value = String::new();
    let mut substituted = false;
    let mut at = start + 1;
    while let Some(&inner) = chars.get(at) {
        at += 1;
        if inner == quote {
            break;
        }
        *line += usize::from(inner == '\n');
        if inner == '\\' {
            let escaped = chars.get(at).copied().unwrap_or_default();
            at += 1;
            *line += usize::from(escaped == '\n');
            value.push(match escaped {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                other => other,
            });
        } else {
            substituted |= quote == '`' && inner == '$' && chars.get(at) == Some(&'{');
            value.push(inner);
        }
    }
    let tok = if substituted {
        Tok::Other
    } else {
        Tok::Str(value)
    };
    (tok, at)
}

/// The index after the regular-expression literal opening at `start`, and its flags.
fn regex_literal_end(chars: &[char], start: usize) -> usize {
    let mut class = false;
    let mut at = start + 1;
    while let Some(&inner) = chars.get(at) {
        at += 1;
        match inner {
            '\\' => at += 1,
            '[' => class = true,
            ']' => class = false,
            '/' if !class => break,
            '\n' => break,
            _ => {}
        }
    }
    while chars.get(at).is_some_and(char::is_ascii_alphabetic) {
        at += 1;
    }
    at
}

/// TypeScript source as the tokens the map reader needs: identifiers, string literals
/// (and templates without a substitution), single punctuation, and everything else as
/// `Other`; comments and regular-expression literals are skipped.
fn tokens(text: &str) -> Vec<(Tok, usize)> {
    let chars: Vec<char> = text.chars().collect();
    let mut found: Vec<(Tok, usize)> = Vec::new();
    let mut line = 1;
    let mut at = 0;
    while let Some(&c) = chars.get(at) {
        let start = line;
        let next = chars.get(at + 1).copied();
        if c == '\n' {
            line += 1;
            at += 1;
        } else if c.is_whitespace() {
            at += 1;
        } else if c == '/' && next == Some('/') {
            while chars.get(at).is_some_and(|c| *c != '\n') {
                at += 1;
            }
        } else if c == '/' && next == Some('*') {
            at += 2;
            while at < chars.len() && !(chars[at] == '*' && chars.get(at + 1) == Some(&'/')) {
                line += usize::from(chars[at] == '\n');
                at += 1;
            }
            at += 2;
        } else if matches!(c, '"' | '\'' | '`') {
            let (tok, end) = string_literal(&chars, at, &mut line);
            at = end;
            found.push((tok, start));
        } else if c == '/'
            && !matches!(
                found.last(),
                Some((
                    Tok::Ident(_) | Tok::Str(_) | Tok::Other | Tok::Punct(')' | ']'),
                    _
                ))
            )
        {
            at = regex_literal_end(&chars, at);
            found.push((Tok::Other, start));
        } else if c.is_alphanumeric() || c == '_' || c == '$' {
            let begin = at;
            while chars
                .get(at)
                .is_some_and(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
            {
                at += 1;
            }
            let word: String = chars[begin..at].iter().collect();
            found.push((
                if c.is_ascii_digit() {
                    Tok::Other
                } else {
                    Tok::Ident(word)
                },
                start,
            ));
        } else if c == '=' && matches!(next, Some('=' | '>')) {
            at += 2;
            found.push((Tok::Other, start));
        } else {
            at += 1;
            found.push((Tok::Punct(c), start));
        }
    }
    found
}

/// label-pr's `TYPE_LABELS` as written in `text`: a `new Map([…])` whose entries are
/// `["type", "label"]` string-literal pairs, or why it is not that.
fn read_type_labels(text: &str) -> Result<Vec<TypeLabel>, String> {
    let toks = tokens(text);
    let declaration = toks.windows(2).enumerate().rev().find_map(|(index, pair)| {
        let keyword = matches!(&pair[0].0, Tok::Ident(word) if word == "const" || word == "let" || word == "var");
        (keyword && pair[1].0 == Tok::Ident(TYPE_MAP.to_owned())).then_some(index + 2)
    });
    let no_value = || format!("no `{TYPE_MAP}` declaration with a value");
    let mut at = declaration.ok_or_else(no_value)?;
    let mut depth = 0_usize;
    loop {
        match toks.get(at).map(|(tok, _)| tok) {
            None => return Err(no_value()),
            Some(Tok::Punct('<' | '(' | '[' | '{')) => depth += 1,
            Some(Tok::Punct('>' | ')' | ']' | '}')) => depth = depth.saturating_sub(1),
            Some(Tok::Punct('=')) if depth == 0 => break,
            Some(Tok::Punct(';' | ',')) if depth == 0 => return Err(no_value()),
            Some(_) => {}
        }
        at += 1;
    }
    at += 1;
    let start = toks.get(at).map_or(0, |(_, line)| *line);
    let not_map =
        || format!("`{TYPE_MAP}` at line {start} is not `new Map([…])` over an array literal");
    let tok = |index: usize| toks.get(index).map(|(tok, _)| tok);
    let is = |index: usize, want: &Tok| tok(index) == Some(want);
    if !(matches!(tok(at), Some(Tok::Ident(word)) if word == "new")
        && matches!(tok(at + 1), Some(Tok::Ident(word)) if word == "Map"))
    {
        return Err(not_map());
    }
    at += 2;
    if is(at, &Tok::Punct('<')) {
        let mut depth = 0_usize;
        loop {
            match tok(at) {
                None => return Err(not_map()),
                Some(Tok::Punct('<')) => depth += 1,
                Some(Tok::Punct('>')) => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                Some(_) => {}
            }
            at += 1;
        }
        at += 1;
    }
    if !(is(at, &Tok::Punct('(')) && is(at + 1, &Tok::Punct('['))) {
        return Err(not_map());
    }
    at += 2;
    let mut pairs = Vec::new();
    loop {
        if is(at, &Tok::Punct(']')) {
            break;
        }
        let line = toks.get(at).map_or(0, |(_, line)| *line);
        let not_pair = || {
            format!(
                "the `{TYPE_MAP}` entry at line {line} is not a [\"type\", \"label\"] pair of string literals"
            )
        };
        let (
            Some(Tok::Punct('[')),
            Some(Tok::Str(kind)),
            Some(Tok::Punct(',')),
            Some(Tok::Str(label)),
        ) = (tok(at), tok(at + 1), tok(at + 2), tok(at + 3))
        else {
            return Err(not_pair());
        };
        at += 4;
        if is(at, &Tok::Punct(',')) {
            at += 1;
        }
        if !is(at, &Tok::Punct(']')) {
            return Err(not_pair());
        }
        pairs.push(TypeLabel {
            kind: kind.clone(),
            label: label.clone(),
            line,
        });
        at += 1;
        if is(at, &Tok::Punct(',')) {
            at += 1;
        } else if !is(at, &Tok::Punct(']')) {
            return Err(not_map());
        }
    }
    at += 1;
    if is(at, &Tok::Punct(',')) {
        at += 1;
    }
    if !is(at, &Tok::Punct(')')) {
        return Err(not_map());
    }
    Ok(pairs)
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

/// What `just labels` (`scripts/lib/labels.ts`'s `parseLabelManifest`) rejects in a
/// labels.yml, or `None` when it would accept it.
fn manifest_problem(text: &str) -> Option<String> {
    let document = match yaml::parse(text, Keys::Unique) {
        Ok(document) => document,
        Err(error) => return Some(first_line(&error.message).to_owned()),
    };
    let Yaml::Seq(entries) = &document.root.value else {
        return Some("the top level is not a list".to_owned());
    };
    let mut seen = BTreeSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let place = format!("entry {}", index + 1);
        if !entry.is_map() && !entry.is_seq() {
            return Some(format!("{place} is not a mapping"));
        }
        let Some(name) = entry
            .get("name")
            .and_then(Node::as_str)
            .filter(|name| !name.is_empty())
        else {
            return Some(format!("{place} has no name"));
        };
        let color = entry.get("color");
        let hex = color.and_then(Node::as_str).is_some_and(|color| {
            color.len() == 6
                && color
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        });
        if !hex {
            return Some(format!(
                "{name}: color {}",
                color.map_or_else(|| "undefined".to_owned(), Node::to_json)
            ));
        }
        let description = entry.get("description").and_then(Node::as_str);
        if description.is_none_or(|text| text.encode_utf16().count() > MAX_DESCRIPTION) {
            return Some(format!(
                "{name}: a missing description, or one over {MAX_DESCRIPTION} characters"
            ));
        }
        if !seen.insert(name) {
            return Some(format!("{name} is declared twice"));
        }
    }
    None
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

/// The PR-title types a title check accepts that label-pr's map does not label.
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
                format!("{} accepts the PR-title type `{kind}`, which {LABEL_PR}'s {TYPE_MAP} does not map to a label", title.place),
                format!("every type a PR-title check accepts to be a key of {LABEL_PR}'s {TYPE_MAP}, so its pull requests are labelled and reach the release notes"),
                format!("{TYPE_MAP} maps: {shown}"),
                format!("add `[\"{kind}\", \"<label>\"]` to {TYPE_MAP} in {LABEL_PR} (a label {RELEASE} categorises), or drop `{kind}` from the title check's `types`"),
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
    // `just labels` parses through parseLabelManifest; a duplicate is already reported above.
    if names.is_some()
        && violations.is_empty()
        && let Some(problem) = manifest_problem(&manifest)
    {
        problems.push(unreadable(LABELS, problem));
    }

    let release = release_labels(root, &mut problems);
    let label_pr_text = read_file(root, LABEL_PR);
    let type_labels = label_pr_text
        .as_deref()
        .map_or_else(|| Ok(Vec::new()), read_type_labels);
    if let Err(problem) = &type_labels {
        let mut found = unreadable(LABEL_PR, problem.clone());
        found.expected = format!(
            "{LABEL_PR}'s `{TYPE_MAP}` to be `new Map([[\"type\", \"label\"], …])` of string literals"
        );
        found.next = format!(
            "restore that shape in {LABEL_PR}, or update xtask/src/check_harness/labels_declared.rs's reader in the same change"
        );
        problems.push(found);
    }
    let pairs = type_labels.as_ref().map_or(&[][..], Vec::as_slice);
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
            .map(|pair| applies(format!("{LABEL_PR}:{}", pair.line), pair.label.clone())),
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
                format!("every label an issue form, workflow, dependency bot, release category, or scripts/label-pr.ts uses to be declared in {LABELS}"),
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
                format!("{LABEL_PR} applies `{}`, which no {RELEASE} category lists", pair.label),
                format!("every label scripts/label-pr.ts applies to be listed by a category in {RELEASE}, so its pull requests reach the release notes"),
                if release.is_none() { format!("no {RELEASE}") } else { format!("no category's labels include `{}`", pair.label) },
                format!("add `{}` to a category in {RELEASE}, or change the mapping in scripts/label-pr.ts", pair.label),
            ));
        }
    }
    if label_pr_text.is_some() && type_labels.is_ok() {
        violations.extend(unmapped_types(root, pairs));
    }
    problems.extend(violations);
    problems
}

#[cfg(test)]
mod tests {
    use super::{TypeLabel, read_type_labels, run};
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

    fn label_pr(pairs: &[(&str, &str)]) -> String {
        let entries: String = pairs
            .iter()
            .map(|(kind, label)| ["  [\"", kind, "\", \"", label, "\"],\n"].concat())
            .collect();
        format!(
            "import {{ ScriptError }} from \"./lib/fail.ts\";\n\nconst TYPE_LABELS: ReadonlyMap<string, string> = new Map([\n{entries}]);\n"
        )
    }

    fn title_workflow(types: &str) -> String {
        format!(
            "name: Check PR title\non: pull_request\njobs:\n  main:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: amannn/action-semantic-pull-request@0000000000000000000000000000000000000000 # v6.1.1\n{types}"
        )
    }

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<FailureDetails> {
        let labels = all_labels(&[]);
        let pr = label_pr(&TYPE_PAIRS);
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
            ("scripts/label-pr.ts", Some(&pr)),
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
            ("scripts/label-pr.ts", None),
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
    fn fails_on_a_label_pr_label_undeclared_or_uncategorised() {
        let pr = label_pr(&[("fix", "bug"), ("feat", "feature")]);
        let found = check(&[("scripts/label-pr.ts", Some(&pr))]);
        assert_eq!(
            summaries(&found),
            [
                undeclared("scripts/label-pr.ts:5", "feature"),
                "scripts/label-pr.ts applies `feature`, which no .github/release.yml category lists".to_owned(),
            ]
        );
        assert_eq!(
            codes(&found),
            ["ERR_CHECK_LABEL_UNDECLARED", "ERR_CHECK_LABEL_NO_CATEGORY"]
        );
        let release = RELEASE.replace("labels: [ci]", "labels: [chore]");
        assert_eq!(
            summaries(&check(&[(".github/release.yml", Some(&release))])),
            ["scripts/label-pr.ts applies `ci`, which no .github/release.yml category lists"]
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
            check(&[("scripts/label-pr.ts", None), (".github/release.yml", None)]),
            []
        );
    }

    #[test]
    fn fails_when_label_pr_map_cannot_be_read() {
        for source in [
            "export const OTHER = 1;\n",
            "let TYPE_LABELS;\n",
            "const TYPE_LABELS = build();\n",
            "const TYPE_LABELS = new Map(PAIRS);\n",
            "const TYPE_LABELS = new Map([[\"fix\"]]);\n",
            "const TYPE_LABELS = new Map([[\"fix\", BUG]]);\n",
            "const TYPE_LABELS = new Map([...MORE]);\n",
            "const TYPE_LABELS = new Map([[\"fix\", \"bug\"]], extra);\n",
            "const TYPE_LABELS = new Map([[\"fix\", `${x}`]]);\n",
        ] {
            assert_eq!(
                codes(&check(&[("scripts/label-pr.ts", Some(source))])),
                ["ERR_CHECK_INPUT_UNREADABLE"],
                "{source}"
            );
        }
    }

    #[test]
    fn reads_each_pair_of_the_map_with_its_line() {
        assert_eq!(
            read_type_labels(&label_pr(&[("fix", "bug")])),
            Ok(vec![TypeLabel {
                kind: "fix".to_owned(),
                label: "bug".to_owned(),
                line: 4
            }])
        );
        let source = "// const TYPE_LABELS = 1;\nconst RE = /[\"']/g;\n/* a\n */ const TYPE_LABELS = new Map<string, string>([\n  ['fix', `bug`,],\n],);\nconst x = a / b;\n";
        assert_eq!(
            read_type_labels(source),
            Ok(vec![TypeLabel {
                kind: "fix".to_owned(),
                label: "bug".to_owned(),
                line: 5
            }])
        );
        assert_eq!(
            read_type_labels("const TYPE_LABELS = new Map([]);\n"),
            Ok(Vec::new())
        );
        assert_eq!(
            read_type_labels("const TYPE_LABELS = new Map([[\"a\", \"b\"] [\"c\", \"d\"]]);\n")
                .map_err(|error| error.contains("line 1")),
            Err(true)
        );
        assert!(read_type_labels("const TYPE_LABELS = new Map<string([]);").is_err());
        assert!(read_type_labels("const TYPE_LABELS = new Map(['\\n\\t\\r\\'', \"x\"").is_err());
    }

    #[test]
    fn compares_title_types_with_label_pr_map() {
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
                ("scripts/label-pr.ts", None)
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
