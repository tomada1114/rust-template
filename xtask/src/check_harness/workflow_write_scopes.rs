//! No workflow job whose token holds a write scope runs repository code. A job's token is
//! what a compromised dependency, build script, or `mise.toml` tool would act with, so a
//! job that writes (a release, a label, a SARIF upload, an OIDC token) must not also put
//! the repository's code on the runner and run it. A release workflow keeps every write
//! scope in a publish job that downloads the build job's verified artifact instead of
//! checking out; this check keeps every workflow that way.
//!
//! Read: every `.github/workflows/*.yml` and `*.yaml` under the root. A workflow that does
//! not parse is skipped here: workflow-hygiene reports it as
//! `ERR_CHECK_WORKFLOW_UNREADABLE`.
//!
//! Rules:
//! - A job's effective permissions are its own `permissions` when it has the key,
//!   whatever the value, else the workflow's top-level `permissions`, else the default
//!   token's. The default counts as write: the repository setting may grant it, and an
//!   unproven grant is never safe. `write-all`, `id-token: write`, and any scope value
//!   other than `read` or `none` count as write.
//! - A job holding a write scope fails when a step uses `actions/checkout` or
//!   `jdx/mise-action`, or a local action (`uses: ./…`, repository code by definition);
//!   when a `run:` line names `cargo` or `just` as a command word (or a path
//!   ending in one), also inside `$(…)`, a subshell, or after `;`, `&&`, or `|`; or when
//!   the job calls a remote reusable workflow, whose steps the check cannot see. A local
//!   reusable workflow is checked in its own file, with its own permissions. A step's or a
//!   job's `if:` is ignored: a conditional step still counts.
//! - A job that genuinely needs a write scope and one of these is a human's decision,
//!   recorded in [`EXCEPTIONS`] with the triggers it may keep and its reason; an exception
//!   that no longer applies, or a trigger it allows that the job no longer has, fails as
//!   stale.
//!
//! Errors: `ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE` (a job holding a write scope runs
//! repository code outside [`EXCEPTIONS`]), `ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE` (an
//! exception names no write-holding job, or allows a trigger the job no longer has).

use std::collections::HashMap;

use regex::Regex;

use super::workflows::{YamlFile, jobs_of, read_workflows, script_lines, steps_of};
use super::yaml::{Key, Node, Yaml};
use super::{Input, finding, pattern};
use crate::fail::FailureDetails;

const THIS: &str = "xtask/src/check_harness/workflow_write_scopes.rs";

const CHECKOUT: &str = "actions/checkout";
const MISE: &str = "jdx/mise-action";
const LOCAL_ACTION: &str = "local action";
const REUSABLE: &str = "reusable workflow";

/// A job allowed to hold a write scope and keep the triggers in `allows`.
struct WriteException {
    /// `<workflow path> <job id>`.
    key: &'static str,
    /// The triggers this job may keep while it holds a write scope.
    allows: &'static [&'static str],
}

/// Jobs allowed to hold a write scope and keep the triggers they list, as (`<workflow
/// path> <job id>`, the triggers, the reason). Adding an entry, or a trigger to one, is
/// weakening a gate (AGENTS.md › Security and human approval): it needs a human's sign-off.
const EXCEPTIONS: [(&str, &[&str], &str); 2] = [
    (
        ".github/workflows/codeql.yml analyze",
        &[CHECKOUT],
        "security-events: write uploads the SARIF; CodeQL extracts the checked-out source with build-mode: none, so no repository code runs",
    ),
    (
        ".github/workflows/scorecard.yml analysis",
        &[CHECKOUT],
        "security-events: write uploads the SARIF and id-token: write publishes the score; scorecard-action reads the checkout and runs no repository code",
    ),
];

const DEFAULT_TOKEN: &str =
    "the default token permissions (no permissions on the job or the workflow)";

