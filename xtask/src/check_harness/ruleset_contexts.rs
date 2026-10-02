//! Every required status check in the main-branch ruleset names a job that reports on
//! every pull request, so renaming a CI job, filtering its workflow, or guarding it with an
//! `if:` cannot leave a required check that never reports and blocks every PR, or one that
//! is skipped and passes without running.
//!
//! Files: `.github/rulesets/main.json` (required) and `.github/workflows/*.yml|*.yaml`.
//! - contexts: every `context` under a `required_status_checks` rule's
//!   `parameters.required_status_checks`. A ruleset with no such rule requires nothing.
//! - jobs: those of workflows whose `on:` names `pull_request` (not `pull_request_target`:
//!   it runs the base branch's workflow, so a renamed job would not report under it
//!   either). A job reports as its `name:`, or its id without one, and a context must equal
//!   one of the names it reports exactly. A `strategy.matrix` written as literal lists is
//!   expanded as GitHub does (the product of its lists, less `exclude`, plus `include`),
//!   and each `${{ … }}` in a name is evaluated for a pull request with one combination's
//!   `matrix.*` values ([`expressions`](super::expressions)). A matrix job whose name has
//!   no expression reports as `<name> (<values>)`, its combination's values joined by
//!   `, `. A job that calls a reusable workflow in this repository
//!   (`uses: ./.github/workflows/<file>.yml`, the documented form, at most ten levels of
//!   workflows deep) reports each called job as `<caller> / <called job>`. A name this
//!   check cannot know from the files — an expression that is not fixed on a pull request,
//!   a computed matrix or one past 256 jobs, a matrix name whose expressions never read
//!   `matrix`, a workflow in another repository — matches nothing (fail closed), and the
//!   failure names it with the edit that would make it known. A job's `name:` that is a
//!   number or a boolean reports as GitHub's workflow parser converts a scalar where it
//!   expects a string (`123`, `true`); a null or fractional one is not known, and none is
//!   ever compared under the job's id.
//! - the gated branches: each `conditions.ref_name.include` entry of the ruleset:
//!   `refs/heads/<branch>` (no pattern; a pattern include fails closed), `~ALL` (every
//!   branch), or `~DEFAULT_BRANCH`. GitHub keeps the default branch as a repository
//!   setting, not in a file, and this check stays offline, so it takes the one branch
//!   ci.yml's `on: push: branches:` names literally (patterns aside). When the root is the
//!   top of a git work tree whose `refs/remotes/origin/HEAD` exists (a developer's clone,
//!   or the Template Bootstrap Smoke job's scratch clone on a push to main; never an
//!   actions/checkout checkout, which has none), that branch must agree with it; with no
//!   single literal branch, origin/HEAD names the default branch itself (one of the
//!   literals, when ci.yml lists several). Not knowing the name fails nothing on its own:
//!   a trigger with no branch filter, or only `branches: ['**']`, fires into every branch.
//!   Only a required job whose trigger filters branches needs it, and then the check fails
//!   rather than guessing `main`.
//! - runs on every pull request: a matching job counts only when its workflow's
//!   `pull_request` trigger has no `paths` or `paths-ignore` filter, its `branches` (when
//!   set) match every gated branch and no `!` pattern there matches one, its
//!   `branches-ignore` (when set) match none of them (under `~ALL`, neither filter but
//!   `branches: ['**']`), and its `types`, when set, include `opened`, `synchronize`, and
//!   `reopened`; its `if:`, when set, is true on every pull request (evaluated as above;
//!   one the evaluator cannot read is unproven, never true); and every job it `needs` runs
//!   on every pull request too. A called job counts only when the calling job and the
//!   called job (with the `needs` inside its workflow) both do.
//!
//! A workflow that does not parse is workflow-hygiene's to report; its jobs match nothing
//! here.
//!
//! Errors: `ERR_CHECK_RULESET_MISSING` (`.github/rulesets/main.json` does not exist),
//! `ERR_CHECK_RULESET_UNREADABLE` (it is not JSON), `ERR_CHECK_RULESET_BRANCH_UNKNOWN` (a
//! ruleset include is not one this check reads, or a required job filters branches and the
//! default branch is not known), `ERR_CHECK_RULESET_BRANCH_MISMATCH` (ci.yml's one literal
//! push branch is not this clone's `origin/HEAD`), `ERR_CHECK_RULESET_CONTEXT` (a required
//! context matches no job in a `pull_request` workflow), `ERR_CHECK_RULESET_CONTEXT_SKIPPED`
//! (a required context matches only jobs that may not run on every pull request).

use std::collections::HashMap;
use std::path::Path;

use regex::Regex;
use serde_json::Value as Json;

use super::expressions::{Event, Literal, Value, condition_on, embedded, evaluate_on};
use super::workflows::{YamlFile, jobs_of, read_workflows, read_yaml, trigger_names};
use super::yaml::{Node, Yaml, number_text};
use super::{Input, finding, read_file};
use crate::context::RunOptions;
use crate::fail::FailureDetails;
use crate::git_env::git_env;

const RULESET: &str = ".github/rulesets/main.json";
/// The workflow whose `on: push: branches:` declares the default branch.
const CI: &str = ".github/workflows/ci.yml";
const DEFAULT_BRANCH: &str = "~DEFAULT_BRANCH";
const HEADS: &str = "refs/heads/";
const ORIGIN: &str = "refs/remotes/origin/";
const EVENT: Event = Event::PullRequest;
const FILTERS: [&str; 2] = ["paths", "paths-ignore"];
/// The activity types a `pull_request` trigger runs on when it names none.
const DEFAULT_TYPES: [&str; 3] = ["opened", "synchronize", "reopened"];
/// GitHub's limit on the jobs one matrix generates.
const MATRIX_LIMIT: usize = 256;
/// How many combinations this check expands before `exclude`, to bound its own work.
const EXPANSION_LIMIT: usize = MATRIX_LIMIT * MATRIX_LIMIT;
/// GitHub's limit on the levels of workflows one run connects, the top-level one included.
const WORKFLOW_LEVELS: usize = 10;

const LITERAL_MATRIX: &str = "write the job's `strategy.matrix` as literal lists and mappings (no `${{ }}`), or require a job whose matrix is literal";
const FIXED_NAME: &str = "build the job's `name:` only from text and expressions fixed on a pull request, such as `${{ matrix.os }}` over a literal matrix";
const CALL_FORM: &str = "write the job's `uses:` as `./.github/workflows/<file>.yml`";

/// Whether a branch filter entry or a ruleset include is a pattern (or a negation). `+` is
/// left out: it is literal in a git branch name and a ruleset include.
fn is_pattern(text: &str) -> bool {
    text.contains(['*', '?', '[', ']', '!'])
}

/// Why a job's names cannot be known from the files, and the edit that would make them
/// known.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Unresolved {
    reason: String,
    next: String,
}

fn unresolved(reason: impl Into<String>, next: impl Into<String>) -> Unresolved {
    Unresolved {
        reason: reason.into(),
        next: next.into(),
    }
}

/// The names a job reports on a pull request, or why they cannot be known from the files.
type JobNames = Result<Vec<String>, Unresolved>;

/// One matrix combination: each key's value, in the order GitHub lists them.
type Combination = Vec<(String, Node)>;

fn same(a: Option<&Node>, b: &Node) -> bool {
    a.is_some_and(|a| a.to_json() == b.to_json())
}

fn set(combination: &mut Combination, key: &str, value: &Node) {
    match combination.iter_mut().find(|(name, _)| name == key) {
        Some(slot) => slot.1 = value.clone(),
        None => combination.push((key.to_owned(), value.clone())),
    }
}

fn get<'a>(combination: &'a Combination, key: &str) -> Option<&'a Node> {
    combination
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

fn entry_list<'a>(matrix: &'a Node, key: &str) -> Result<Vec<&'a Node>, Unresolved> {
    let Some(value) = matrix.get(key) else {
        return Ok(Vec::new());
    };
    if !value.is_seq() || !value.items().iter().all(Node::is_map) {
        return Err(unresolved(
            format!("its matrix's `{key}` is not a list of mappings"),
            LITERAL_MATRIX,
        ));
    }
    Ok(value.items().iter().collect())
}

/// A matrix key made only of digits, whose order a JavaScript reader would not keep.
fn digit_key(matrix: &Node) -> Option<Unresolved> {
    let mut entries: Vec<&Node> = vec![matrix];
    for key in ["include", "exclude"] {
        match matrix.get(key) {
            Some(list) if list.is_seq() => entries.extend(list.items()),
            Some(entry) => entries.push(entry),
            None => {}
        }
    }
    let digits = entries
        .iter()
        .flat_map(|entry| entry.pairs().map(|(key, _)| key))
        .find(|key| !key.is_empty() && key.chars().all(|c| c.is_ascii_digit()));
    digits.map(|digits| {
        unresolved(
            format!(
                "its matrix has the key `{digits}`, made only of digits, whose order this check cannot keep"
            ),
            "rename that matrix key so it starts with a letter",
        )
    })
}

/// Each `include` entry added to every expanded combination whose original values it
/// agrees with, or appended as a combination of its own when it agrees with none.
fn add_includes(combinations: &mut Vec<Combination>, include: &[&Node], original: &[&str]) {
    let expanded = combinations.len();
    for entry in include {
        let pairs: Vec<(String, &Node)> = entry.pairs().collect();
        let mut matched = false;
        for combination in &mut combinations[..expanded] {
            let agrees = pairs.iter().all(|(key, value)| {
                !original.contains(&key.as_str()) || same(get(combination, key), value)
            });
            if agrees {
                matched = true;
                for (key, value) in &pairs {
                    set(combination, key, value);
                }
            }
        }
        if !matched {
            combinations.push(
                pairs
                    .into_iter()
                    .map(|(key, value)| (key, value.clone()))
                    .collect(),
            );
        }
    }
}

/// A `strategy.matrix`'s combinations as GitHub expands them, or why they cannot be known
/// from the file: the product of its lists, less every combination an `exclude` entry
/// matches, then each `include` entry added to every combination whose original values it
/// agrees with (overwriting only values an earlier `include` added), or appended as a
/// combination of its own when it agrees with none. A matrix, list, or entry holding an
/// expression is computed at run time, so it is not known; neither is one past GitHub's
/// limit of 256 jobs, nor one with a key made only of digits, whose order a JavaScript
/// reader would not keep.
fn matrix_combinations(matrix: Option<&Node>) -> Result<Vec<Combination>, Unresolved> {
    if matrix.is_some_and(|matrix| matrix.to_json().contains("${{")) {
        return Err(unresolved(
            "its matrix is computed by an expression",
            LITERAL_MATRIX,
        ));
    }
    let Some(matrix) = matrix.filter(|matrix| matrix.is_map()) else {
        return Err(unresolved("its matrix is not a mapping", LITERAL_MATRIX));
    };
    if let Some(why) = digit_key(matrix) {
        return Err(why);
    }
    let dimensions: Vec<(String, &Node)> = matrix
        .pairs()
        .filter(|(key, _)| key != "include" && key != "exclude")
        .collect();
    let mut size: usize = 1;
    for (key, values) in &dimensions {
        if !values.is_seq() || values.items().is_empty() {
            return Err(unresolved(
                format!("its matrix's `{key}` is not a non-empty list"),
                LITERAL_MATRIX,
            ));
        }
        size = size.saturating_mul(values.items().len());
    }
    let too_many_next =
        format!("cut the matrix to at most {MATRIX_LIMIT} combinations, or split the job");
    if size > EXPANSION_LIMIT {
        return Err(unresolved(
            format!(
                "its matrix's lists multiply to more than {EXPANSION_LIMIT} combinations before `exclude`, more than this check expands"
            ),
            too_many_next,
        ));
    }
    let mut combinations: Vec<Combination> = if dimensions.is_empty() {
        Vec::new()
    } else {
        vec![Vec::new()]
    };
    for (key, values) in &dimensions {
        combinations = combinations
            .iter()
            .flat_map(|combination| {
                values.items().iter().map(move |value| {
                    let mut next = combination.clone();
                    next.push((key.clone(), value.clone()));
                    next
                })
            })
            .collect();
    }
    let exclude = entry_list(matrix, "exclude")?;
    let include = entry_list(matrix, "include")?;
    combinations.retain(|combination| {
        !exclude.iter().any(|entry| {
            entry
                .pairs()
                .all(|(key, value)| same(get(combination, &key), value))
        })
    });
    let original: Vec<&str> = dimensions.iter().map(|(key, _)| key.as_str()).collect();
    add_includes(&mut combinations, &include, &original);
    if combinations.is_empty() {
        return Err(unresolved("its matrix has no combinations", LITERAL_MATRIX));
    }
    if combinations.len() > MATRIX_LIMIT {
        return Err(unresolved(
            format!("its matrix makes more than {MATRIX_LIMIT} combinations, GitHub's limit"),
            too_many_next,
        ));
    }
    Ok(combinations)
}

