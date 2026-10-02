//! The gates `just check` runs and the steps CI runs stay the same set, apart from a
//! reasoned exception list ([`EXCEPTIONS`]), so a gate added to one side cannot pass
//! locally and fail in CI, or the reverse. ci.yml is read with the YAML parser, the
//! justfile (not YAML or TOML) line by line.
//!
//! Files (both required): `justfile` and `.github/workflows/ci.yml`. CI means ci.yml
//! alone, the workflow whose jobs are the merge gate; the security and PR workflows check
//! things no local recipe could.
//! - `just check`'s gates: every recipe reachable from `check` through dependencies
//!   (`a: b (c "x") && d`) and `just <recipe>` lines in a body.
//! - a recipe's commands: its body lines, `\` continuations joined, comment and shebang
//!   lines dropped, a leading `@`/`-` removed, whitespace collapsed.
//! - CI's steps: every `run:` in ci.yml's jobs (a job named in the exceptions'
//!   `ci_only_jobs` aside), split into command lines the same way. A step that also names
//!   `uses:` runs nothing of its own.
//! - what CI runs unconditionally: a command line counts as running a gate only in a step
//!   that runs on every CI run and whose failure fails the run — no `if:` on the step or
//!   its job, no `continue-on-error` other than `false` on either — and only when the line
//!   neither has an `||` fallback nor is a condition (`if`, `elif`, `while`, `until`, or
//!   `!` in front). Anything else may never run the gate, or run it without failing, so it
//!   counts as not running it.
//!
//! Both directions:
//! - every gate is run by CI unconditionally: some step says `just <gate>` (or `just` a
//!   recipe that reaches it), or every command in its body is a CI command line verbatim
//!   (so `lint`'s lines, split across CI's jobs, count), or its body is empty (its
//!   dependencies are gates themselves), or it is in `local_only`;
//! - every CI step is a gate: a step that calls `just` calls only gates (or
//!   `ci_only_recipes`; its other lines are glue, such as a diff of what it wrote), and
//!   each line of a step that calls no recipe is a gate's command verbatim or in
//!   `ci_only_commands`.
//!
//! An exception that no longer applies (a `local_only` recipe `just check` stopped running
//! or CI now runs; a CI-only recipe or command CI stopped running or a gate now runs) is
//! reported as stale, so the list cannot outlive its reasons. `ci_only_jobs` is not: the
//! bootstrap removes that job from an app cut from the template.
//!
//! Errors: `ERR_CHECK_JUST_CI_INPUT` (the justfile or ci.yml is missing, or ci.yml has no
//! jobs mapping), `ERR_CHECK_JUST_CI_NO_CHECK` (the justfile defines no `check` recipe),
//! `ERR_CHECK_JUST_CI_DIVERGED` (a gate runs on one side only, or in CI only
//! conditionally, and is not an exception), `ERR_CHECK_JUST_CI_STALE` (an exception no
//! longer applies).

use std::collections::{HashSet, VecDeque};

use regex::Regex;

use super::workflows::{continues_on_error, jobs_of, read_yaml, script_lines, steps_of};
use super::yaml::{Key, Node};
use super::{Input, finding, pattern, read_file};
use crate::fail::FailureDetails;

const JUSTFILE: &str = "justfile";
const CI: &str = ".github/workflows/ci.yml";
const THIS: &str = "xtask/src/check_harness/just_check_matches_ci.rs";

/// The differences between `just check` and CI that are deliberate, each with its reason.
pub(super) struct Exceptions {
    /// `just check` gates CI deliberately does not run.
    local_only: &'static [(&'static str, &'static str)],
    /// Recipes CI runs (`just <recipe>`) that `just check` deliberately leaves out.
    ci_only_recipes: &'static [(&'static str, &'static str)],
    /// Command lines (whitespace collapsed) CI runs that no gate's recipe runs.
    ci_only_commands: &'static [(&'static str, &'static str)],
    /// Whole ci.yml jobs, by `name:` or id, outside the comparison.
    ci_only_jobs: &'static [(&'static str, &'static str)],
}

fn listed(entries: &[(&str, &str)], name: &str) -> bool {
    entries.iter().any(|(entry, _)| *entry == name)
}