/// The write grants a job's token holds; empty when it holds none. The job's own
/// `permissions` replace the workflow's whole, so `contents: read` under a top-level
/// `write-all` holds no write.
fn write_scopes(workflow: &Node, job: &Node) -> Vec<String> {
    let Some(source) = job
        .get("permissions")
        .or_else(|| workflow.get("permissions"))
    else {
        return vec![DEFAULT_TOKEN.to_owned()];
    };
    match &source.value {
        Yaml::Str(text) if text == "write-all" => vec!["write-all".to_owned()],
        Yaml::Str(text) if text == "read-all" => Vec::new(),
        Yaml::Str(text) => vec![format!("permissions: {text}")],
        Yaml::Map(_) => source
            .entries()
            .filter(|(_, value)| !matches!(value.as_str(), Some("read" | "none")))
            .map(|(scope, value)| {
                format!(
                    "{}: {}",
                    scope.unwrap_or_default(),
                    value.scalar_text().unwrap_or_else(|| value.to_json())
                )
            })
            .collect(),
        Yaml::Null | Yaml::Bool(_) | Yaml::Number(_) | Yaml::Seq(_) => {
            vec![format!("permissions: {}", source.to_json())]
        }
    }
}

/// One trigger in a write-holding job: where it is, and what to say about it.
struct Hit {
    trigger: &'static str,
    line: usize,
    what: String,
    actual: String,
}

fn action_hit(uses: &str, line: usize) -> Option<Hit> {
    let (trigger, what) = if uses.starts_with("actions/checkout@") {
        (
            CHECKOUT,
            "checks out the repository (actions/checkout)".to_owned(),
        )
    } else if uses.starts_with("jdx/mise-action@") {
        (MISE, "runs jdx/mise-action".to_owned())
    } else if uses.starts_with("./") {
        (LOCAL_ACTION, format!("runs the local action `{uses}`"))
    } else {
        return None;
    };
    Some(Hit {
        trigger,
        line,
        what,
        actual: uses.to_owned(),
    })
}

/// A command word: after the line's start or a shell separator (blank, `;`, `&`, `|`, a
/// backtick, `(` as in `$(…)`, a quote, `=`), optionally behind a path, and ending at one,
/// so `justfile`, `Cargo.lock`, and `cargo-nextest` are not commands. The trailing
/// separator is matched but never consumed: the next search starts at the tool's end.
fn command_pattern() -> Result<Regex, FailureDetails> {
    pattern(r#"(?:^|[\s;&|`("'=])(?:[^\s;&|`("'=]*/)?(cargo|just)(?:$|[\s;&|`)"'])"#)
}

/// A run line's repository-code commands, in order of first appearance.
fn commands_in(line: &str, pattern: &Regex) -> Vec<&'static str> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(captures) = pattern.captures_at(line, at) {
        let Some(tool) = captures.get(1) else {
            break;
        };
        at = tool.end();
        let tool = if tool.as_str() == "cargo" {
            "cargo"
        } else {
            "just"
        };
        if !found.contains(&tool) {
            found.push(tool);
        }
    }
    found
}