fn literal_of(node: &Node) -> Option<Literal> {
    match &node.value {
        Yaml::Null => Some(Literal::Null),
        Yaml::Bool(value) => Some(Literal::Bool(*value)),
        Yaml::Number(number) => Some(Literal::Number(*number)),
        Yaml::Str(text) => Some(Literal::Str(text.clone())),
        Yaml::Seq(_) | Yaml::Map(_) => None,
    }
}

/// The value a `matrix.*` path (lowercased) has in one combination, matched
/// case-insensitively as GitHub does. A property the combination does not have is `''`, as
/// GitHub's contexts reference documents for a nonexistent property; an object, a list, or
/// a `*` filter is unknown, since its text in a name is not documented.
fn matrix_value(combination: &Combination, path: &str) -> Value {
    let mut entries: Vec<(String, &Node)> = combination
        .iter()
        .map(|(key, value)| (key.clone(), value))
        .collect();
    let mut value: Option<&Node> = None;
    for key in path.split('.').skip(1) {
        if key == "*" {
            return Value::Unknown;
        }
        let Some((_, found)) = entries.iter().find(|(name, _)| name.to_lowercase() == key) else {
            return Value::Literal(Literal::Str(String::new()));
        };
        let found: &Node = found;
        value = Some(found);
        entries = found.pairs().collect();
    }
    value
        .and_then(literal_of)
        .map_or(Value::Unknown, Value::Literal)
}

/// A name with its expressions evaluated for a pull request and one combination, and
/// whether any of them reads `matrix`, or why it cannot be known.
fn render_name(
    name: &str,
    combination: Option<&Combination>,
) -> Result<(String, bool), Unresolved> {
    let mut rendered = String::new();
    let mut last = 0;
    let mut reads_matrix = false;
    for (start, end, source) in embedded(name) {
        let whole = &name[start..end];
        let mut resolve = |path: &str| {
            if path == "matrix" || path.starts_with("matrix.") {
                reads_matrix = true;
                return combination.map(|combination| matrix_value(combination, path));
            }
            None
        };
        let value = evaluate_on(EVENT, source, Some(&mut resolve));
        match value {
            None => {
                return Err(unresolved(
                    format!(
                        "this check cannot evaluate `{whole}` (a function call, an index, or another form it does not read)"
                    ),
                    FIXED_NAME,
                ));
            }
            Some(Value::Context(path)) => {
                return Err(unresolved(
                    format!("`{whole}` reads `{path}`, which is not fixed on a pull request"),
                    FIXED_NAME,
                ));
            }
            Some(Value::Unknown) => {
                return Err(unresolved(
                    format!("`{whole}` has no text this check can know"),
                    FIXED_NAME,
                ));
            }
            Some(Value::Literal(literal)) => {
                rendered.push_str(&name[last..start]);
                rendered.push_str(&literal.text());
            }
        }
        last = end;
    }
    rendered.push_str(&name[last..]);
    Ok((rendered, reads_matrix))
}

/// Every name a job written as `name` reports on a pull request, given its
/// `strategy.matrix` (`None` without one). A matrix job whose name has no expression
/// reports as `<name> (<values>)`, its values each a string, number, or boolean; one whose
/// name reads `matrix` reports the name evaluated for each combination, with no suffix.
/// Whether GitHub appends the values to a name whose expressions never read `matrix` is not
/// documented, so that name is not known.
fn job_names(name: &str, matrix: Option<&Node>, has_matrix: bool) -> JobNames {
    if !has_matrix {
        return render_name(name, None).map(|(rendered, _)| vec![rendered]);
    }
    let combinations = matrix_combinations(matrix)?;
    let expressions = embedded(name).len();
    let mut names: Vec<String> = Vec::new();
    for combination in &combinations {
        let next = if expressions == 0 {
            let values: Option<Vec<String>> = combination
                .iter()
                .map(|(_, value)| match &value.value {
                    Yaml::Null | Yaml::Seq(_) | Yaml::Map(_) => None,
                    Yaml::Bool(_) | Yaml::Number(_) | Yaml::Str(_) => value.scalar_text(),
                })
                .collect();
            let Some(values) = values else {
                return Err(unresolved(
                    "a matrix value is null, a mapping, or a list, whose text in the appended values is not documented",
                    "name the job with the values it reads, such as `name: Test (${{ matrix.os }})`",
                ));
            };
            format!("{name} ({})", values.join(", "))
        } else {
            let (rendered, reads_matrix) = render_name(name, Some(combination))?;
            if !reads_matrix {
                return Err(unresolved(
                    "its name has expressions but none reads `matrix`, so whether GitHub appends the matrix values is not known",
                    "read the matrix in the name (such as `${{ matrix.os }}`), or drop the name's expressions so GitHub appends the values",
                ));
            }
            rendered
        };
        if !names.contains(&next) {
            names.push(next);
        }
    }
    Ok(names)
}

struct ReportingJob {
    /// The job as written, for messages: its name, or `<caller> / <called job>`.
    label: String,
    names: JobNames,
    /// Why the job may not run on every pull request; empty when it always does.
    skips: Vec<String>,
    /// Its workflow's branch filters that only the default branch's name could judge.
    needs_default: Vec<String>,
}

/// A branch the ruleset gates: one by name, every branch (`~ALL`), or the default branch
/// when neither ci.yml nor this clone gives its name.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Gated {
    Name(String),
    All,
    Unknown(Unresolved),
}

/// Whether a GitHub branch filter pattern matches `branch`: `**` matches any text, `*` any
/// text but `/`, `?` one character.
fn branch_matches(pattern: &str, branch: &str) -> bool {
    let mut source = String::from("^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' if chars.peek() == Some(&'*') => {
                chars.next();
                source.push_str(".*");
            }
            '*' => source.push_str("[^/]*"),
            '?' => source.push('.'),
            other => source.push_str(&regex::escape(&other.to_string())),
        }
    }
    source.push('$');
    Regex::new(&source).is_ok_and(|pattern| pattern.is_match(branch))
}