/// The exception list, one reason per entry. Adding an entry is weakening a gate
/// (AGENTS.md › Security and human approval): it needs the same review.
const EXCEPTIONS: Exceptions = Exceptions {
    local_only: &[
        (
            "verify-hooks",
            "asserts lefthook's pre-commit hook is installed in this checkout; a CI checkout has none and nobody commits there (`cargo xtask verify-hooks` skips when CI is set)",
        ),
        (
            "fmt",
            "rewrites files; CI checks the same formatting read-only through `just lint`'s `cargo fmt --all --check` and `pnpm format:check` lines, which this check matches verbatim",
        ),
    ],
    ci_only_recipes: &[],
    ci_only_commands: &[
        (
            "echo \"path=$(pnpm store path)\" >> \"$GITHUB_OUTPUT\"",
            "hands the pnpm store path to actions/cache: CI plumbing with no local meaning",
        ),
        (
            "pnpm install --frozen-lockfile",
            "dependency install: `just install` runs it once on a developer's Mac, not on every `just check`",
        ),
        (
            "cargo deny --locked check",
            "`just deny`: fetches the RustSec advisory database over the network, so it stays out of the offline local gate; AGENTS.md › Validating a change runs it when a manifest or lockfile changes",
        ),
        (
            "cargo shear --locked",
            "unused-dependency detection; AGENTS.md › Validating a change runs `mise exec -- cargo shear` when a manifest changes, and CI on every change",
        ),
        (
            "cargo fetch --locked",
            "fills the Linux harness job's registry so `cargo metadata --offline` (the core-boundary check) can resolve; a developer's Mac already holds the crates after any build",
        ),
        (
            "zizmor --format github .",
            "workflow security audit in GitHub's annotation format, with a read-only token for its online audits; AGENTS.md › Validating a change runs `mise exec -- zizmor` locally when a workflow changes",
        ),
    ],
    ci_only_jobs: &[(
        "Template Bootstrap Smoke",
        "template-only (the bootstrap removes the job and the `verify-bootstrap` recipe): it runs `cargo xtask verify-bootstrap`, which fails when this tree holds a placeholder spelling, template-only text, or a dangling reference the bootstrap would leave behind, then bootstraps a throwaway copy and runs `just check` there. `just check` leaves it out because it clones the tree, needs cargo's registry, and would run a second `just check`; `just verify-bootstrap` runs the verification locally, and AGENTS.md › Validating a change says when",
    )],
};

/// One justfile recipe.
#[derive(Debug, PartialEq, Eq)]
struct Recipe {
    deps: Vec<String>,
    /// Body command lines, normalized (see the module docs).
    commands: Vec<String>,
    /// Recipes a body line runs with `just <recipe>`.
    calls: Vec<String>,
}

/// Text with runs of whitespace collapsed to one space, trimmed.
fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_recipe_name(word: &str) -> bool {
    let mut chars = word.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The recipes a command runs through `just <recipe>` (flags skipped).
fn just_calls(command: &str) -> Vec<String> {
    let words: Vec<&str> = command
        .split(|c: char| c.is_whitespace() || ";&|()".contains(c))
        .collect();
    let mut calls = Vec::new();
    for (index, word) in words.iter().enumerate() {
        if *word != "just" {
            continue;
        }
        let mut next = index + 1;
        while words.get(next).is_some_and(|word| word.starts_with('-')) {
            next += 1;
        }
        if let Some(recipe) = words.get(next).filter(|recipe| is_recipe_name(recipe)) {
            calls.push((*recipe).to_owned());
        }
    }
    calls
}

fn commands_of(lines: &[&str]) -> Vec<String> {
    script_lines(&lines.join("\n"))
        .into_iter()
        .map(|(_, text)| normalize(text.trim_start_matches(['@', '-'])))
        .filter(|text| !text.is_empty())
        .collect()
}

/// The justfile's recipes by name, in file order (a redefinition keeps the first place).
fn parse_justfile(text: &str) -> Result<Vec<(String, Recipe)>, FailureDetails> {
    let header = pattern(r"^@?([A-Za-z_][A-Za-z0-9_-]*)(?:\s[^:]*)?:(.*)$")?;
    let not_recipe = pattern(r"^(?:set|export|alias|import|mod)\s")?;
    let dep = pattern(r"\(\s*([A-Za-z_][A-Za-z0-9_-]*)[^)]*\)|([A-Za-z_][A-Za-z0-9_-]*)")?;
    let comment = pattern(r"\s+#.*$")?;
    let mut recipes: Vec<(String, Recipe)> = Vec::new();
    let mut pending: Option<(String, Vec<String>, Vec<&str>)> = None;
    let flush = |pending: Option<(String, Vec<String>, Vec<&str>)>,
                 recipes: &mut Vec<(String, Recipe)>| {
        let Some((name, deps, body)) = pending else {
            return;
        };
        let commands = commands_of(&body);
        let calls = commands
            .iter()
            .flat_map(|command| just_calls(command))
            .collect();
        let recipe = Recipe {
            deps,
            commands,
            calls,
        };
        match recipes.iter_mut().find(|(existing, _)| *existing == name) {
            Some(slot) => slot.1 = recipe,
            None => recipes.push((name, recipe)),
        }
    };
    for line in text.split('\n') {
        if line.trim().is_empty() || line.starts_with(char::is_whitespace) {
            if let Some((_, _, body)) = pending.as_mut()
                && !line.trim().is_empty()
            {
                body.push(line);
            }
            continue;
        }
        flush(pending.take(), &mut recipes);
        if line.starts_with('#') || line.starts_with('[') || not_recipe.is_match(line) {
            continue;
        }
        let Some(captures) = header.captures(line) else {
            continue;
        };
        let rest = captures.get(2).map_or("", |rest| rest.as_str());
        if rest.starts_with('=') {
            continue;
        }
        let rest = comment.replace(rest, "");
        let deps = dep
            .captures_iter(&rest)
            .filter_map(|found| {
                found
                    .get(1)
                    .or_else(|| found.get(2))
                    .map(|name| name.as_str().to_owned())
            })
            .collect();
        pending = Some((captures[1].to_owned(), deps, Vec::new()));
    }
    flush(pending, &mut recipes);
    Ok(recipes)
}

fn recipe<'a>(recipes: &'a [(String, Recipe)], name: &str) -> Option<&'a Recipe> {
    recipes
        .iter()
        .find(|(existing, _)| existing == name)
        .map(|(_, recipe)| recipe)
}