/// The first line each command appears on in a run step, in order of appearance.
fn run_hits(workflow: &YamlFile, keys: &[Key<'_>], run: &str, pattern: &Regex) -> Vec<Hit> {
    let location = workflow.root.locate(keys);
    let mut hits: Vec<Hit> = Vec::new();
    for (offset, text) in script_lines(run) {
        for tool in commands_in(&text, pattern) {
            if hits.iter().any(|hit| hit.trigger == tool) {
                continue;
            }
            hits.push(Hit {
                trigger: tool,
                line: if location.block {
                    location.line + 1 + offset
                } else {
                    location.line
                },
                what: format!("runs `{tool}`"),
                actual: text.clone(),
            });
        }
    }
    hits
}

/// Every trigger a job has, in step order; a local reusable call has none here.
fn job_hits(workflow: &YamlFile, id: &str, job: &Node, pattern: &Regex) -> Vec<Hit> {
    if let Some(uses) = job.get("uses").and_then(Node::as_str) {
        if uses.starts_with("./") {
            return Vec::new();
        }
        return vec![Hit {
            trigger: REUSABLE,
            line: workflow.line(&[Key::Name("jobs"), Key::Name(id), Key::Name("uses")]),
            what: format!("calls the reusable workflow `{uses}`"),
            actual: uses.to_owned(),
        }];
    }
    let mut hits = Vec::new();
    for (index, step) in steps_of(job) {
        let keys = [
            Key::Name("jobs"),
            Key::Name(id),
            Key::Name("steps"),
            Key::Index(index),
        ];
        if let Some(uses) = step.get("uses").and_then(Node::as_str) {
            let line = workflow.line(&[keys[0], keys[1], keys[2], keys[3], Key::Name("uses")]);
            hits.extend(action_hit(uses, line));
        } else if let Some(run) = step.get("run").and_then(Node::as_str) {
            hits.extend(run_hits(
                workflow,
                &[keys[0], keys[1], keys[2], keys[3], Key::Name("run")],
                run,
                pattern,
            ));
        }
    }
    hits
}

/// What the scan knows about each job, keyed `<workflow path> <job id>`.
struct JobFacts {
    scopes: Vec<String>,
    triggers: Vec<&'static str>,
}

fn stale(key: &str, why: &str, actual: impl Into<String>) -> FailureDetails {
    finding(
        "ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE",
        format!("the exception for `{key}` {why}"),
        "every EXCEPTIONS entry to name a job that holds a write scope and still has each trigger it allows",
        actual,
        format!("remove the entry, or the trigger from its `allows`, in {THIS}'s EXCEPTIONS"),
    )
}

fn stale_findings(
    exception: &WriteException,
    jobs: &HashMap<String, JobFacts>,
) -> Vec<FailureDetails> {
    let key = exception.key;
    let Some((path, id)) = key.split_once(' ') else {
        return vec![stale(
            key,
            "does not split into `<workflow path> <job id>`",
            format!("key: {key}"),
        )];
    };
    let Some(facts) = jobs.get(key) else {
        return vec![stale(
            key,
            "names no job in a readable workflow",
            format!("no job `{id}` in {path}"),
        )];
    };
    if facts.scopes.is_empty() {
        return vec![stale(
            key,
            "names a job that holds no write scope",
            "write scopes: none",
        )];
    }
    if exception.allows.is_empty() {
        return vec![stale(key, "allows no trigger", "allows: []")];
    }
    let mut allows: Vec<&str> = Vec::new();
    for trigger in exception.allows {
        if !allows.contains(trigger) {
            allows.push(trigger);
        }
    }
    let triggers = if facts.triggers.is_empty() {
        "none".to_owned()
    } else {
        facts.triggers.join(", ")
    };
    allows
        .into_iter()
        .filter(|trigger| !facts.triggers.contains(trigger))
        .map(|trigger| {
            stale(
                key,
                &format!("allows `{trigger}`, which the job no longer has"),
                format!("the job's triggers: {triggers}"),
            )
        })
        .collect()
}

/// The check's violations under the root, given the exception list.
fn scan(input: &Input<'_>, exceptions: &[WriteException]) -> Vec<FailureDetails> {
    let pattern = match command_pattern() {
        Ok(pattern) => pattern,
        Err(invalid) => return vec![invalid],
    };
    let (workflows, _) = read_workflows(input.root);
    let mut violations = Vec::new();
    let mut jobs = HashMap::new();
    for workflow in &workflows {
        for (id, job) in jobs_of(workflow) {
            let key = format!("{} {id}", workflow.path);
            let scopes = write_scopes(&workflow.root, job);
            let hits = if scopes.is_empty() {
                Vec::new()
            } else {
                job_hits(workflow, &id, job, &pattern)
            };
            let allowed = exceptions
                .iter()
                .find(|exception| exception.key == key)
                .map_or(&[][..], |exception| exception.allows);
            for hit in &hits {
                if allowed.contains(&hit.trigger) {
                    continue;
                }
                violations.push(finding(
                    "ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE",
                    format!("{}:{}: job `{id}` holds {} and {}", workflow.path, hit.line, scopes.join(", "), hit.what),
                    format!("no job holding a write scope or `id-token: write` (its own `permissions`, or the workflow's it inherits) checks out the repository, runs jdx/mise-action or a local action, calls a remote reusable workflow, or runs cargo or just, outside EXCEPTIONS in {THIS}"),
                    hit.actual.clone(),
                    "move the write scopes into a job that runs none of these (a publish job downloads the build job's verified artifact instead of checking out); if the job genuinely needs both, add an EXCEPTIONS entry with its reason, which is weakening a gate and needs a human's sign-off",
                ));
            }
            let mut triggers: Vec<&'static str> = Vec::new();
            for hit in &hits {
                if !triggers.contains(&hit.trigger) {
                    triggers.push(hit.trigger);
                }
            }
            jobs.insert(key, JobFacts { scopes, triggers });
        }
    }
    for exception in exceptions {
        violations.extend(stale_findings(exception, &jobs));
    }
    violations
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let exceptions: Vec<WriteException> = EXCEPTIONS
        .iter()
        .map(|(key, allows, _)| WriteException { key, allows })
        .collect();
    scan(input, &exceptions)
}

#[cfg(test)]
mod tests {
    use super::{
        CHECKOUT, EXCEPTIONS, LOCAL_ACTION, MISE, REUSABLE, WriteException, scan, write_scopes,
    };
    use crate::check_harness::test_support::{codes, no_run, summaries};
    use crate::check_harness::{Input, yaml};
    use crate::context::Env;
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const W: &str = ".github/workflows";
    const CHECKOUT_USES: &str =
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
    const MISE_USES: &str = "jdx/mise-action@c2a87611a18de5b3828c5652fe268e992400cb5c # v4.3.0";
    const WRITE: &str = "    permissions:\n      contents: write\n";
    const READ: &str = "    permissions:\n      contents: read\n";

    fn workflow(jobs: &str, top: &str) -> String {
        format!("name: W\non: push\n{top}jobs:\n{jobs}")
    }

    fn job(id: &str, permissions: &str, steps: &str) -> String {
        format!("  {id}:\n    runs-on: ubuntu-24.04\n{permissions}    steps:\n{steps}")
    }

    fn checkout() -> String {
        format!(
            "      - uses: {CHECKOUT_USES}\n        with:\n          persist-credentials: false\n"
        )
    }

    fn mise() -> String {
        format!("      - uses: {MISE_USES}\n")
    }

    fn run_step(command: &str) -> String {
        format!("      - run: {command}\n")
    }

    fn scan_files(files: &[(&str, &str)], exceptions: &[WriteException]) -> Vec<FailureDetails> {
        let dir = temp_dir();
        for (path, content) in files {
            write(dir.path(), path, content);
        }
        let env = Env::new();
        scan(
            &Input {
                root: dir.path(),
                run: &no_run,
                env: &env,
            },
            exceptions,
        )
    }

    fn one(body: &str, top: &str, exceptions: &[WriteException]) -> Vec<FailureDetails> {
        scan_files(
            &[(".github/workflows/w.yml", &workflow(body, top))],
            exceptions,
        )
    }

    const TOP: &str = "permissions:\n  contents: read\n";

    #[test]
    fn passes_jobs_that_hold_no_write_or_run_no_code() {
        let build = job(
            "build",
            READ,
            &[
                checkout(),
                mise(),
                run_step("cargo fetch --locked"),
                run_step("cargo build --locked"),
                run_step("just test"),
            ]
            .concat(),
        );
        let publish = "  publish:\n    needs: [build]\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: write\n      attestations: write\n      id-token: write\n    steps:\n      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n      - run: gh release create \"$TAG\" --verify-tag dist-release/*.dmg\n";
        assert_eq!(
            one(&format!("{build}{publish}"), "permissions: {}\n", &[]),
            []
        );
        assert_eq!(scan_files(&[("README.md", "# app\n")], &[]), []);
        let steps = [
            checkout(),
            mise(),
            run_step("just test"),
            "      - uses: ./x\n".to_owned(),
        ]
        .concat();
        let body = job("empty", "    permissions: {}\n", &steps)
            + &job("reader", "    permissions: read-all\n", &steps);
        assert_eq!(one(&body, TOP, &[]), []);
        assert_eq!(one(&job("build", "", &checkout()), TOP, &[]), []);
        assert_eq!(
            one(
                &job("build", READ, &checkout()),
                "permissions: write-all\n",
                &[]
            ),
            []
        );
        assert_eq!(
            scan_files(&[(".github/workflows/broken.yml", "jobs: [\n")], &[]),
            []
        );
    }

    #[test]
    fn fails_a_write_job_that_runs_repository_code() {
        let found = one(&job("build", WRITE, &checkout()), TOP, &[]);
        assert_eq!(
            summaries(&found),
            [
                ".github/workflows/w.yml:11: job `build` holds contents: write and checks out the repository (actions/checkout)"
            ]
        );
        assert_eq!(
            found[0].actual,
            CHECKOUT_USES.split(' ').next().expect("uses")
        );
        let found = one(
            &job("sign", "    permissions:\n      id-token: write\n", &mise()),
            TOP,
            &[],
        );
        assert_eq!(
            summaries(&found),
            [
                ".github/workflows/w.yml:11: job `sign` holds id-token: write and runs jdx/mise-action"
            ]
        );
    }

    #[test]
    fn finds_each_repository_command_a_write_job_runs() {
        let steps = [run_step("cargo build --locked"), run_step("just test")].concat();
        let prefix = ".github/workflows/w.yml";
        let held = "job `build` holds contents: write and runs";
        assert_eq!(
            summaries(&one(&job("build", WRITE, &steps), TOP, &[])),
            [
                format!("{prefix}:11: {held} `cargo`"),
                format!("{prefix}:12: {held} `just`")
            ]
        );
        let steps = [
            run_step("echo \"dir=$(just --evaluate log_dir)\""),
            run_step("(cd crates && cargo build --locked)"),
            run_step("true;just test"),
        ]
        .concat();
        assert_eq!(
            summaries(&one(&job("build", WRITE, &steps), TOP, &[])),
            [
                format!("{prefix}:11: {held} `just`"),
                format!("{prefix}:12: {held} `cargo`"),
                format!("{prefix}:13: {held} `just`")
            ]
        );
        let block = "      - run: |\n          echo start\n          /home/runner/.cargo/bin/cargo test --locked\n      - run: mise exec -- just test\n";
        let found = one(&job("build", WRITE, block), TOP, &[]);
        let pairs: Vec<(String, String)> = found
            .iter()
            .map(|found| (found.summary.clone(), found.actual.clone()))
            .collect();
        assert_eq!(
            pairs,
            [
                (
                    format!("{prefix}:13: {held} `cargo`"),
                    "/home/runner/.cargo/bin/cargo test --locked".to_owned()
                ),
                (
                    format!("{prefix}:14: {held} `just`"),
                    "mise exec -- just test".to_owned()
                ),
            ]
        );
        let found = one(
            &job(
                "build",
                WRITE,
                &run_step("cargo build; cargo test && just x"),
            ),
            TOP,
            &[],
        );
        assert_eq!(
            summaries(&found),
            [
                format!("{prefix}:11: {held} `cargo`"),
                format!("{prefix}:11: {held} `just`")
            ]
        );
        // A separator ends one command word and starts the next, so neither hides the other.
        for (line, first, second) in [
            ("cargo;just x", "cargo", "just"),
            ("cargo|just x", "cargo", "just"),
        ] {
            assert_eq!(
                summaries(&one(&job("build", WRITE, &run_step(line)), TOP, &[])),
                [
                    format!("{prefix}:11: {held} `{first}`"),
                    format!("{prefix}:11: {held} `{second}`")
                ],
                "{line}"
            );
        }
        let quiet = [
            run_step("python3 tools/x.py"),
            run_step("gh release create \"$TAG\""),
            run_step("cat justfile Cargo.lock"),
            run_step("cargo-nextest --version"),
        ]
        .concat();
        assert_eq!(one(&job("build", WRITE, &quiet), TOP, &[]), []);
    }

    #[test]
    fn fails_a_write_job_that_runs_a_local_action_or_several_tools() {
        let prefix = ".github/workflows/w.yml";
        let held = "job `build` holds contents: write and runs";
        let found = one(
            &job("build", WRITE, "      - uses: ./.github/actions/setup\n"),
            TOP,
            &[],
        );
        assert_eq!(
            summaries(&found),
            [format!(
                "{prefix}:11: job `build` holds contents: write and runs the local action `./.github/actions/setup`"
            )]
        );
        let conditional =
            format!("      - if: github.event_name == 'push'\n        uses: {CHECKOUT_USES}\n");
        assert_eq!(
            codes(&one(&job("build", WRITE, &conditional), TOP, &[])),
            ["ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE"]
        );
        let found = one(
            &job(
                "build",
                WRITE,
                &[checkout(), mise(), run_step("just test")].concat(),
            ),
            TOP,
            &[],
        );
        assert_eq!(
            summaries(&found),
            [
                format!(
                    "{prefix}:11: job `build` holds contents: write and checks out the repository (actions/checkout)"
                ),
                format!("{prefix}:14: job `build` holds contents: write and runs jdx/mise-action"),
                format!("{prefix}:15: {held} `just`"),
            ]
        );
    }

    #[test]
    fn fails_a_remote_reusable_call_and_checks_a_local_callee_itself() {
        let caller = workflow(
            "  remote:\n    permissions:\n      contents: write\n    uses: octo/repo/.github/workflows/x.yml@3d3c42e5aac5ba805825da76410c181273ba90b1\n  local:\n    permissions:\n      contents: write\n    uses: ./.github/workflows/callee.yml\n",
            TOP,
        );
        let reusable = format!(
            "name: Callee\non: workflow_call\njobs:\n{}",
            job("inner", WRITE, &checkout())
        );
        let found = scan_files(
            &[
                (".github/workflows/caller.yml", &caller),
                (".github/workflows/callee.yml", &reusable),
            ],
            &[],
        );
        assert_eq!(
            summaries(&found),
            [
                ".github/workflows/callee.yml:9: job `inner` holds contents: write and checks out the repository (actions/checkout)",
                ".github/workflows/caller.yml:9: job `remote` holds contents: write and calls the reusable workflow `octo/repo/.github/workflows/x.yml@3d3c42e5aac5ba805825da76410c181273ba90b1`",
            ]
        );
    }

    #[test]
    fn reads_scopes_from_the_job_then_the_workflow_then_the_default() {
        for (permissions, top, scope) in [
            ("", "permissions: write-all\n", "write-all"),
            ("", "permissions:\n  contents: write\n", "contents: write"),
            (
                "",
                "",
                "the default token permissions (no permissions on the job or the workflow)",
            ),
            ("    permissions: write-all\n", TOP, "write-all"),
            ("    permissions:\n", TOP, "permissions: null"),
            (
                "    permissions:\n      contents: admin\n",
                TOP,
                "contents: admin",
            ),
        ] {
            let found = one(&job("build", permissions, &checkout()), top, &[]);
            assert_eq!(found.len(), 1);
            assert!(
                found[0]
                    .summary
                    .contains(&format!("job `build` holds {scope} and checks out")),
                "{}",
                found[0].summary
            );
        }
        let parse = |text: &str| yaml::parse(text, yaml::Keys::Unique).expect("yaml").root;
        let top = parse("permissions: 7\n");
        assert_eq!(
            write_scopes(
                &top,
                &parse("permissions:\n  contents: read\n  issues: write\n")
            ),
            ["issues: write"]
        );
        assert_eq!(write_scopes(&top, &parse("a: 1\n")), ["permissions: 7"]);
        assert_eq!(
            write_scopes(&top, &parse("permissions: read-all\n")),
            Vec::<String>::new()
        );
        assert_eq!(
            write_scopes(&top, &parse("permissions: write\n")),
            ["permissions: write"]
        );
        assert_eq!(
            write_scopes(&top, &parse("permissions: [contents]\n")),
            ["permissions: [\"contents\"]"]
        );
    }

    fn exception(key: &'static str, allows: &'static [&'static str]) -> [WriteException; 1] {
        [WriteException { key, allows }]
    }

    #[test]
    fn honours_an_exception_and_reports_a_stale_one() {
        let key = ".github/workflows/w.yml build";
        let found = one(
            &job(
                "build",
                WRITE,
                &[checkout(), run_step("cargo test --locked")].concat(),
            ),
            TOP,
            &exception(key, &[CHECKOUT]),
        );
        assert_eq!(
            summaries(&found),
            [".github/workflows/w.yml:14: job `build` holds contents: write and runs `cargo`"]
        );
        let both = [
            WriteException {
                key,
                allows: &[CHECKOUT],
            },
            WriteException {
                key: ".github/workflows/w.yml missing",
                allows: &[CHECKOUT],
            },
        ];
        let found = one(&job("build", WRITE, &checkout()), TOP, &both);
        assert_eq!(codes(&found), ["ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE"]);
        assert_eq!(
            summaries(&found),
            [
                "the exception for `.github/workflows/w.yml missing` names no job in a readable workflow"
            ]
        );
        let found = one(
            &job("build", READ, &checkout()),
            TOP,
            &exception(key, &[CHECKOUT]),
        );
        assert_eq!(
            summaries(&found),
            [
                "the exception for `.github/workflows/w.yml build` names a job that holds no write scope"
            ]
        );
        let found = one(
            &job("build", WRITE, &checkout()),
            TOP,
            &exception(key, &[CHECKOUT, "just", LOCAL_ACTION, "just"]),
        );
        assert_eq!(
            summaries(&found),
            [
                "the exception for `.github/workflows/w.yml build` allows `just`, which the job no longer has",
                "the exception for `.github/workflows/w.yml build` allows `local action`, which the job no longer has",
            ]
        );
        assert_eq!(found[0].actual, "the job's triggers: actions/checkout");
        let found = one(
            &job("build", WRITE, &run_step("echo hi")),
            TOP,
            &exception(key, &["cargo"]),
        );
        assert_eq!(found[0].actual, "the job's triggers: none");
        let found = one(
            &job("build", WRITE, ""),
            TOP,
            &exception("release.yml", &["cargo"]),
        );
        assert_eq!(
            summaries(&found),
            ["the exception for `release.yml` does not split into `<workflow path> <job id>`"]
        );
        let found = one(&job("build", WRITE, &checkout()), TOP, &exception(key, &[]));
        assert_eq!(
            codes(&found),
            [
                "ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE",
                "ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE"
            ]
        );
        assert_eq!(
            found[1].summary,
            "the exception for `.github/workflows/w.yml build` allows no trigger"
        );
    }

    #[test]
    fn ships_exceptions_keyed_by_a_workflow_and_a_job_each_with_a_reason() {
        let triggers = [CHECKOUT, MISE, "cargo", "just", LOCAL_ACTION, REUSABLE];
        for (key, allows, reason) in EXCEPTIONS {
            let (path, id) = key.split_once(' ').expect("a space");
            assert!(
                path.starts_with(&format!("{W}/"))
                    && crate::check_harness::has_extension(path, &["yml", "yaml"])
            );
            assert!(!id.is_empty() && !id.contains(' '));
            assert!(!reason.trim().is_empty());
            assert!(!allows.is_empty());
            assert!(allows.iter().all(|trigger| triggers.contains(trigger)));
        }
    }
}