/// The branch `refs/remotes/origin/HEAD` names when the root is the top of a git work tree
/// that has one, else `None`: a CI checkout has none, and a fixture is no work tree.
fn origin_head(input: &Input<'_>) -> Option<String> {
    let options = RunOptions {
        cwd: Some(input.root.to_path_buf()),
        env: Some(git_env(input.env)),
        ..RunOptions::default()
    };
    let git = |args: &[&str]| {
        let result = (input.run)("git", args, &options);
        result
            .success()
            .then(|| result.stdout_text().trim().to_owned())
    };
    let top = git(&["rev-parse", "--show-toplevel"]).filter(|top| !top.is_empty())?;
    let same_place = match (
        std::fs::canonicalize(&top),
        std::fs::canonicalize(input.root),
    ) {
        (Ok(top), Ok(root)) => top == root,
        _ => false,
    };
    if !same_place {
        return None;
    }
    git(&["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
        .and_then(|reference| reference.strip_prefix(ORIGIN).map(str::to_owned))
}

fn branch_unknown(actual: impl Into<String>, next: impl Into<String>) -> FailureDetails {
    finding(
        "ERR_CHECK_RULESET_BRANCH_UNKNOWN",
        format!("{RULESET}: the branches the ruleset gates cannot be read from it"),
        format!(
            "each `conditions.ref_name.include` entry to be `{DEFAULT_BRANCH}`, `~ALL`, or `refs/heads/<branch>` with no pattern"
        ),
        actual,
        next,
    )
}

/// The default branch's name, why it is not known, or why ci.yml and this clone disagree.
enum DefaultBranch {
    Name(String),
    Unknown(Unresolved),
    Mismatch(FailureDetails),
}

/// The default branch: the one literal branch among ci.yml's `on: push: branches:`
/// (patterns and negations aside), checked against `read_origin` (this clone's
/// origin/HEAD); else origin/HEAD itself, when ci.yml names no literal branch or names it
/// among several. Not knowing it fails nothing on its own: only a required job whose
/// trigger filters branches needs the name.
fn default_branch(root: &Path, read_origin: &dyn Fn() -> Option<String>) -> DefaultBranch {
    let file = read_yaml(root, CI).and_then(Result::ok);
    let branches = file.as_ref().and_then(|file| {
        let on = file.root.get("on").filter(|on| on.is_map())?;
        on.get("push").filter(|push| push.is_map())?.get("branches")
    });
    let entries: Vec<&Node> = match branches {
        Some(node) if node.as_str().is_some() => vec![node],
        Some(node) => node.items().iter().collect(),
        None => Vec::new(),
    };
    let mut literals: Vec<&str> = Vec::new();
    for entry in entries.iter().filter_map(|entry| entry.as_str()) {
        if !entry.is_empty() && !is_pattern(entry) && !literals.contains(&entry) {
            literals.push(entry);
        }
    }
    let origin = read_origin();
    if let [only] = literals.as_slice() {
        return match origin {
            Some(origin) if origin != *only => DefaultBranch::Mismatch(finding(
                "ERR_CHECK_RULESET_BRANCH_MISMATCH",
                format!(
                    "{CI} names `{only}` as the branch its push trigger runs on, but this clone's origin/HEAD is `{origin}`"
                ),
                format!(
                    "the one branch `on: push: branches:` in {CI} names literally to be the repository's default branch, the one `{DEFAULT_BRANCH}` in {RULESET} gates"
                ),
                format!("{CI}: {only}; refs/remotes/origin/HEAD: {ORIGIN}{origin}"),
                format!(
                    "if the default branch was renamed, rename it in `on: push: branches:` in {CI} too; if origin/HEAD is stale, run `git remote set-head origin --auto` and rerun the check"
                ),
            )),
            _ => DefaultBranch::Name((*only).to_owned()),
        };
    }
    if let Some(origin) = origin.as_deref()
        && (literals.is_empty() || literals.contains(&origin))
    {
        return DefaultBranch::Name(origin.to_owned());
    }
    let named = if literals.is_empty() {
        format!("{CI}'s `on: push: branches:` names no branch literally")
    } else {
        format!(
            "{CI}'s `on: push: branches:` names several branches ({})",
            literals.join(", ")
        )
    };
    let clone = origin.map_or_else(
        || "this checkout has no origin/HEAD".to_owned(),
        |origin| format!("origin/HEAD (`{origin}`) is none of them"),
    );
    let mut next =
        vec!["drop the `branches` filter from that job's pull_request trigger".to_owned()];
    if literals.is_empty() && branches.is_some() {
        next.push(format!("list the default branch by name in `on: push: branches:` in {CI} (its patterns can stay)"));
    }
    next.push("in a clone, run `git remote set-head origin --auto` so origin/HEAD names it (a CI checkout has none)".to_owned());
    next.push(format!("or include the branch by name in {RULESET} as `refs/heads/<branch>` (then `just ruleset` after merging, a human's step)"));
    DefaultBranch::Unknown(unresolved(format!("{named}, and {clone}"), next.join("; ")))
}

/// The branches the ruleset gates, or why its includes cannot be read. `read_origin` is
/// called only for `~DEFAULT_BRANCH`.
fn gated_branches(
    ruleset: &Json,
    root: &Path,
    read_origin: &dyn Fn() -> Option<String>,
) -> Result<Vec<Gated>, FailureDetails> {
    let include = ruleset
        .get("conditions")
        .and_then(|conditions| conditions.get("ref_name"))
        .and_then(|ref_name| ref_name.get("include"))
        .and_then(Json::as_array)
        .filter(|include| !include.is_empty());
    let Some(include) = include else {
        return Err(branch_unknown(
            format!("{RULESET} has no `conditions.ref_name.include` list"),
            format!(
                "add `\"conditions\": {{ \"ref_name\": {{ \"include\": [\"{DEFAULT_BRANCH}\"], \"exclude\": [] }} }}` to {RULESET}"
            ),
        ));
    };
    let mut gated: Vec<Gated> = Vec::new();
    for entry in include {
        let target = match entry.as_str() {
            Some("~ALL") => Gated::All,
            Some(DEFAULT_BRANCH) => match default_branch(root, read_origin) {
                DefaultBranch::Name(name) => Gated::Name(name),
                DefaultBranch::Unknown(why) => Gated::Unknown(why),
                DefaultBranch::Mismatch(failure) => return Err(failure),
            },
            other => {
                let name = other
                    .and_then(|entry| entry.strip_prefix(HEADS))
                    .unwrap_or_default();
                if name.is_empty() || is_pattern(name) {
                    return Err(branch_unknown(
                        format!(
                            "{RULESET} includes {entry}, which is not one branch this check can judge (a pattern, or another form)"
                        ),
                        format!(
                            "write each include in {RULESET} as `{DEFAULT_BRANCH}`, `~ALL`, or `refs/heads/<branch>`"
                        ),
                    ));
                }
                Gated::Name(name.to_owned())
            }
        };
        if !gated.contains(&target) {
            gated.push(target);
        }
    }
    Ok(gated)
}

#[derive(Default)]
struct BranchJudgement {
    skips: Vec<String>,
    needs_default: Vec<String>,
}

/// A trigger key's value as a list of strings, or `None` when the key is absent.
fn string_list(trigger: &Node, key: &str) -> Option<Vec<String>> {
    let value = trigger.get(key)?;
    let text = |node: &Node| node.scalar_text().unwrap_or_else(|| node.to_json());
    Some(if value.is_seq() {
        value.items().iter().map(text).collect()
    } else {
        vec![text(value)]
    })
}

/// Why a `pull_request` trigger may not fire on a pull request into `target`, and which of
/// its filters only the unknown default branch's name could judge. A trigger with no branch
/// filter, or only `branches: ['**']`, fires into every branch.
fn branch_judgement(trigger: &Node, target: &Gated, path: &str, judgement: &mut BranchJudgement) {
    let branches = string_list(trigger, "branches");
    let ignored = string_list(trigger, "branches-ignore");
    let everything = ignored.is_none()
        && branches.as_ref().is_none_or(|branches| {
            branches.iter().any(|pattern| pattern == "**")
                && !branches.iter().any(|pattern| pattern.starts_with('!'))
        });
    if everything {
        return;
    }
    match target {
        Gated::All => judgement.skips.push(format!(
            "{path}: its pull_request trigger filters branches, and the ruleset gates every branch (`~ALL`)"
        )),
        Gated::Unknown(_) => judgement
            .needs_default
            .push(format!("{path}: its pull_request trigger filters branches")),
        Gated::Name(branch) => {
            if let Some(branches) = &branches {
                let included = branches
                    .iter()
                    .any(|pattern| !pattern.starts_with('!') && branch_matches(pattern, branch));
                let negated = branches.iter().any(|pattern| {
                    pattern
                        .strip_prefix('!')
                        .is_some_and(|pattern| branch_matches(pattern, branch))
                });
                if !included || negated {
                    judgement
                        .skips
                        .push(format!("{path}: its pull_request trigger's `branches` do not match `{branch}`"));
                }
            }
            if ignored.is_some_and(|ignored| ignored.iter().any(|pattern| branch_matches(pattern, branch))) {
                judgement
                    .skips
                    .push(format!("{path}: its pull_request trigger's `branches-ignore` match `{branch}`"));
            }
        }
    }
}

/// Why a workflow's `pull_request` trigger may not fire on every pull request into `gated`.
fn trigger_judgement(workflow: &YamlFile, gated: &[Gated]) -> BranchJudgement {
    let mut judgement = BranchJudgement::default();
    let trigger = workflow
        .root
        .get("on")
        .filter(|on| on.is_map())
        .and_then(|on| on.get("pull_request"))
        .filter(|trigger| trigger.is_map());
    let Some(trigger) = trigger else {
        return judgement;
    };
    for key in FILTERS.into_iter().filter(|key| trigger.has(key)) {
        judgement.skips.push(format!(
            "{}: its pull_request trigger filters `{key}`",
            workflow.path
        ));
    }
    for target in gated {
        branch_judgement(trigger, target, &workflow.path, &mut judgement);
    }
    if let Some(types) = trigger.get("types") {
        let listed: Vec<&Node> = if types.is_seq() {
            types.items().iter().collect()
        } else {
            vec![types]
        };
        let missing: Vec<&str> = DEFAULT_TYPES
            .into_iter()
            .filter(|kind| !listed.iter().any(|listed| listed.as_str() == Some(kind)))
            .collect();
        if !missing.is_empty() {
            judgement.skips.push(format!(
                "{}: its pull_request trigger's `types` leave out {}",
                workflow.path,
                missing.join(", ")
            ));
        }
    }
    judgement
}

/// Why a job may not run on every pull request, following its `needs`.
fn job_skips(
    workflow: &YamlFile,
    jobs: &[(String, &Node)],
    id: &str,
    seen: &[&str],
) -> Vec<String> {
    let path = &workflow.path;
    let Some((_, job)) = jobs.iter().find(|(name, _)| name == id) else {
        return vec![format!("{path}: a job needs `{id}`, which does not exist")];
    };
    if seen.contains(&id) {
        return vec![format!("{path}: job `{id}` needs itself through a cycle")];
    }
    let mut skips = Vec::new();
    if let Some(condition) = job.get("if")
        && condition_on(EVENT, condition) != Some(true)
    {
        let shown = condition
            .as_str()
            .map_or_else(|| condition.to_json(), str::to_owned);
        skips.push(format!(
            "{path}: job `{id}` has `if: {shown}`, which is not provably true on every pull request"
        ));
    }
    let needed: Vec<&Node> = match job.get("needs") {
        Some(need) if need.as_str().is_some() => vec![need],
        Some(needs) => needs.items().iter().collect(),
        None => Vec::new(),
    };
    let mut deeper: Vec<&str> = seen.to_vec();
    deeper.push(id);
    for need in needed {
        match need.as_str() {
            Some(need) => skips.extend(job_skips(workflow, jobs, need, &deeper)),
            None => skips.push(format!(
                "{path}: job `{id}` has a `needs` entry that is not a job id"
            )),
        }
    }
    skips
}

/// Whether `uses` is `./.github/workflows/<file>.yml` (or `.yaml`), a file directly there.
fn is_local_workflow(uses: &str) -> bool {
    uses.strip_prefix("./.github/workflows/")
        .is_some_and(|file| {
            !file.contains('/')
                && file
                    .strip_suffix(".yml")
                    .or_else(|| file.strip_suffix(".yaml"))
                    .is_some_and(|stem| !stem.is_empty())
        })
}

/// The workflow a job-level `uses:` calls, or why it cannot be read here: only the form
/// GitHub documents for a workflow in the same repository, `./.github/workflows/<file>`, no
/// deeper than GitHub's ten levels of workflows. `stack` holds the calling chain.
fn called_workflow<'a>(
    uses: Option<&Node>,
    by_path: &HashMap<&str, &'a YamlFile>,
    stack: &[String],
) -> Result<&'a YamlFile, Unresolved> {
    let Some(uses) = uses.and_then(Node::as_str) else {
        return Err(unresolved("its `uses:` is not a string", CALL_FORM));
    };
    if !uses.starts_with("./") {
        return Err(unresolved(
            format!(
                "it calls `{uses}`, a workflow in another repository that this check cannot read"
            ),
            "require a job this repository's workflows define, or copy the called workflow into .github/workflows/ and call it as `./.github/workflows/<file>.yml`",
        ));
    }
    if !is_local_workflow(uses) {
        return Err(unresolved(
            format!(
                "it calls `{uses}`, which is not the documented `./.github/workflows/<file>.yml` form"
            ),
            format!("{CALL_FORM}: a file directly in that directory, with no `..` or subdirectory"),
        ));
    }
    let path = &uses[2..];
    let Some(workflow) = by_path.get(path) else {
        return Err(unresolved(
            format!("it calls `{uses}`, which does not exist or does not parse as a workflow"),
            format!(
                "restore {path}, or point the job's `uses:` at an existing workflow (workflow-hygiene reports one that does not parse)"
            ),
        ));
    };
    if stack.iter().any(|caller| caller == path) {
        return Err(unresolved(
            format!("it calls `{uses}`, which calls back through a cycle"),
            "break the cycle: a reusable workflow must not call itself, directly or through another",
        ));
    }
    if stack.len() >= WORKFLOW_LEVELS {
        return Err(unresolved(
            format!(
                "it calls `{uses}` below {} levels of workflows, past GitHub's limit of {WORKFLOW_LEVELS}",
                stack.len()
            ),
            format!(
                "flatten the chain of reusable-workflow calls to at most {WORKFLOW_LEVELS} levels, the top-level workflow included"
            ),
        ));
    }
    if !trigger_names(&workflow.root)
        .iter()
        .any(|event| event == "workflow_call")
    {
        return Err(unresolved(
            format!("it calls `{uses}`, whose `on:` does not name `workflow_call`"),
            format!("add `workflow_call` to the `on:` of {path}"),
        ));
    }
    Ok(workflow)
}