/// Every recipe reachable from `starts` through dependencies and `just` calls, in the
/// order reached.
fn closure(recipes: &[(String, Recipe)], starts: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut queue: VecDeque<String> = starts.iter().cloned().collect();
    while let Some(name) = queue.pop_front() {
        if seen.contains(&name) {
            continue;
        }
        if let Some(found) = recipe(recipes, &name) {
            queue.extend(found.deps.iter().cloned());
            queue.extend(found.calls.iter().cloned());
        }
        seen.push(name);
    }
    seen
}

struct CiStep {
    place: String,
    job: String,
    lines: Vec<String>,
    calls: Vec<String>,
    /// The lines that run whenever CI runs and fail it when they fail.
    counted: Vec<String>,
    /// Each other line, with why it does not count as running what it calls.
    uncounted: Vec<(String, &'static str)>,
}

/// Why a whole step never counts as running a gate, or `None` when it can.
fn step_condition(job: &Node, step: &Node) -> Option<&'static str> {
    if job.has("if") {
        Some("behind its job's `if:`")
    } else if continues_on_error(job.get("continue-on-error")) {
        Some("in a job with `continue-on-error`")
    } else if step.has("if") {
        Some("behind the step's `if:`")
    } else if continues_on_error(step.get("continue-on-error")) {
        Some("with `continue-on-error`")
    } else {
        None
    }
}

/// Why one command line does not count as running what it calls, or `None`.
fn line_condition(line: &str, single_quoted: &Regex) -> Option<&'static str> {
    if single_quoted.replace_all(line, "''").contains("||") {
        return Some("with an `||` fallback");
    }
    let condition = ["if", "elif", "while", "until", "!"].iter().any(|word| {
        line.strip_prefix(word)
            .is_some_and(|rest| rest.starts_with(char::is_whitespace))
    });
    condition.then_some("as a condition")
}

fn input_failure(actual: impl Into<String>) -> Vec<FailureDetails> {
    vec![finding(
        "ERR_CHECK_JUST_CI_INPUT",
        "the justfile or ci.yml cannot be read",
        format!("{JUSTFILE} and {CI} (with a `jobs` mapping) under the root"),
        actual,
        "restore the file from version control",
    )]
}

fn read_ci_steps(
    input: &Input<'_>,
    exceptions: &Exceptions,
) -> Result<Vec<CiStep>, Vec<FailureDetails>> {
    let file = match read_yaml(input.root, CI) {
        None => return Err(input_failure(format!("{CI}: no file"))),
        Some(Err(problem)) => return Err(input_failure(problem)),
        Some(Ok(file)) => file,
    };
    if !file.root.get("jobs").is_some_and(Node::is_map) {
        return Err(input_failure(format!("{CI}: no `jobs` mapping")));
    }
    let single_quoted = pattern(r"'[^']*'").map_err(|invalid| vec![invalid])?;
    let mut steps = Vec::new();
    for (id, job) in jobs_of(&file) {
        let name = job.get("name").and_then(Node::as_str).unwrap_or(&id);
        if listed(exceptions.ci_only_jobs, name) || listed(exceptions.ci_only_jobs, &id) {
            continue;
        }
        for (index, step) in steps_of(job) {
            let Some(run) = step.get("run").and_then(Node::as_str) else {
                continue;
            };
            if step.has("uses") {
                continue;
            }
            let line = file.line(&[
                Key::Name("jobs"),
                Key::Name(&id),
                Key::Name("steps"),
                Key::Index(index),
                Key::Name("run"),
            ]);
            let lines: Vec<String> = script_lines(run)
                .into_iter()
                .map(|(_, text)| normalize(&text))
                .collect();
            let condition = step_condition(job, step);
            let mut counted = Vec::new();
            let mut uncounted = Vec::new();
            for text in &lines {
                match condition.or_else(|| line_condition(text, &single_quoted)) {
                    None => counted.push(text.clone()),
                    Some(why) => uncounted.push((text.clone(), why)),
                }
            }
            steps.push(CiStep {
                place: format!("{CI}:{line}"),
                job: id.clone(),
                calls: lines.iter().flat_map(|line| just_calls(line)).collect(),
                lines,
                counted,
                uncounted,
            });
        }
    }
    Ok(steps)
}

fn diverged(summary: String, actual: String) -> FailureDetails {
    finding(
        "ERR_CHECK_JUST_CI_DIVERGED",
        summary,
        format!(
            "every `just check` gate run by a {CI} step (as `just <recipe>`, or its recipe's lines verbatim), and every CI step to run only `just check` gates, apart from the exceptions in {THIS}"
        ),
        actual,
        format!(
            "add the gate to the side that lacks it (a CI step running `just <recipe>`, or the recipe joining `check:`), or, if it belongs on one side only, add it with its reason to EXCEPTIONS in {THIS}"
        ),
    )
}

fn stale(entry: &str, why: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_JUST_CI_STALE",
        format!("EXCEPTIONS lists {entry}, but {why}"),
        "every exception in EXCEPTIONS to describe a difference that still exists",
        why,
        format!("remove the stale entry and its reason from EXCEPTIONS in {THIS}"),
    )
}

/// The check against an explicit exception list (the tests pass their own).
fn compare(input: &Input<'_>, exceptions: &Exceptions) -> Vec<FailureDetails> {
    let Some(text) = read_file(input.root, JUSTFILE) else {
        return input_failure(format!("{JUSTFILE}: no file"));
    };
    let ci_steps = match read_ci_steps(input, exceptions) {
        Ok(steps) => steps,
        Err(failure) => return failure,
    };
    let recipes = match parse_justfile(&text) {
        Ok(recipes) => recipes,
        Err(invalid) => return vec![invalid],
    };
    if recipe(&recipes, "check").is_none() {
        return vec![no_check_recipe(&recipes)];
    }

    let gates = closure(&recipes, &["check".to_owned()]);
    let commands_of_recipe =
        |name: &str| recipe(&recipes, name).map_or(&[][..], |found| found.commands.as_slice());
    let gate_commands: HashSet<&str> = gates
        .iter()
        .flat_map(|gate| commands_of_recipe(gate))
        .map(String::as_str)
        .collect();
    // Every line CI runs, for the stray and stale checks; only the counted ones run a gate.
    let ci_commands = every(&ci_steps, |step| &step.lines);
    let ci_calls = every(&ci_steps, |step| &step.calls);
    let counted_commands = every(&ci_steps, |step| &step.counted);
    let counted_calls: Vec<String> = ci_steps
        .iter()
        .flat_map(|step| &step.counted)
        .flat_map(|line| just_calls(line))
        .collect();
    let counted_reach = closure(&recipes, &counted_calls);
    let unrun = |gate: &str| -> Option<Vec<String>> {
        if counted_reach.iter().any(|reached| reached == gate) {
            return None;
        }
        let missing: Vec<String> = commands_of_recipe(gate)
            .iter()
            .filter(|line| !counted_commands.contains(line.as_str()))
            .cloned()
            .collect();
        (!missing.is_empty()).then_some(missing)
    };
    // Where CI runs a gate only conditionally, for the message.
    let conditionally = |gate: &str| -> Vec<String> {
        let commands = commands_of_recipe(gate);
        ci_steps
            .iter()
            .flat_map(|step| {
                step.uncounted
                    .iter()
                    .filter(|(line, _)| {
                        commands.contains(line)
                            || closure(&recipes, &just_calls(line))
                                .iter()
                                .any(|reached| reached == gate)
                    })
                    .map(|(line, why)| format!("`{line}` at {}, {why}", step.place))
            })
            .collect()
    };

    let mut found = Vec::new();
    for gate in &gates {
        if gate == "check" || listed(exceptions.local_only, gate) {
            continue;
        }
        let Some(missing) = unrun(gate) else {
            continue;
        };
        let partial = conditionally(gate);
        let summary = if partial.is_empty() {
            format!("{JUSTFILE}: `just check` runs `just {gate}`, but no {CI} step runs it")
        } else {
            format!(
                "{JUSTFILE}: `just check` runs `just {gate}`, but {CI} runs it only conditionally, so a failure can pass CI"
            )
        };
        let mut actual = format!(
            "CI runs neither `just {gate}` nor these lines of its recipe on every run, failing on failure: {}",
            missing.join("; ")
        );
        if !partial.is_empty() {
            actual = format!("{actual}; it runs only as {}", partial.join("; "));
        }
        found.push(diverged(summary, actual));
    }
    found.extend(strays(&ci_steps, &gates, &gate_commands, exceptions));
    let unrun: &dyn Fn(&str) -> Option<Vec<String>> = &unrun;
    let ran = Ran {
        gates: &gates,
        unrun,
        ci_calls: &ci_calls,
        ci_commands: &ci_commands,
        gate_commands: &gate_commands,
    };
    found.extend(stale_exceptions(&ran, exceptions));
    found
}