/// The text a job's `name:` reports as, before its expressions are evaluated: its id
/// without one, a string as written, and a boolean or an integer as GitHub's workflow
/// parser converts a scalar where it expects a string (its `toString`: `true`, `123`;
/// <https://github.com/actions/languageservices/blob/main/workflow-parser/src/templates/template-reader.ts>,
/// checked 2026-09-30). A null (converted to `''`), a fraction or an integer past 2^53
/// (whose text depends on the parser's number formatting), or a mapping is not known.
fn job_name_text(id: &str, name: Option<&Node>) -> Result<String, Unresolved> {
    /// 2^53 - 1, the largest integer a JavaScript number holds exactly.
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    let Some(name) = name else {
        return Ok(id.to_owned());
    };
    let shape = match &name.value {
        Yaml::Str(text) => return Ok(text.clone()),
        Yaml::Bool(value) => return Ok(value.to_string()),
        Yaml::Number(number) if number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER => {
            return Ok(number_text(*number));
        }
        Yaml::Number(number) => format!("the number {}", number_text(*number)),
        Yaml::Null => "null".to_owned(),
        Yaml::Seq(_) | Yaml::Map(_) => "not a scalar".to_owned(),
    };
    Err(unresolved(
        format!("its `name:` is {shape}, whose reported text this check does not know"),
        "quote the job's `name:` as a string, such as `name: \"Build\"`",
    ))
}

fn join_names(outer: &JobNames, inner: &JobNames) -> JobNames {
    let outer = outer.clone()?;
    let inner = inner.clone()?;
    Ok(outer
        .iter()
        .flat_map(|first| {
            inner
                .iter()
                .map(move |second| format!("{first} / {second}"))
        })
        .collect())
}

/// What each job of a workflow reports, a job calling a reusable workflow standing for each
/// job it calls. `stack` is the chain of workflow paths being read.
fn reporting_jobs(
    workflow: &YamlFile,
    by_path: &HashMap<&str, &YamlFile>,
    stack: &[String],
) -> Vec<ReportingJob> {
    let jobs = jobs_of(workflow);
    let mut reporting = Vec::new();
    for (id, job) in &jobs {
        let name = job_name_text(id, job.get("name"));
        let label = name.clone().unwrap_or_else(|_| id.clone());
        let strategy = job.get("strategy");
        let names = match (&name, strategy) {
            (Err(why), _) => Err(why.clone()),
            (Ok(name), None) => job_names(name, None, false),
            (Ok(name), Some(strategy)) if strategy.is_map() => {
                job_names(name, strategy.get("matrix"), strategy.has("matrix"))
            }
            (Ok(_), Some(_)) => Err(unresolved(
                "its `strategy` is not a mapping",
                "write the job's `strategy:` as a mapping",
            )),
        };
        let skips = job_skips(workflow, &jobs, id, &[]);
        let Some(uses) = job.get("uses") else {
            reporting.push(ReportingJob {
                label,
                names,
                skips,
                needs_default: Vec::new(),
            });
            continue;
        };
        match called_workflow(Some(uses), by_path, stack) {
            Err(why) => reporting.push(ReportingJob {
                label,
                names: Err(why),
                skips,
                needs_default: Vec::new(),
            }),
            Ok(called) => {
                let mut deeper = stack.to_vec();
                deeper.push(called.path.clone());
                for inner in reporting_jobs(called, by_path, &deeper) {
                    let mut all_skips = skips.clone();
                    all_skips.extend(inner.skips);
                    reporting.push(ReportingJob {
                        label: format!("{label} / {}", inner.label),
                        names: join_names(&names, &inner.names),
                        skips: all_skips,
                        needs_default: Vec::new(),
                    });
                }
            }
        }
    }
    reporting
}

fn pull_request_jobs(root: &Path, gated: &[Gated]) -> Vec<ReportingJob> {
    let (workflows, _) = read_workflows(root);
    let by_path: HashMap<&str, &YamlFile> = workflows
        .iter()
        .map(|workflow| (workflow.path.as_str(), workflow))
        .collect();
    let mut jobs = Vec::new();
    for workflow in workflows.iter().filter(|workflow| {
        trigger_names(&workflow.root)
            .iter()
            .any(|event| event == "pull_request")
    }) {
        let trigger = trigger_judgement(workflow, gated);
        for job in reporting_jobs(workflow, &by_path, std::slice::from_ref(&workflow.path)) {
            let mut skips = trigger.skips.clone();
            skips.extend(job.skips);
            jobs.push(ReportingJob {
                skips,
                needs_default: trigger.needs_default.clone(),
                ..job
            });
        }
    }
    jobs
}