/// One list of every CI step, as a set.
fn every(ci_steps: &[CiStep], list: fn(&CiStep) -> &Vec<String>) -> HashSet<&str> {
    ci_steps.iter().flat_map(list).map(String::as_str).collect()
}

fn no_check_recipe(recipes: &[(String, Recipe)]) -> FailureDetails {
    let names: Vec<&str> = recipes.iter().map(|(name, _)| name.as_str()).collect();
    finding(
        "ERR_CHECK_JUST_CI_NO_CHECK",
        format!("{JUSTFILE} defines no `check` recipe"),
        format!("a `check: <recipe> …` recipe in {JUSTFILE}"),
        format!(
            "recipes: {}",
            if names.is_empty() {
                "none".to_owned()
            } else {
                names.join(", ")
            }
        ),
        format!("restore the `check` recipe, or update {THIS} in the same change"),
    )
}

/// CI steps that run a line or recipe `just check` does not.
fn strays(
    ci_steps: &[CiStep],
    gates: &[String],
    gate_commands: &HashSet<&str>,
    exceptions: &Exceptions,
) -> Vec<FailureDetails> {
    let mut found = Vec::new();
    for step in ci_steps {
        let strays: Vec<String> = if step.calls.is_empty() {
            step.lines
                .iter()
                .filter(|line| {
                    !gate_commands.contains(line.as_str())
                        && !listed(exceptions.ci_only_commands, line)
                })
                .map(|line| format!("`{line}`"))
                .collect()
        } else {
            step.calls
                .iter()
                .filter(|call| !gates.contains(call) && !listed(exceptions.ci_only_recipes, call))
                .map(|call| format!("`just {call}`"))
                .collect()
        };
        for stray in strays {
            found.push(diverged(
                format!(
                    "{}: job `{}` runs {stray}, which `just check` does not run",
                    step.place, step.job
                ),
                format!("the step runs: {}", step.lines.join("; ")),
            ));
        }
    }
    found
}

/// What `just check` and CI run, for judging the exceptions.
struct Ran<'a> {
    gates: &'a [String],
    unrun: &'a dyn Fn(&str) -> Option<Vec<String>>,
    ci_calls: &'a HashSet<&'a str>,
    ci_commands: &'a HashSet<&'a str>,
    gate_commands: &'a HashSet<&'a str>,
}

/// Exceptions that describe a difference that no longer exists.
fn stale_exceptions(ran: &Ran<'_>, exceptions: &Exceptions) -> Vec<FailureDetails> {
    let Ran {
        gates,
        unrun,
        ci_calls,
        ci_commands,
        gate_commands,
    } = ran;
    let mut found = Vec::new();
    for (name, _) in exceptions.local_only {
        let entry = format!("local_only `{name}`");
        if !gates.iter().any(|gate| gate == name) {
            found.push(stale(&entry, "`just check` no longer runs it"));
        } else if unrun(name).is_none() {
            found.push(stale(&entry, &format!("{CI} now runs it")));
        }
    }
    for (name, _) in exceptions.ci_only_recipes {
        let entry = format!("ci_only_recipes `{name}`");
        if !ci_calls.contains(name) {
            found.push(stale(&entry, &format!("no {CI} step runs it")));
        } else if gates.iter().any(|gate| gate == name) {
            found.push(stale(&entry, "`just check` now runs it"));
        }
    }
    for (command, _) in exceptions.ci_only_commands {
        let line = normalize(command);
        let entry = format!("ci_only_commands `{line}`");
        if !ci_commands.contains(line.as_str()) {
            found.push(stale(&entry, &format!("no {CI} step runs it")));
        } else if gate_commands.contains(line.as_str()) {
            found.push(stale(&entry, "a `just check` recipe now runs it"));
        }
    }
    found
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    compare(input, &EXCEPTIONS)
}

#[cfg(test)]
pub(super) mod tests {
    use super::{Exceptions, compare, parse_justfile, run};
    use crate::check_harness::Input;
    use crate::check_harness::test_support::{codes, no_run, run_at, summaries};
    use crate::context::Env;
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    /// No exception at all, for a fixture tree that needs none.
    pub(in crate::check_harness) const NO_EXCEPTIONS: Exceptions = Exceptions {
        local_only: &[],
        ci_only_recipes: &[],
        ci_only_commands: &[],
        ci_only_jobs: &[],
    };

    /// The comparison against `root` with no exception.
    pub(in crate::check_harness) fn compare_without_exceptions(
        root: &std::path::Path,
    ) -> Vec<FailureDetails> {
        let env = Env::new();
        compare(
            &Input {
                root,
                run: &no_run,
                env: &env,
            },
            &NO_EXCEPTIONS,
        )
    }

    const JUSTFILE: &str = "set shell := [\"bash\", \"-euo\", \"pipefail\", \"-c\"]\nflag := \"x\"\n\n# List the recipes\ndefault:\n    @just --list\n\n# The gate\ncheck: hooks fmt lint test build # trailing comment\n\nhooks:\n    node scripts/verify-hooks.ts\n\nfmt:\n    cargo fmt --all\n\nlint: (prep \"a\")\n    cargo fmt --all --check\n\n    -pnpm lint\n\nprep arg:\n    echo {{ arg }}\n\ntest: test-core && test-ui\n\ntest-core:\n    cargo nextest run --locked \\\n      -p core\n\ntest-ui:\n    pnpm test:ui\n\nbuild:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    just helper\n\nhelper:\n    @cargo build --locked\n\nextra:\n    cargo shear\n\ngen:\n    cargo test --locked export_bindings\n";

    const CI: &str = "on: [push, pull_request]\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@abc\n      - run: corepack enable pnpm\n      - run: cargo   fmt --all --check\n      - run: |\n          # a comment\n          pnpm lint\n          just --quiet prep a\n      - run: just test-core\n      - run: just test-ui\n      - run: just build\n      - name: Drift\n        run: |\n          just gen\n          git diff --exit-code\n  bootstrap:\n    name: Template Bootstrap Smoke\n    steps:\n      - run: cp -R . \"$RUNNER_TEMP/copy\"\n";

    const EXCEPTIONS: Exceptions = Exceptions {
        local_only: &[("hooks", "no hooks on CI"), ("fmt", "rewrites files")],
        ci_only_recipes: &[("gen", "writes files; CI diffs them")],
        ci_only_commands: &[("corepack enable pnpm", "runner setup")],
        ci_only_jobs: &[(
            "Template Bootstrap Smoke",
            "tests the bootstrap, not this tree",
        )],
    };

    fn check_with(
        justfile: Option<&str>,
        ci: Option<&str>,
        exceptions: &Exceptions,
    ) -> Vec<FailureDetails> {
        let dir = temp_dir();
        if let Some(justfile) = justfile {
            write(dir.path(), "justfile", justfile);
        }
        if let Some(ci) = ci {
            write(dir.path(), ".github/workflows/ci.yml", ci);
        }
        let env = Env::new();
        compare(
            &Input {
                root: dir.path(),
                run: &no_run,
                env: &env,
            },
            exceptions,
        )
    }

    fn with_ci(from: &str, to: &str) -> Vec<FailureDetails> {
        assert!(CI.contains(from), "the base ci.yml has no {from:?}");
        check_with(Some(JUSTFILE), Some(&CI.replacen(from, to, 1)), &EXCEPTIONS)
    }

    fn with_justfile(from: &str, to: &str) -> Vec<FailureDetails> {
        assert!(JUSTFILE.contains(from), "the base justfile has no {from:?}");
        check_with(Some(&JUSTFILE.replacen(from, to, 1)), Some(CI), &EXCEPTIONS)
    }