fn required_contexts(ruleset: &Json) -> Vec<String> {
    ruleset
        .get("rules")
        .and_then(Json::as_array)
        .map(|rules| {
            rules
                .iter()
                .filter(|rule| {
                    rule.get("type").and_then(Json::as_str) == Some("required_status_checks")
                })
                .filter_map(|rule| {
                    rule.get("parameters")?
                        .get("required_status_checks")?
                        .as_array()
                })
                .flatten()
                .filter_map(|entry| {
                    entry
                        .get("context")
                        .and_then(Json::as_str)
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for item in items {
        if !found.contains(&item) {
            found.push(item);
        }
    }
    found
}

fn context_violation(
    context: &str,
    jobs: &[ReportingJob],
    gated: &[Gated],
) -> Option<FailureDetails> {
    let matching: Vec<&ReportingJob> = jobs
        .iter()
        .filter(|job| {
            job.names
                .as_ref()
                .is_ok_and(|names| names.iter().any(|name| name == context))
        })
        .collect();
    if matching.is_empty() {
        let reported: Vec<&str> = jobs
            .iter()
            .filter_map(|job| job.names.as_ref().ok())
            .flatten()
            .map(String::as_str)
            .collect();
        let unknown: Vec<(&ReportingJob, &Unresolved)> = jobs
            .iter()
            .filter_map(|job| job.names.as_ref().err().map(|why| (job, why)))
            .collect();
        let mut actual = format!(
            "pull_request jobs report: {}",
            if reported.is_empty() {
                "none".to_owned()
            } else {
                reported.join(", ")
            }
        );
        if !unknown.is_empty() {
            let listed: Vec<String> = unknown
                .iter()
                .map(|(job, why)| format!("`{}` ({})", job.label, why.reason))
                .collect();
            actual = format!(
                "{actual}; and jobs whose names this check cannot know from the files: {}",
                listed.join("; ")
            );
        }
        let mut next = vec![format!(
            "rename the context in {RULESET} to a name a job reports, or restore the job"
        )];
        next.extend(
            unknown
                .iter()
                .map(|(job, why)| format!("for `{}`, {}", job.label, why.next)),
        );
        next.push("then `just ruleset` after merging, a human's step".to_owned());
        return Some(finding(
            "ERR_CHECK_RULESET_CONTEXT",
            format!(
                "{RULESET}: required context \"{context}\" matches no job in a pull_request-triggered workflow"
            ),
            "every required context to equal a name a job reports in a .github/workflows/*.yml triggered on pull_request: its `name:` (or id) with each `${{ }}` evaluated, `<name> (<values>)` for each combination of a matrix job whose name has no expression, and `<caller> / <called job>` for a job calling a reusable workflow in this repository",
            actual,
            next.join("; "),
        ));
    }
    let running: Vec<&&ReportingJob> = matching.iter().filter(|job| job.skips.is_empty()).collect();
    if running.iter().any(|job| job.needs_default.is_empty()) {
        return None;
    }
    let unknown = gated.iter().find_map(|target| match target {
        Gated::Unknown(why) => Some(why),
        Gated::Name(_) | Gated::All => None,
    });
    if let (false, Some(why)) = (running.is_empty(), unknown) {
        let filters = unique(running.iter().flat_map(|job| job.needs_default.clone()));
        return Some(finding(
            "ERR_CHECK_RULESET_BRANCH_UNKNOWN",
            format!(
                "{RULESET}: required context \"{context}\" is reported by a job whose pull_request trigger filters branches, and the default branch the ruleset gates (`{DEFAULT_BRANCH}`) cannot be known offline"
            ),
            format!(
                "the default branch's name, to judge the filter: the one branch `on: push: branches:` in {CI} names literally, or this clone's origin/HEAD"
            ),
            format!("{}; {}", filters.join("; "), why.reason),
            why.next.clone(),
        ));
    }
    Some(finding(
        "ERR_CHECK_RULESET_CONTEXT_SKIPPED",
        format!(
            "{RULESET}: required context \"{context}\" is reported only by jobs that may not run on every pull request"
        ),
        "a job reporting each required context on every pull request: no paths filter and no branch filter excluding the gated branch on its workflow's pull_request trigger, the default activity types, and no `if:` (on it or a job it needs) that can be false; for a job in a reusable workflow, the calling job (and every job it needs) must run on every pull request too",
        unique(matching.iter().flat_map(|job| job.skips.clone())).join("; "),
        format!(
            "drop the filter or the `if:` from the job {RULESET} requires, or from the job that calls it (skip inside its steps instead), or remove the context from {RULESET} (then `just ruleset` after merging, a human's step)"
        ),
    ))
}

/// The check, with origin/HEAD's reader injected so a test can stand in for a clone.
fn check_with(root: &Path, read_origin: &dyn Fn() -> Option<String>) -> Vec<FailureDetails> {
    let Some(text) = read_file(root, RULESET) else {
        return vec![finding(
            "ERR_CHECK_RULESET_MISSING",
            format!("{RULESET} does not exist"),
            format!("the main-branch ruleset at {RULESET} (applied by `just ruleset`)"),
            "no file",
            format!("restore {RULESET} from version control"),
        )];
    };
    let ruleset: Json = match serde_json::from_str(&text) {
        Ok(ruleset) => ruleset,
        Err(error) => {
            return vec![finding(
                "ERR_CHECK_RULESET_UNREADABLE",
                format!("{RULESET} is not JSON"),
                "a JSON ruleset in the shape GitHub's rulesets API takes",
                error.to_string(),
                format!("fix the syntax of {RULESET}"),
            )];
        }
    };
    let contexts = required_contexts(&ruleset);
    if contexts.is_empty() {
        return Vec::new();
    }
    let gated = match gated_branches(&ruleset, root, read_origin) {
        Ok(gated) => gated,
        Err(failure) => return vec![failure],
    };
    let jobs = pull_request_jobs(root, &gated);
    contexts
        .iter()
        .filter_map(|context| context_violation(context, &jobs, &gated))
        .collect()
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    check_with(input.root, &|| origin_head(input))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        Unresolved, branch_matches, check_with, job_name_text, job_names, matrix_combinations,
        origin_head, run,
    };
    use crate::check_harness::Input;
    use crate::check_harness::test_support::{codes, run_at};
    use crate::check_harness::yaml::{self, Keys, Node};
    use crate::context::{Env, RunOptions, RunResult, run_command};
    use crate::fail::FailureDetails;
    use crate::test_support::{git, hook_env, temp_dir, write};

    const CI: &str = "name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  build:\n    name: Build\n    runs-on: ubuntu-24.04\n  lint:\n    runs-on: ubuntu-24.04\n  analyze:\n    name: Analyze (${{ matrix.language }})\n    strategy:\n      matrix:\n        language: [rust, actions]\n  test:\n    name: Test\n    strategy:\n      matrix:\n        os: [ubuntu, macos]\n";
    const TITLE: &str = "on: [pull_request]\njobs:\n  main:\n    name: Validate PR title\n";
    const PUSH_ONLY: &str = "on: push\njobs:\n  deploy:\n    name: Deploy\n";
    const TARGET: &str = "on:\n  pull_request_target:\njobs:\n  label:\n    name: Label\n";
    const PASSING: [&str; 5] = [
        "Build",
        "lint",
        "Analyze (rust)",
        "Test (ubuntu)",
        "Validate PR title",
    ];
    const RULESET: &str = ".github/rulesets/main.json";

    fn ruleset_with(contexts: &[&str], include: &serde_json::Value) -> String {
        let checks: Vec<serde_json::Value> = contexts
            .iter()
            .map(|context| serde_json::json!({ "context": context, "integration_id": 1 }))
            .collect();
        serde_json::json!({
            "name": "main",
            "conditions": { "ref_name": { "include": include, "exclude": [] } },
            "rules": [
                { "type": "deletion" },
                { "type": "required_status_checks", "parameters": { "required_status_checks": checks } }
            ]
        })
        .to_string()
    }

    fn ruleset(contexts: &[&str]) -> String {
        ruleset_with(contexts, &serde_json::json!(["~DEFAULT_BRANCH"]))
    }

    fn tree(overrides: &[(&str, Option<&str>)]) -> tempfile::TempDir {
        let passing = ruleset(&PASSING);
        let mut files: Vec<(&str, Option<&str>)> = vec![
            (RULESET, Some(&passing)),
            (".github/workflows/ci.yml", Some(CI)),
            (".github/workflows/title.yaml", Some(TITLE)),
            (".github/workflows/push.yml", Some(PUSH_ONLY)),
            (".github/workflows/target.yml", Some(TARGET)),
            (".github/workflows/broken.yml", Some("jobs: [\n")),
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
        dir
    }

    fn check_origin(
        overrides: &[(&str, Option<&str>)],
        origin: Option<&str>,
    ) -> Vec<FailureDetails> {
        let dir = tree(overrides);
        check_with(dir.path(), &|| origin.map(str::to_owned))
    }

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<FailureDetails> {
        check_origin(overrides, None)
    }

    fn fails_closed(overrides: &[(&str, Option<&str>)], reason: &str, next: &str) {
        let found = check(overrides);
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_CONTEXT"], "{found:?}");
        assert!(found[0].actual.contains(reason), "{}", found[0].actual);
        assert!(found[0].next.contains(next), "{}", found[0].next);
    }

    fn node(text: &str) -> Node {
        yaml::parse(text, Keys::Unique).expect("YAML").root
    }

    fn names(name: &str, matrix: Option<&str>) -> Result<Vec<String>, Unresolved> {
        let matrix = matrix.map(node);
        job_names(name, matrix.as_ref(), matrix.is_some())
    }

    fn reason(found: Result<Vec<String>, Unresolved>) -> String {
        match found {
            Ok(names) => format!("resolved: {}", names.join(", ")),
            Err(why) => why.reason,
        }
    }

    #[test]
    fn passes_when_every_context_names_a_pull_request_job() {
        assert_eq!(check(&[]), []);
        let rules = serde_json::json!({ "rules": [{ "type": "deletion" }] }).to_string();
        assert_eq!(check(&[(RULESET, Some(&rules))]), []);
        assert_eq!(check(&[(RULESET, Some("[]"))]), []);
    }

    #[test]
    fn rejects_a_context_no_pull_request_job_reports() {
        let found = check(&[(RULESET, Some(&ruleset(&["Build", "Bild"])))]);
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_CONTEXT"]);
        assert!(found[0].summary.contains("\"Bild\""));
        for context in ["Deploy", "Label", "build"] {
            assert_eq!(
                codes(&check(&[(RULESET, Some(&ruleset(&[context])))])),
                ["ERR_CHECK_RULESET_CONTEXT"],
                "{context}"
            );
        }
        assert_eq!(
            codes(&check(&[(RULESET, None)])),
            ["ERR_CHECK_RULESET_MISSING"]
        );
        assert_eq!(
            codes(&check(&[(RULESET, Some("{"))])),
            ["ERR_CHECK_RULESET_UNREADABLE"]
        );
        let empty = tree(&[
            (".github/workflows/ci.yml", None),
            (".github/workflows/title.yaml", None),
            (RULESET, Some(&ruleset(&["Build"]))),
        ]);
        let found = check_with(empty.path(), &|| None);
        assert!(
            found[0]
                .actual
                .starts_with("pull_request jobs report: none"),
            "{}",
            found[0].actual
        );
    }

    fn docs_workflow(trigger: &str, job: &str) -> String {
        format!(
            "on:\n  pull_request:{trigger}\njobs:\n  build:\n    name: Build\n    runs-on: ubuntu-24.04\n  docs:\n    runs-on: ubuntu-24.04\n{job}"
        )
    }

    #[test]
    fn requires_a_context_be_reported_on_every_pull_request() {
        let docs_ruleset = ruleset(&["Build", "Docs Only"]);
        for trigger in [
            "\n    paths: [\"docs/**\"]",
            "\n    paths-ignore: [\"**.md\"]",
            "\n    branches: [\"release/**\"]",
            "\n    branches: [\"**\", \"!main\"]",
            "\n    branches-ignore: [main]",
            "\n    types: [opened, reopened]",
            "\n    types: opened",
        ] {
            let found = check(&[
                (
                    ".github/workflows/docs.yml",
                    Some(&docs_workflow(trigger, "    name: Docs Only\n")),
                ),
                (RULESET, Some(&docs_ruleset)),
            ]);
            assert_eq!(
                codes(&found),
                ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"],
                "{trigger}"
            );
            assert!(found[0].summary.contains("\"Docs Only\""));
            assert!(found[0].actual.contains(".github/workflows/docs.yml"));
        }
        for trigger in [
            "\n    branches: [main]",
            "\n    branches: [\"**\"]",
            "\n    branches: \"m*\"",
            "\n    branches-ignore: [\"dependabot/**\"]",
            "\n    types: [opened, synchronize, reopened, edited]",
        ] {
            assert_eq!(
                check(&[
                    (
                        ".github/workflows/docs.yml",
                        Some(&docs_workflow(trigger, "    name: Docs Only\n"))
                    ),
                    (RULESET, Some(&ruleset(&["Docs Only"])))
                ]),
                [],
                "{trigger}"
            );
        }
        let trunk = ruleset_with(&["Docs Only"], &serde_json::json!(["refs/heads/trunk"]));
        let found = check(&[
            (
                ".github/workflows/docs.yml",
                Some(&docs_workflow(
                    "\n    branches: [main]",
                    "    name: Docs Only\n",
                )),
            ),
            (RULESET, Some(&trunk)),
        ]);
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
        let paths = docs_workflow("\n    paths: [\"docs/**\"]", "    name: Build\n");
        assert_eq!(check(&[(".github/workflows/docs.yml", Some(&paths))]), []);
    }

    #[test]
    fn requires_a_job_condition_true_on_every_pull_request() {
        for condition in [
            "github.event_name == 'push'",
            "${{ github.ref == 'refs/heads/main' }}",
            "always()",
            "false",
        ] {
            let job = format!("    name: Docs Only\n    if: \"{condition}\"\n");
            let found = check(&[
                (".github/workflows/docs.yml", Some(&docs_workflow("", &job))),
                (RULESET, Some(&ruleset(&["Docs Only"]))),
            ]);
            assert_eq!(
                codes(&found),
                ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"],
                "{condition}"
            );
        }
        let job = "    name: Docs Only\n    if: [1]\n";
        let found = check(&[
            (".github/workflows/docs.yml", Some(&docs_workflow("", job))),
            (RULESET, Some(&ruleset(&["Docs Only"]))),
        ]);
        assert!(found[0].actual.contains("`if: [1]`"));
        for condition in [
            "true",
            "github.event_name == 'pull_request'",
            "${{ github.event_name != 'push' }}",
        ] {
            let job = format!("    name: Docs Only\n    if: \"{condition}\"\n");
            assert_eq!(
                check(&[
                    (".github/workflows/docs.yml", Some(&docs_workflow("", &job))),
                    (RULESET, Some(&ruleset(&["Docs Only"])))
                ]),
                [],
                "{condition}"
            );
        }
        let gated = "on: pull_request\njobs:\n  gate:\n    if: github.event_name == 'push'\n    runs-on: ubuntu-24.04\n  docs:\n    name: Docs Only\n    needs: [gate]\n    runs-on: ubuntu-24.04\n";
        let found = check(&[
            (".github/workflows/docs.yml", Some(gated)),
            (RULESET, Some(&ruleset(&["Docs Only"]))),
        ]);
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
        assert!(found[0].actual.contains("job `gate`"));
        for needs in ["nowhere", "loop", "[1]"] {
            let docs = format!(
                "on: pull_request\njobs:\n  docs:\n    name: Docs Only\n    needs: {needs}\n    runs-on: ubuntu-24.04\n  loop:\n    needs: docs\n    runs-on: ubuntu-24.04\n"
            );
            assert_eq!(
                codes(&check(&[
                    (".github/workflows/docs.yml", Some(&docs)),
                    (RULESET, Some(&ruleset(&["Docs Only"])))
                ])),
                ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"],
                "{needs}"
            );
        }
    }

    fn ci_on(push: &str) -> String {
        CI.replacen(
            "on:\n  push:\n    branches: [main]\n  pull_request:\n",
            &format!("on:\n{push}  pull_request:\n"),
            1,
        )
    }

    fn with_docs(trigger: &str) -> String {
        format!(
            "on:\n  pull_request:\n{trigger}jobs:\n  docs:\n    name: Docs Only\n    runs-on: ubuntu-24.04\n"
        )
    }

    #[test]
    fn resolves_the_default_branch_from_ci_yml() {
        let docs_ruleset = ruleset(&["Docs Only"]);
        let trunk_ci = ci_on("  push:\n    branches: [trunk]\n");
        assert_eq!(
            check(&[
                (".github/workflows/ci.yml", Some(&trunk_ci)),
                (
                    ".github/workflows/docs.yml",
                    Some(&with_docs("    branches: [trunk]\n"))
                ),
                (RULESET, Some(&docs_ruleset))
            ]),
            []
        );
        let found = check(&[
            (".github/workflows/ci.yml", Some(&trunk_ci)),
            (
                ".github/workflows/docs.yml",
                Some(&with_docs("    branches: [main]\n")),
            ),
            (RULESET, Some(&docs_ruleset)),
        ]);
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
        assert!(found[0].actual.contains("do not match `trunk`"));
        let string_ci = ci_on("  push:\n    branches: trunk\n");
        assert_eq!(
            check(&[
                (".github/workflows/ci.yml", Some(&string_ci)),
                (
                    ".github/workflows/docs.yml",
                    Some(&with_docs("    branches: [trunk]\n"))
                ),
                (RULESET, Some(&docs_ruleset))
            ]),
            []
        );
        let patterned = ci_on("  push:\n    branches: [main, \"release/**\"]\n");
        assert_eq!(
            check(&[
                (".github/workflows/ci.yml", Some(&patterned)),
                (
                    ".github/workflows/docs.yml",
                    Some(&with_docs("    branches: [main]\n"))
                ),
                (RULESET, Some(&docs_ruleset))
            ]),
            []
        );
    }

    #[test]
    fn fails_never_assuming_main_when_the_default_branch_is_unknown() {
        let docs_ruleset = ruleset(&["Docs Only"]);
        let shapes = [
            ci_on(""),
            CI.replacen(
                "on:\n  push:\n    branches: [main]\n  pull_request:\n",
                "on: [push, pull_request]\n",
                1,
            ),
            ci_on("  push:\n"),
            ci_on("  push:\n    branches-ignore: [dev]\n"),
            ci_on("  push:\n    branches: [main, trunk]\n"),
            ci_on("  push:\n    branches: [\"release/**\"]\n"),
            ci_on("  push:\n    branches: []\n"),
            ci_on("  push:\n    branches: [1]\n"),
        ];
        for ci in &shapes {
            assert_ne!(ci, CI);
            assert_eq!(check(&[(".github/workflows/ci.yml", Some(ci))]), [], "{ci}");
            assert_eq!(
                check(&[
                    (".github/workflows/ci.yml", Some(ci)),
                    (
                        ".github/workflows/docs.yml",
                        Some(&with_docs("    branches: [\"**\"]\n"))
                    ),
                    (RULESET, Some(&docs_ruleset))
                ]),
                []
            );
            let found = check(&[
                (".github/workflows/ci.yml", Some(ci)),
                (
                    ".github/workflows/docs.yml",
                    Some(&with_docs("    branches: [main]\n")),
                ),
                (RULESET, Some(&docs_ruleset)),
            ]);
            assert_eq!(codes(&found), ["ERR_CHECK_RULESET_BRANCH_UNKNOWN"], "{ci}");
            assert!(found[0].summary.contains("\"Docs Only\""));
            assert!(found[0].actual.contains(".github/workflows/docs.yml"));
            assert!(found[0].next.contains("git remote set-head origin --auto"));
            assert!(found[0].next.contains("drop the `branches` filter"));
        }
        let found = check(&[
            (".github/workflows/ci.yml", Some(&ci_on("  push:\n"))),
            (
                ".github/workflows/docs.yml",
                Some(&with_docs("    branches: [main]\n")),
            ),
            (RULESET, Some(&docs_ruleset)),
        ]);
        assert!(!found[0].next.contains("list the default branch by name"));
        let found = check(&[
            (
                ".github/workflows/ci.yml",
                Some(&ci_on("  push:\n    branches: [\"release/**\"]\n")),
            ),
            (
                ".github/workflows/docs.yml",
                Some(&with_docs("    branches: [main]\n")),
            ),
            (RULESET, Some(&docs_ruleset)),
        ]);
        assert!(found[0].next.contains("list the default branch by name"));
        let no_branch = ci_on("  push:\n");
        assert_eq!(
            codes(&check(&[
                (".github/workflows/ci.yml", Some(&no_branch)),
                (
                    ".github/workflows/docs.yml",
                    Some(&with_docs("    branches-ignore: [dependabot/**]\n"))
                ),
                (RULESET, Some(&docs_ruleset))
            ])),
            ["ERR_CHECK_RULESET_BRANCH_UNKNOWN"]
        );
        assert_eq!(
            check(&[
                (".github/workflows/ci.yml", Some(&no_branch)),
                (
                    ".github/workflows/docs.yml",
                    Some(&with_docs("    branches: [main]\n"))
                ),
                (RULESET, Some(&ruleset(&["Build"])))
            ]),
            []
        );
        assert_eq!(
            codes(&check(&[
                (".github/workflows/ci.yml", Some(&no_branch)),
                (
                    ".github/workflows/docs.yml",
                    Some(&with_docs(
                        "    branches: [main]\n    paths: [\"docs/**\"]\n"
                    ))
                ),
                (RULESET, Some(&docs_ruleset))
            ])),
            ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]
        );
        for ci in [None, Some("on: [\n"), Some("- a\n")] {
            assert_eq!(
                check(&[
                    (".github/workflows/ci.yml", ci),
                    (".github/workflows/docs.yml", Some(&with_docs(""))),
                    (RULESET, Some(&docs_ruleset))
                ]),
                []
            );
            assert_eq!(
                codes(&check(&[
                    (".github/workflows/ci.yml", ci),
                    (
                        ".github/workflows/docs.yml",
                        Some(&with_docs("    branches: [main]\n"))
                    ),
                    (RULESET, Some(&docs_ruleset))
                ])),
                ["ERR_CHECK_RULESET_BRANCH_UNKNOWN"]
            );
        }
    }

    #[test]
    fn takes_origin_head_when_ci_yml_names_no_single_branch() {
        let docs_ruleset = ruleset(&["Docs Only"]);
        let none = ci_on("  push:\n");
        assert_eq!(
            check_origin(
                &[
                    (".github/workflows/ci.yml", Some(&none)),
                    (
                        ".github/workflows/docs.yml",
                        Some(&with_docs("    branches: [trunk]\n"))
                    ),
                    (RULESET, Some(&docs_ruleset))
                ],
                Some("trunk")
            ),
            []
        );
        assert_eq!(
            codes(&check_origin(
                &[
                    (".github/workflows/ci.yml", Some(&none)),
                    (
                        ".github/workflows/docs.yml",
                        Some(&with_docs("    branches: [main]\n"))
                    ),
                    (RULESET, Some(&docs_ruleset))
                ],
                Some("trunk")
            )),
            ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]
        );
        let several = ci_on("  push:\n    branches: [main, develop]\n");
        assert_eq!(
            check_origin(
                &[
                    (".github/workflows/ci.yml", Some(&several)),
                    (
                        ".github/workflows/docs.yml",
                        Some(&with_docs("    branches: [develop]\n"))
                    ),
                    (RULESET, Some(&docs_ruleset))
                ],
                Some("develop")
            ),
            []
        );
        let found = check_origin(
            &[
                (".github/workflows/ci.yml", Some(&several)),
                (
                    ".github/workflows/docs.yml",
                    Some(&with_docs("    branches: [develop]\n")),
                ),
                (RULESET, Some(&docs_ruleset)),
            ],
            Some("trunk"),
        );
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_BRANCH_UNKNOWN"]);
        assert!(
            found[0]
                .actual
                .contains("origin/HEAD (`trunk`) is none of them")
        );
        let found = check_origin(&[], Some("trunk"));
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_BRANCH_MISMATCH"]);
        assert!(found[0].actual.contains("refs/remotes/origin/trunk"));
        assert_eq!(check_origin(&[], Some("main")), []);
        let named = ruleset_with(&PASSING, &serde_json::json!(["refs/heads/main"]));
        assert_eq!(check_origin(&[(RULESET, Some(&named))], Some("trunk")), []);
    }

    #[test]
    fn reads_every_include_the_ruleset_names() {
        let all = |trigger: &str, contexts: &[&str]| {
            check(&[
                (".github/workflows/docs.yml", Some(&with_docs(trigger))),
                (
                    RULESET,
                    Some(&ruleset_with(contexts, &serde_json::json!(["~ALL"]))),
                ),
            ])
        };
        let mut every: Vec<&str> = vec!["Docs Only"];
        every.extend(PASSING);
        for trigger in ["", "    branches: [\"**\"]\n"] {
            assert_eq!(all(trigger, &every), [], "{trigger}");
        }
        for trigger in [
            "    branches: [main]\n",
            "    branches: [\"**\", \"!main\"]\n",
            "    branches-ignore: [dependabot/**]\n",
        ] {
            let found = all(trigger, &["Docs Only"]);
            assert_eq!(
                codes(&found),
                ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"],
                "{trigger}"
            );
            assert!(found[0].actual.contains("`~ALL`"));
        }
        let feat = |trigger: &str| {
            codes(&check(&[
                (".github/workflows/docs.yml", Some(&with_docs(trigger))),
                (
                    RULESET,
                    Some(&ruleset_with(
                        &["Docs Only"],
                        &serde_json::json!(["refs/heads/feat+x"]),
                    )),
                ),
            ]))
        };
        assert_eq!(feat(""), Vec::<String>::new());
        assert_eq!(feat("    branches: [\"feat*\"]\n"), Vec::<String>::new());
        assert_eq!(
            feat("    branches: [main]\n"),
            ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]
        );
        for include in [
            serde_json::json!(["refs/heads/release/*"]),
            serde_json::json!(["refs/heads/"]),
            serde_json::json!([5]),
            serde_json::json!([]),
        ] {
            assert_eq!(
                codes(&check(&[(
                    RULESET,
                    Some(&ruleset_with(&PASSING, &include))
                )])),
                ["ERR_CHECK_RULESET_BRANCH_UNKNOWN"],
                "{include}"
            );
        }
        let mut bare: serde_json::Value = serde_json::from_str(&ruleset(&PASSING)).expect("json");
        bare.as_object_mut().expect("object").remove("conditions");
        assert_eq!(
            codes(&check(&[(RULESET, Some(&bare.to_string()))])),
            ["ERR_CHECK_RULESET_BRANCH_UNKNOWN"]
        );
        let both = ruleset_with(
            &["Docs Only"],
            &serde_json::json!([
                "~DEFAULT_BRANCH",
                "refs/heads/release",
                "refs/heads/release"
            ]),
        );
        let docs = |branches: &str| {
            format!(
                "on:\n  pull_request:\n    branches: {branches}\njobs:\n  docs:\n    name: Docs Only\n    runs-on: ubuntu-24.04\n"
            )
        };
        assert_eq!(
            check(&[
                (".github/workflows/docs.yml", Some(&docs("[main, release]"))),
                (RULESET, Some(&both))
            ]),
            []
        );
        let found = check(&[
            (".github/workflows/docs.yml", Some(&docs("[main]"))),
            (RULESET, Some(&both)),
        ]);
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
        assert!(found[0].actual.contains("do not match `release`"));
    }

    #[test]
    fn matches_branch_filter_patterns_as_github_does() {
        for (pattern, branch, matches) in [
            ("main", "main", true),
            ("release/**", "release/1/2", true),
            ("release/*", "release/1/2", false),
            ("release/*", "release/1", true),
            ("v?", "v1", true),
            ("v?", "v10", false),
            ("feat+x", "feat+x", true),
            ("a.b", "axb", false),
        ] {
            assert_eq!(
                branch_matches(pattern, branch),
                matches,
                "{pattern} {branch}"
            );
        }
    }

    fn origin_of(root: &Path) -> Option<String> {
        let env = hook_env();
        origin_head(&Input {
            root,
            run: &run_command,
            env: &env,
        })
    }

    fn clone(head: Option<&str>) -> tempfile::TempDir {
        let dir = tree(&[]);
        git(dir.path(), &["init", "--quiet"]);
        if let Some(head) = head {
            git(
                dir.path(),
                &[
                    "symbolic-ref",
                    "refs/remotes/origin/HEAD",
                    &format!("refs/remotes/origin/{head}"),
                ],
            );
        }
        dir
    }

    #[test]
    fn reads_origin_head_only_at_the_top_of_a_work_tree() {
        assert_eq!(
            origin_of(clone(Some("trunk")).path()).as_deref(),
            Some("trunk")
        );
        assert_eq!(origin_of(clone(None).path()), None);
        let dir = clone(Some("trunk"));
        std::fs::create_dir(dir.path().join("sub")).expect("sub");
        assert_eq!(origin_of(&dir.path().join("sub")), None);
        assert_eq!(origin_of(tree(&[]).path()), None);
        let env = Env::new();
        let fails = |_: &str, _: &[&str], _: &RunOptions| RunResult::exited(128, "", "fatal");
        let root = tree(&[]);
        assert_eq!(
            origin_head(&Input {
                root: root.path(),
                run: &fails,
                env: &env
            }),
            None
        );
        let missing = |_: &str, _: &[&str], _: &RunOptions| {
            RunResult::exited(0, "/nonexistent/ruleset-contexts\n", "")
        };
        assert_eq!(
            origin_head(&Input {
                root: root.path(),
                run: &missing,
                env: &env
            }),
            None
        );
        let env = hook_env();
        let found = run(&Input {
            root: clone(Some("trunk")).path(),
            run: &run_command,
            env: &env,
        });
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_BRANCH_MISMATCH"]);
        assert_eq!(
            run(&Input {
                root: clone(Some("main")).path(),
                run: &run_command,
                env: &env
            }),
            []
        );
        assert_eq!(run_at(tree(&[]).path(), run), []);
    }

    #[test]
    fn renders_a_job_name_that_is_not_a_string() {
        let named = |name: &str, contexts: &[&str], matrix: &str| {
            codes(&check(&[
                (
                    ".github/workflows/named.yml",
                    Some(&format!(
                        "on: pull_request\njobs:\n  build:\n    name: {name}\n    runs-on: ubuntu-24.04\n{matrix}"
                    )),
                ),
                (RULESET, Some(&ruleset(contexts))),
            ]))
        };
        assert_eq!(named("123", &["123"], ""), Vec::<String>::new());
        assert_eq!(named("123", &["build"], ""), ["ERR_CHECK_RULESET_CONTEXT"]);
        assert_eq!(named("true", &["true"], ""), Vec::<String>::new());
        assert_eq!(
            named(
                "123",
                &["123 (a)"],
                "    strategy:\n      matrix:\n        os: [a]\n"
            ),
            Vec::<String>::new()
        );
        for (name, why) in [
            ("~", "is null"),
            ("1.5", "the number 1.5"),
            ("[a]", "not a scalar"),
        ] {
            let workflow = format!(
                "on: pull_request\njobs:\n  build:\n    name: {name}\n    runs-on: ubuntu-24.04\n"
            );
            fails_closed(
                &[
                    (".github/workflows/named.yml", Some(&workflow)),
                    (RULESET, Some(&ruleset(&["build"]))),
                ],
                why,
                "quote the job's `name:`",
            );
        }
        assert_eq!(job_name_text("build", None), Ok("build".to_owned()));
        assert_eq!(
            job_name_text("build", Some(&node("Build"))),
            Ok("Build".to_owned())
        );
        assert_eq!(
            job_name_text("build", Some(&node("123"))),
            Ok("123".to_owned())
        );
        assert_eq!(
            job_name_text("build", Some(&node("-7"))),
            Ok("-7".to_owned())
        );
        assert_eq!(
            job_name_text("build", Some(&node("false"))),
            Ok("false".to_owned())
        );
        assert!(job_name_text("build", Some(&node("1152921504606846976"))).is_err());
    }

    fn any_job(name: &str, condition: &str, matrix: bool) -> String {
        let matrix = if matrix {
            "\n    strategy:\n      matrix:\n        os: [ubuntu, macos]"
        } else {
            ""
        };
        format!(
            "on: pull_request\njobs:\n  any:\n    name: {}\n    runs-on: ubuntu-24.04{condition}{matrix}\n",
            serde_json::Value::String(name.to_owned())
        )
    }

    #[test]
    fn evaluates_a_name_that_is_only_an_expression() {
        let renamed = ruleset(&["Totally Renamed Job"]);
        assert_eq!(
            codes(&check(&[
                (
                    ".github/workflows/any.yml",
                    Some(&any_job(
                        "${{ matrix.os }}",
                        "\n    if: github.event_name == 'push'",
                        true
                    ))
                ),
                (RULESET, Some(&renamed))
            ])),
            ["ERR_CHECK_RULESET_CONTEXT"]
        );
        assert_eq!(
            codes(&check(&[
                (
                    ".github/workflows/any.yml",
                    Some(&any_job("${{ matrix.os }} ${{ matrix.arch }}", "", true))
                ),
                (RULESET, Some(&renamed))
            ])),
            ["ERR_CHECK_RULESET_CONTEXT"]
        );
        let name = "${{ github.event_name == 'pull_request' && 'PR Build' || 'Push Build' }}";
        assert_eq!(
            check(&[
                (".github/workflows/any.yml", Some(&any_job(name, "", false))),
                (RULESET, Some(&ruleset(&["PR Build"])))
            ]),
            []
        );
        assert_eq!(
            codes(&check(&[
                (".github/workflows/any.yml", Some(&any_job(name, "", false))),
                (RULESET, Some(&ruleset(&["Push Build"])))
            ])),
            ["ERR_CHECK_RULESET_CONTEXT"]
        );
        for context in ["ubuntu", "macos"] {
            assert_eq!(
                check(&[
                    (
                        ".github/workflows/any.yml",
                        Some(&any_job("${{ matrix.os }}", "", true))
                    ),
                    (RULESET, Some(&ruleset(&[context])))
                ]),
                []
            );
        }
        let computed = "on: pull_request\njobs:\n  any:\n    name: ${{ matrix.os }}\n    strategy:\n      matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}\n";
        fails_closed(
            &[
                (".github/workflows/any.yml", Some(computed)),
                (RULESET, Some(&ruleset(&["ubuntu"]))),
            ],
            "its matrix is computed by an expression",
            "write the job's `strategy.matrix` as literal lists",
        );
        fails_closed(
            &[
                (
                    ".github/workflows/any.yml",
                    Some(&any_job("Build ${{ github.event_name }}", "", true)),
                ),
                (RULESET, Some(&ruleset(&["Build pull_request"]))),
            ],
            "none reads `matrix`",
            "read the matrix in the name",
        );
    }

    fn lint_job(name: &str, matrix: &str) -> String {
        format!(
            "on: pull_request\njobs:\n  any:\n    name: {}\n    runs-on: ubuntu-24.04\n    strategy:\n      matrix:\n{matrix}",
            serde_json::Value::String(name.to_owned())
        )
    }

    #[test]
    fn evaluates_a_name_mixing_text_and_an_expression() {
        let found = check(&[(RULESET, Some(&ruleset(&["Analyze (python)"])))]);
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_CONTEXT"]);
        assert!(
            found[0]
                .actual
                .contains("Analyze (rust), Analyze (actions)")
        );
        assert_eq!(
            check(&[(
                RULESET,
                Some(&ruleset(&["Analyze (rust)", "Analyze (actions)"]))
            )]),
            []
        );
        let workflow = lint_job("Lint (${{ matrix.arch }})", "        os: [ubuntu]\n");
        assert_eq!(
            check(&[
                (".github/workflows/any.yml", Some(&workflow)),
                (RULESET, Some(&ruleset(&["Lint ()"])))
            ]),
            []
        );
        let found = check(&[
            (".github/workflows/any.yml", Some(&workflow)),
            (RULESET, Some(&ruleset(&["Lint (ubuntu)"]))),
        ]);
        assert!(found[0].actual.contains("Lint ()"));
        for (name, matrix, why, next) in [
            (
                "Lint (${{ github.head_ref }})",
                "        os: [ubuntu]\n",
                "reads `github.head_ref`, which is not fixed on a pull request",
                "build the job's `name:` only from text",
            ),
            (
                "Lint (${{ format('{0}', matrix.os) }})",
                "        os: [ubuntu]\n",
                "this check cannot evaluate",
                "build the job's `name:` only from text",
            ),
            (
                "Lint (${{ matrix.target }})",
                "        target: [{ os: ubuntu }]\n",
                "has no text this check can know",
                "build the job's `name:` only from text",
            ),
            (
                "Lint (${{ matrix.os }})",
                "        os: ${{ fromJSON(needs.plan.outputs.os) }}\n",
                "computed by an expression",
                "write the job's `strategy.matrix` as literal lists",
            ),
            (
                "Lint (${{ matrix.os }})",
                "        include: ${{ fromJSON(needs.plan.outputs.include) }}\n",
                "computed by an expression",
                "write the job's `strategy.matrix` as literal lists",
            ),
        ] {
            let overrides = [
                (".github/workflows/any.yml", Some(lint_job(name, matrix))),
                (RULESET, Some(ruleset(&["Lint (ubuntu)"]))),
            ];
            let overrides: Vec<(&str, Option<&str>)> = overrides
                .iter()
                .map(|(path, text)| (*path, text.as_deref()))
                .collect();
            fails_closed(
                &overrides,
                &format!("`{name}` ("),
                &format!("for `{name}`, {next}"),
            );
            assert!(check(&overrides)[0].actual.contains(why), "{name}");
        }
        let matrix = "        os: [ubuntu, macos]\n        rust: [stable, beta]\n        exclude:\n          - os: macos\n            rust: beta\n        include:\n          - os: windows\n            rust: stable\n";
        let workflow = lint_job("Test ${{ matrix.os }}-${{ matrix.rust }}", matrix);
        for context in [
            "Test ubuntu-beta",
            "Test macos-stable",
            "Test windows-stable",
        ] {
            assert_eq!(
                check(&[
                    (".github/workflows/any.yml", Some(&workflow)),
                    (RULESET, Some(&ruleset(&[context])))
                ]),
                [],
                "{context}"
            );
        }
        assert_eq!(
            codes(&check(&[
                (".github/workflows/any.yml", Some(&workflow)),
                (RULESET, Some(&ruleset(&["Test macos-beta"])))
            ])),
            ["ERR_CHECK_RULESET_CONTEXT"]
        );
    }

    const REUSABLE: &str = "on:\n  workflow_call:\njobs:\n  checks:\n    name: Checks\n    runs-on: ubuntu-24.04\n  matrix:\n    runs-on: ubuntu-24.04\n    strategy:\n      matrix:\n        os: [ubuntu, macos]\n  gated:\n    name: Gated\n    if: github.event_name == 'push'\n    runs-on: ubuntu-24.04\n";

    fn caller(job: &str) -> String {
        format!("on: pull_request\njobs:\n  call:\n{job}")
    }

    fn with_caller(job: &str, contexts: &[&str], extra: &[(&str, &str)]) -> Vec<String> {
        let caller = caller(job);
        let ruleset = ruleset(contexts);
        let mut overrides: Vec<(&str, Option<&str>)> = vec![
            (".github/workflows/caller.yml", Some(&caller)),
            (".github/workflows/reusable.yml", Some(REUSABLE)),
            (RULESET, Some(&ruleset)),
        ];
        overrides.extend(extra.iter().map(|(path, text)| (*path, Some(*text))));
        codes(&check(&overrides))
    }

    #[test]
    fn names_a_called_job_after_its_caller() {
        let named = "    name: Reusable\n    uses: ./.github/workflows/reusable.yml\n";
        assert_eq!(
            with_caller(
                named,
                &["Reusable / Checks", "Reusable / matrix (macos)"],
                &[]
            ),
            Vec::<String>::new()
        );
        assert_eq!(
            with_caller(
                "    uses: ./.github/workflows/reusable.yml\n",
                &["call / Checks"],
                &[]
            ),
            Vec::<String>::new()
        );
        let matrix = "    name: Reusable (${{ matrix.target }})\n    strategy:\n      matrix:\n        target: [app, cli]\n    uses: ./.github/workflows/reusable.yml\n";
        assert_eq!(
            with_caller(matrix, &["Reusable (cli) / Checks"], &[]),
            Vec::<String>::new()
        );
        assert_eq!(
            with_caller(matrix, &["Reusable (web) / Checks"], &[]),
            ["ERR_CHECK_RULESET_CONTEXT"]
        );
        let middle = "on: workflow_call\njobs:\n  inner:\n    name: Inner\n    uses: ./.github/workflows/reusable.yml\n";
        assert_eq!(
            with_caller(
                "    name: Outer\n    uses: ./.github/workflows/middle.yml\n",
                &["Outer / Inner / Checks"],
                &[(".github/workflows/middle.yml", middle)]
            ),
            Vec::<String>::new()
        );
        for context in ["Reusable", "Checks"] {
            assert_eq!(
                with_caller(named, &[context], &[]),
                ["ERR_CHECK_RULESET_CONTEXT"],
                "{context}"
            );
        }
        let failing = |job: &str, context: &str| {
            let caller = caller(job);
            let ruleset = ruleset(&[context]);
            check(&[
                (".github/workflows/caller.yml", Some(&caller)),
                (".github/workflows/reusable.yml", Some(REUSABLE)),
                (RULESET, Some(&ruleset)),
            ])
        };
        let found = failing(named, "Reusable / Gated");
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
        assert!(found[0].actual.contains("reusable.yml: job `gated`"));
        assert!(found[0].expected.contains("the calling job"));
        let found = failing(
            "    name: Reusable\n    if: github.event_name == 'push'\n    uses: ./.github/workflows/reusable.yml\n",
            "Reusable / Checks",
        );
        assert_eq!(codes(&found), ["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
        assert!(found[0].actual.contains("caller.yml: job `call`"));
    }

    fn chain(called: usize) -> (Vec<(String, String)>, String) {
        let mut files = vec![(
            ".github/workflows/caller.yml".to_owned(),
            caller("    uses: ./.github/workflows/level1.yml\n"),
        )];
        for level in 1..=called {
            let text = if level < called {
                format!(
                    "on: workflow_call\njobs:\n  hop:\n    uses: ./.github/workflows/level{}.yml\n",
                    level + 1
                )
            } else {
                "on: workflow_call\njobs:\n  leaf:\n    name: Leaf\n    runs-on: ubuntu-24.04\n"
                    .to_owned()
            };
            files.push((format!(".github/workflows/level{level}.yml"), text));
        }
        let mut parts = vec!["call".to_owned()];
        parts.extend(std::iter::repeat_n("hop".to_owned(), called - 1));
        parts.push("Leaf".to_owned());
        (files, parts.join(" / "))
    }

    #[test]
    fn follows_called_workflows_and_fails_closed_on_ones_it_cannot_read() {
        let (ten, deepest) = chain(9);
        let ruleset_ten = ruleset(&[&deepest]);
        let mut overrides: Vec<(&str, Option<&str>)> = ten
            .iter()
            .map(|(path, text)| (path.as_str(), Some(text.as_str())))
            .collect();
        overrides.push((RULESET, Some(&ruleset_ten)));
        assert_eq!(check(&overrides), []);
        let (eleven, past) = chain(10);
        let ruleset_eleven = ruleset(&[&past]);
        let mut overrides: Vec<(&str, Option<&str>)> = eleven
            .iter()
            .map(|(path, text)| (path.as_str(), Some(text.as_str())))
            .collect();
        overrides.push((RULESET, Some(&ruleset_eleven)));
        fails_closed(
            &overrides,
            "below 10 levels of workflows, past GitHub's limit of 10",
            "flatten the chain of reusable-workflow calls to at most 10 levels",
        );
        for (uses, extra, why, next) in [
            (
                "octo/ci/.github/workflows/x.yml@v1",
                vec![],
                "a workflow in another repository",
                "copy the called workflow into .github/workflows/",
            ),
            (
                "./.github/workflows/nowhere.yml",
                vec![],
                "does not exist or does not parse",
                "restore .github/workflows/nowhere.yml",
            ),
            (
                "./reusable.yml",
                vec![("reusable.yml", REUSABLE)],
                "not the documented",
                "with no `..` or subdirectory",
            ),
            (
                "./.github/workflows/../workflows/reusable.yml",
                vec![],
                "not the documented",
                "with no `..` or subdirectory",
            ),
            (
                "./.github/workflows/sub/reusable.yml",
                vec![(".github/workflows/sub/reusable.yml", REUSABLE)],
                "not the documented",
                "with no `..` or subdirectory",
            ),
            (
                "./.github/workflows/push.yml",
                vec![],
                "does not name `workflow_call`",
                "add `workflow_call` to the `on:` of .github/workflows/push.yml",
            ),
            (
                "./.github/workflows/loop.yml",
                vec![(
                    ".github/workflows/loop.yml",
                    "on: workflow_call\njobs:\n  again:\n    uses: ./.github/workflows/loop.yml\n",
                )],
                "through a cycle",
                "break the cycle",
            ),
        ] {
            let caller = caller(&format!("    name: Reusable\n    uses: {uses}\n"));
            let ruleset = ruleset(&["Reusable / Checks"]);
            let mut overrides: Vec<(&str, Option<&str>)> = vec![
                (".github/workflows/caller.yml", Some(&caller)),
                (".github/workflows/reusable.yml", Some(REUSABLE)),
                (RULESET, Some(&ruleset)),
            ];
            overrides.extend(extra.iter().map(|(path, text)| (*path, Some(*text))));
            fails_closed(&overrides, why, next);
        }
        let not_string = caller("    uses: [1]\n");
        fails_closed(
            &[
                (".github/workflows/caller.yml", Some(&not_string)),
                (RULESET, Some(&ruleset(&["call / Checks"]))),
            ],
            "`call` (its `uses:` is not a string)",
            "write the job's `uses:` as `./.github/workflows/<file>.yml`",
        );
        let strategy = caller(
            "    name: Reusable\n    strategy: [1]\n    uses: ./.github/workflows/reusable.yml\n",
        );
        fails_closed(
            &[
                (".github/workflows/caller.yml", Some(&strategy)),
                (".github/workflows/reusable.yml", Some(REUSABLE)),
                (RULESET, Some(&ruleset(&["Reusable / Checks"]))),
            ],
            "its `strategy` is not a mapping",
            "write the job's `strategy:` as a mapping",
        );
    }

    #[test]
    fn reports_the_names_a_job_has() {
        assert_eq!(names("Build", None), Ok(vec!["Build".to_owned()]));
        assert_eq!(names("${{ 'Build' }}", None), Ok(vec!["Build".to_owned()]));
        assert_eq!(names("a${{ null }}b", None), Ok(vec!["ab".to_owned()]));
        assert!(
            reason(names("${{ matrix.os }}", None))
                .contains("reads `matrix.os`, which is not fixed")
        );
        assert_eq!(
            names("Test", Some("os: [ubuntu, macos]\nn: [1]\n")),
            Ok(vec![
                "Test (ubuntu, 1)".to_owned(),
                "Test (macos, 1)".to_owned()
            ])
        );
        assert_eq!(
            names("Test", Some("include: [{ os: a, flag: true }]\n")),
            Ok(vec!["Test (a, true)".to_owned()])
        );
        for matrix in ["include: [{ os: a, none: null }]\n", "os: [{ name: a }]\n"] {
            assert!(
                reason(names("Test", Some(matrix))).contains("null, a mapping, or a list"),
                "{matrix}"
            );
        }
        assert_eq!(
            names(
                "T",
                Some("os: [a]\ninclude: [{ os: a, zeta: '1', beta: '2' }]\n")
            ),
            Ok(vec!["T (a, 1, 2)".to_owned()])
        );
        assert_eq!(
            names(
                "T",
                Some("os: [a, b]\ninclude: [{ color: green }, { os: b, color: pink, size: L }]\n")
            ),
            Ok(vec!["T (a, green)".to_owned(), "T (b, pink, L)".to_owned()])
        );
        assert_eq!(
            names(
                "T ${{ matrix.os }}-${{ matrix.rust }}",
                Some("os: [a, b]\nrust: [x, y]\nexclude: [{ os: b }]\n")
            ),
            Ok(vec!["T a-x".to_owned(), "T a-y".to_owned()])
        );
        assert_eq!(
            names("T ${{ Matrix.Target.OS }}", Some("target: [{ Os: mac }]\n")),
            Ok(vec!["T mac".to_owned()])
        );
        assert_eq!(
            names(
                "T ${{ matrix.arch }}${{ matrix.os.name }}",
                Some("os: [u]\n")
            ),
            Ok(vec!["T ".to_owned()])
        );
        assert!(
            reason(names(
                "T ${{ matrix.target }}",
                Some("target: [{ os: mac }]\n")
            ))
            .contains("has no text this check can know")
        );
        assert!(
            reason(names("T ${{ matrix.os.* }}", Some("os: [{ a: b }]\n")))
                .contains("has no text this check can know")
        );
        assert!(
            reason(names(
                "${{ github.event_name == 'pull_request' && 'PR' || 'Push' }}",
                Some("os: [a]\n")
            ))
            .contains("none reads `matrix`")
        );
        assert_eq!(
            names(
                "${{ github.event_name == 'pull_request' && matrix.os || 'Push' }}",
                Some("os: [a, b]\n")
            ),
            Ok(vec!["a".to_owned(), "b".to_owned()])
        );
        assert_eq!(
            names("Lint ${{ matrix.os }}", Some("os: [a, a]\n")),
            Ok(vec!["Lint a".to_owned()])
        );
    }

    #[test]
    fn caps_a_matrix_at_github_s_limit() {
        let values = |count: usize| {
            (0..count)
                .map(|index| format!("v{index}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let square = |a: usize, b: usize| format!("a: [{}]\nb: [{}]\n", values(a), values(b));
        assert_eq!(
            names("T", Some(&square(16, 16))).map(|names| names.len()),
            Ok(256)
        );
        assert!(reason(names("T", Some(&square(16, 17)))).contains("more than 256 combinations"));
        assert!(
            reason(names("T", Some(&square(300, 300))))
                .contains("more than 65536 combinations before `exclude`")
        );
    }

    fn shape(matrix: Option<&str>) -> Result<Vec<String>, String> {
        let matrix = matrix.map(node);
        matrix_combinations(matrix.as_ref())
            .map(|combinations| {
                combinations
                    .iter()
                    .map(|combination| {
                        combination
                            .iter()
                            .map(|(key, value)| {
                                format!("{key}={}", value.scalar_text().unwrap_or_default())
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .collect()
            })
            .map_err(|why| why.reason)
    }

    #[test]
    fn expands_a_matrix_as_github_does() {
        let documented = "fruit: [apple, pear]\nanimal: [cat, dog]\ninclude:\n  - color: green\n  - color: pink\n    animal: cat\n  - fruit: apple\n    shape: circle\n  - fruit: banana\n  - fruit: banana\n    animal: cat\n";
        assert_eq!(
            shape(Some(documented)),
            Ok(vec![
                "fruit=apple animal=cat color=pink shape=circle".to_owned(),
                "fruit=apple animal=dog color=green shape=circle".to_owned(),
                "fruit=pear animal=cat color=pink".to_owned(),
                "fruit=pear animal=dog color=green".to_owned(),
                "fruit=banana".to_owned(),
                "fruit=banana animal=cat".to_owned(),
            ])
        );
        for (matrix, why) in [
            (Some("${{ fromJSON(needs.a.outputs.m) }}"), "computed"),
            (Some("[a]"), "not a mapping"),
            (Some("os: []\n"), "not a non-empty list"),
            (Some("os: ubuntu\n"), "not a non-empty list"),
            (Some("os: [a]\ninclude: [b]\n"), "`include`"),
            (Some("os: [a]\nexclude: { os: a }\n"), "`exclude`"),
            (Some("os: [a]\nexclude: [{ os: a }]\n"), "no combinations"),
            (Some("{}"), "no combinations"),
            (None, "not a mapping"),
            (Some("'1': [a]\n"), "made only of digits"),
            (Some("include: [{ '2': a }]\n"), "made only of digits"),
        ] {
            assert!(
                shape(matrix).is_err_and(|reason| reason.contains(why)),
                "{matrix:?}"
            );
        }
    }
}