    #[test]
    fn reads_recipes_their_dependencies_and_their_command_lines() {
        let recipes = parse_justfile(JUSTFILE).expect("patterns");
        let names: Vec<&str> = recipes.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                "default",
                "check",
                "hooks",
                "fmt",
                "lint",
                "prep",
                "test",
                "test-core",
                "test-ui",
                "build",
                "helper",
                "extra",
                "gen"
            ]
        );
        let get = |name: &str| {
            &recipes
                .iter()
                .find(|(found, _)| found == name)
                .expect("recipe")
                .1
        };
        assert_eq!(get("check").deps, ["hooks", "fmt", "lint", "test", "build"]);
        assert_eq!(get("lint").deps, ["prep"]);
        assert_eq!(
            get("lint").commands,
            ["cargo fmt --all --check", "pnpm lint"]
        );
        assert_eq!(get("test").deps, ["test-core", "test-ui"]);
        assert_eq!(
            get("test-core").commands,
            ["cargo nextest run --locked -p core"]
        );
        assert_eq!(get("build").commands, ["set -euo pipefail", "just helper"]);
        assert_eq!(get("build").calls, ["helper"]);
        assert!(get("default").calls.is_empty());
        assert_eq!(get("helper").commands, ["cargo build --locked"]);
        let twice = parse_justfile("a:\n    one\nb:\n    two\na:\n    three\n").expect("patterns");
        let names: Vec<&str> = twice.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["a", "b"]);
        assert_eq!(twice[0].1.commands, ["three"]);
    }

    #[test]
    fn passes_when_both_sides_run_the_same_gates_apart_from_the_exceptions() {
        assert_eq!(check_with(Some(JUSTFILE), Some(CI), &EXCEPTIONS), []);
    }

    #[test]
    fn rejects_a_gate_only_just_check_runs() {
        let found = with_justfile(
            "check: hooks fmt lint test build",
            "check: hooks fmt lint test build extra",
        );
        assert_eq!(codes(&found), ["ERR_CHECK_JUST_CI_DIVERGED"]);
        assert!(found[0].summary.contains("`just extra`"));
        assert!(found[0].actual.contains("cargo shear"));
        assert_eq!(
            codes(&with_justfile(
                "    -pnpm lint\n",
                "    -pnpm lint\n    pnpm typecheck\n"
            )),
            ["ERR_CHECK_JUST_CI_DIVERGED"]
        );
    }

    #[test]
    fn rejects_a_step_only_ci_runs() {
        let found = with_ci(
            "      - run: just test-ui\n",
            "      - run: just test-ui\n      - run: just extra\n",
        );
        assert_eq!(codes(&found), ["ERR_CHECK_JUST_CI_DIVERGED"]);
        assert!(found[0].summary.contains(".github/workflows/ci.yml:"));
        assert_eq!(
            codes(&with_ci(
                "      - run: just test-ui\n",
                "      - run: just test-ui\n      - run: cargo deny check\n"
            )),
            ["ERR_CHECK_JUST_CI_DIVERGED"]
        );
        assert_eq!(
            codes(&with_ci(
                "    name: Template Bootstrap Smoke\n",
                "    name: Other\n"
            )),
            ["ERR_CHECK_JUST_CI_DIVERGED"]
        );
        let found = with_ci(
            "      - run: just test-ui\n",
            "      - run: just test-ui\n      - run: just check\n",
        );
        assert_eq!(codes(&found), ["ERR_CHECK_JUST_CI_STALE"; 2]);
        let found = summaries(&found);
        assert!(found[0].contains("local_only `hooks`") && found[1].contains("local_only `fmt`"));
    }

    #[test]
    fn names_where_ci_runs_a_gate_only_conditionally() {
        let found = with_ci(
            "      - run: just test-ui\n",
            "      - run: just test-ui || true\n",
        );
        assert_eq!(codes(&found), ["ERR_CHECK_JUST_CI_DIVERGED"]);
        assert!(found[0].summary.contains("only conditionally"));
        assert!(found[0].actual.contains("with an `||` fallback"));
        for line in ["if just test-ui; then echo ok; fi", "! just test-ui"] {
            assert_eq!(
                codes(&with_ci(
                    "      - run: just test-ui\n",
                    &format!("      - run: '{line}'\n")
                )),
                ["ERR_CHECK_JUST_CI_DIVERGED"],
                "{line}"
            );
        }
        let found = with_ci(
            "      - run: just test-ui\n",
            "      - run: just test-ui\n        if: always()\n      - run: just test-ui\n        continue-on-error: false\n",
        );
        assert_eq!(found, []);
        let found = with_ci(
            "      - run: just build\n",
            "      - run: just build\n        if: false\n",
        );
        let found = summaries(&found);
        assert_eq!(found.len(), 2);
        assert!(found[0].contains("`just build`") && found[1].contains("`just helper`"));
        let job_if = with_ci(
            "  a:\n    runs-on: ubuntu-24.04\n",
            "  a:\n    runs-on: ubuntu-24.04\n    if: github.event_name == 'push'\n",
        );
        assert!(
            job_if
                .iter()
                .all(|found| found.code == "ERR_CHECK_JUST_CI_DIVERGED")
                && !job_if.is_empty()
        );
        assert!(job_if[0].actual.contains("behind its job's `if:`"));
        let job_continues = with_ci(
            "  a:\n    runs-on: ubuntu-24.04\n",
            "  a:\n    runs-on: ubuntu-24.04\n    continue-on-error: true\n",
        );
        assert!(
            job_continues[0]
                .actual
                .contains("in a job with `continue-on-error`")
        );
        let step_continues = with_ci(
            "      - run: just test-ui\n",
            "      - run: just test-ui\n        continue-on-error: true\n",
        );
        assert!(
            step_continues[0]
                .actual
                .contains("with `continue-on-error`")
        );
    }

    #[test]
    fn rejects_a_stale_exception() {
        let add = |field: &str| -> Exceptions {
            let mut exceptions = Exceptions { ..EXCEPTIONS };
            match field {
                "local_only" => {
                    exceptions.local_only = &[("hooks", "x"), ("fmt", "x"), ("gone", "old")];
                }
                "ci_only_recipes" => exceptions.ci_only_recipes = &[("gen", "x"), ("gone", "old")],
                "ci_only_commands_gone" => {
                    exceptions.ci_only_commands =
                        &[("corepack enable pnpm", "x"), ("cargo gone", "old")];
                }
                _ => {
                    exceptions.ci_only_commands =
                        &[("corepack enable pnpm", "x"), ("pnpm lint", "old")];
                }
            }
            exceptions
        };
        for field in [
            "local_only",
            "ci_only_recipes",
            "ci_only_commands_gone",
            "ci_only_commands_gate",
        ] {
            assert_eq!(
                codes(&check_with(Some(JUSTFILE), Some(CI), &add(field))),
                ["ERR_CHECK_JUST_CI_STALE"],
                "{field}"
            );
        }
        assert_eq!(
            codes(&with_ci(
                "      - run: just test-ui\n",
                "      - run: just test-ui\n      - run: just fmt\n"
            )),
            ["ERR_CHECK_JUST_CI_STALE"]
        );
        assert_eq!(
            codes(&with_justfile(
                "check: hooks fmt lint test build",
                "check: hooks fmt lint test build gen"
            )),
            ["ERR_CHECK_JUST_CI_STALE"]
        );
    }

    #[test]
    fn fails_on_missing_or_unreadable_inputs() {
        assert_eq!(
            codes(&check_with(None, Some(CI), &EXCEPTIONS)),
            ["ERR_CHECK_JUST_CI_INPUT"]
        );
        assert_eq!(
            codes(&check_with(Some(JUSTFILE), None, &EXCEPTIONS)),
            ["ERR_CHECK_JUST_CI_INPUT"]
        );
        assert_eq!(
            codes(&check_with(Some(JUSTFILE), Some("jobs: [\n"), &EXCEPTIONS)),
            ["ERR_CHECK_JUST_CI_INPUT"]
        );
        assert_eq!(
            codes(&check_with(Some(JUSTFILE), Some("on: push\n"), &EXCEPTIONS)),
            ["ERR_CHECK_JUST_CI_INPUT"]
        );
        let found = check_with(Some("lint:\n    pnpm lint\n"), Some(CI), &EXCEPTIONS);
        assert_eq!(codes(&found), ["ERR_CHECK_JUST_CI_NO_CHECK"]);
        assert_eq!(found[0].actual, "recipes: lint");
        assert_eq!(
            check_with(Some(""), Some(CI), &EXCEPTIONS)[0].actual,
            "recipes: none"
        );
    }

    #[test]
    fn applies_its_own_exceptions_reporting_each_unused_one_as_stale() {
        let dir = temp_dir();
        write(
            dir.path(),
            "justfile",
            "check: verify-hooks fmt\nverify-hooks:\n    node scripts/verify-hooks.ts\nfmt:\n    cargo fmt --all\n",
        );
        write(
            dir.path(),
            ".github/workflows/ci.yml",
            "on: pull_request\njobs: {}\n",
        );
        let found = run_at(dir.path(), run);
        assert!(!found.is_empty());
        assert!(
            found
                .iter()
                .all(|found| found.code == "ERR_CHECK_JUST_CI_STALE")
        );
    }
}
