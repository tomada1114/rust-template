//! Every GitHub Actions workflow is pinned, least-privileged, bounded in time, fails
//! closed, installs from the lockfile, and cannot cancel a run on `main`.
//!
//! Files: `.github/workflows/*.yml|*.yaml` under the root (absent directory: nothing to
//! check); the repository's own composite actions (every `action.yml|action.yaml` under
//! `.github/actions/`, and any other one a step's `uses: ./…` names); the `justfile` for
//! the lockfile rule; and for the bot-prefix rule `.github/dependabot.yml|.yaml` and the
//! Renovate config ([`read_renovate`]; a JSON5 config is a finding, since it cannot be
//! read).
//!
//! Rules, per workflow (the step rules also per composite action step):
//! - pins: every `uses:` (a step's, or a job's reusable-workflow call) other than a local
//!   `./` action is `owner/repo[/path]@<40 lowercase hex>`, and the raw source line
//!   carrying it has a `# vX.Y.Z` comment (the form Dependabot keeps when it bumps a pin).
//!   YAML drops comments, so that one rule reads the raw line.
//! - every job has `timeout-minutes` (a reusable-workflow call cannot, and is exempt);
//! - the top-level `permissions` is `{}` or grants at most `contents: read`; every job
//!   declares its own `permissions` mapping (never a `read-all`/`write-all` shorthand);
//! - every `actions/checkout` step sets `persist-credentials: false`;
//! - no `pull_request_target` trigger;
//! - a workflow triggered on `pull_request` has a top-level `concurrency` whose group
//!   names `github.workflow`. On a workflow also triggered on `push`, every `concurrency`
//!   — the top-level one and each job's — never cancels a push run: its
//!   `cancel-in-progress` is absent, false, or an expression that is false on a push, and
//!   its group, evaluated for a push ([`expressions`](super::expressions)), contains
//!   `github.sha`, `github.run_id`, or `github.run_number`, since GitHub also cancels a
//!   *pending* run that a newer one joins in its group. An expression the evaluator cannot
//!   read counts as unproven, never as safe;
//! - no `continue-on-error` on a job or a step, other than `false`: a failing step would
//!   report success;
//! - fail-closed `run:` steps: each resolves (step `shell`, then the job's, then the
//!   workflow's `defaults.run.shell`) to exactly [`FAIL_CLOSED_SHELL`], or its first
//!   command is `set -euo pipefail` (`-Eeuo` and similar count). A step whose own shell is
//!   not sh-family (`pwsh`, `python`) is outside this rule;
//! - fail-open commands: no `set +e`/`+u` (or `set +o errexit|nounset|pipefail`) in a
//!   `run:`, and no command whose failure is swallowed by an `|| true`, `|| :`,
//!   `|| exit 0`, `|| echo …`, or `|| printf …` fallback;
//! - no `npm install`/`npm i`/`npm add` (global options such as `--prefix x` before it
//!   included), which installs from the registry with no lockfile and no pin — a tool a
//!   job needs is pinned in `mise.toml`; and every `cargo` [`CARGO_LOCKED`] subcommand has
//!   `--locked` (or `--frozen`) before any `--`. The same
//!   rule reads every justfile recipe line, which is what lets a `run:` that calls
//!   `just <recipe>` rely on the recipe.
//!
//! And once for the repository:
//! - bot commit prefixes: every Dependabot `updates[].commit-message.prefix` (and
//!   `prefix-development`), and Renovate's `commitMessagePrefix` (top level and in
//!   `packageRules`), exist and lead with a type every PR-title check accepts: the `types`
//!   input of each step using amannn/action-semantic-pull-request, or the action's
//!   defaults when the input is unset. Skipped when neither bot is configured.
//!
//! Errors (one per finding):
//! - `ERR_CHECK_WORKFLOW_UNREADABLE`: a workflow (or local action) is not YAML, not a
//!   mapping, or has no `jobs` (`runs`) mapping
//! - `ERR_CHECK_WORKFLOW_UNPINNED`: a `uses:` is not pinned to a full commit SHA
//! - `ERR_CHECK_WORKFLOW_PIN_COMMENT`: a SHA pin has no `# vX.Y.Z` comment on its line
//! - `ERR_CHECK_WORKFLOW_TIMEOUT`: a job has no `timeout-minutes`
//! - `ERR_CHECK_WORKFLOW_PERMISSIONS`: the top-level `permissions` is missing or broader
//!   than `contents: read`
//! - `ERR_CHECK_WORKFLOW_JOB_PERMISSIONS`: a job declares no `permissions` mapping of its
//!   own
//! - `ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS`: an actions/checkout step keeps its
//!   credentials
//! - `ERR_CHECK_WORKFLOW_PULL_REQUEST_TARGET`: a workflow triggers on
//!   `pull_request_target`
//! - `ERR_CHECK_WORKFLOW_CONCURRENCY`: a PR workflow has no concurrency, or a concurrency
//!   can cancel a push run
//! - `ERR_CHECK_WORKFLOW_CONTINUE_ON_ERROR`: a job or step sets `continue-on-error`
//! - `ERR_CHECK_WORKFLOW_SHELL`: a `run:` step does not fail closed
//! - `ERR_CHECK_WORKFLOW_FAIL_OPEN`: a `run:` turns errexit off or swallows a failure with
//!   an `||` fallback
//! - `ERR_CHECK_WORKFLOW_UNLOCKED`: an install or cargo command (in a workflow, an action,
//!   or the justfile) ignores the lockfile
//! - `ERR_CHECK_WORKFLOW_BOT_PREFIX`: a bot's commit prefix is missing or not a PR-title
//!   type, or a bot config (a JSON5 Renovate one included) cannot be read

use std::path::Path;

use regex::Regex;

use super::expressions::{Event, Value, is_whole_expression, template_on, truthy};
use super::workflows::{
    DEPENDABOT_FILES, Renovate, TITLE_ACTION, TitleCheck, YamlFile, action_steps_of,
    continues_on_error, jobs_of, read_actions, read_renovate, read_workflows, read_yaml,
    script_lines, steps_of, title_checks, trigger_names,
};
use super::yaml::{Key, Node};
use super::{Input, pattern, read_file};
use crate::fail::FailureDetails;

const WORKFLOWS_DIR: &str = ".github/workflows";
const JUSTFILE: &str = "justfile";

/// The shell every `run:` step resolves to unless it starts with `set -euo pipefail`.
const FAIL_CLOSED_SHELL: &str = "bash --noprofile --norc -euo pipefail {0}";
const PER_RUN_CONTEXTS: [&str; 3] = ["github.sha", "github.run_id", "github.run_number"];
const SH_FAMILY: [&str; 5] = ["sh", "bash", "dash", "ksh", "zsh"];
/// Cargo subcommands that resolve Cargo.lock, and so take `--locked`.
const CARGO_LOCKED: [&str; 13] = [
    "bench", "build", "check", "clippy", "deny", "doc", "fetch", "install", "llvm-cov", "nextest",
    "run", "shear", "test",
];
const NPM_INSTALL: [&str; 3] = ["install", "i", "add"];

/// One rule's code and the Expected and Next lines its findings share.
struct Rule {
    code: &'static str,
    expected: &'static str,
    next: &'static str,
}

const UNPINNED: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_UNPINNED",
    expected: "every non-local `uses:` to read `owner/repo[/path]@<40-hex SHA> # vX.Y.Z`",
    next: "replace the ref with the release's full commit SHA and a trailing `# vX.Y.Z` comment",
};
const PIN_COMMENT: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_PIN_COMMENT",
    expected: "a `# vX.Y.Z` comment after the SHA on the same line (the release the SHA is)",
    next: "append the release tag the SHA points at, e.g. `# v4.3.0`, so Dependabot and a reviewer can read it",
};
const TIMEOUT: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_TIMEOUT",
    expected: "`timeout-minutes:` on every job (a hung job otherwise holds a runner for 6 hours)",
    next: "add `timeout-minutes:` to the job, a little above its slowest green run",
};
const PERMISSIONS: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_PERMISSIONS",
    expected: "a top-level `permissions:` of `{}` or `contents: read`, and nothing broader",
    next: "set the top-level `permissions:` to `contents: read` and move each wider scope into the job that needs it",
};
const JOB_PERMISSIONS: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_JOB_PERMISSIONS",
    expected: "a `permissions:` mapping on every job, naming only the scopes that job uses",
    next: "add `permissions:` to the job (e.g. `contents: read`), spelling out scopes instead of a shorthand",
};
const CHECKOUT: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS",
    expected: "`with: persist-credentials: false` on every actions/checkout step",
    next: "add `persist-credentials: false` under the step's `with:` (a later step that pushes gets its own token)",
};
const PULL_REQUEST_TARGET: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_PULL_REQUEST_TARGET",
    expected: "no workflow triggered on `pull_request_target`",
    next: "trigger on `pull_request` instead; a write that must run on forks belongs in a separate, reviewed workflow",
};
const CONCURRENCY: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_CONCURRENCY",
    expected: "a top-level `concurrency:` on every pull_request workflow with a group naming `github.workflow`; on a workflow also run on push, every concurrency (top-level and per job) with a group that is unique per push run when evaluated for a push, and a cancel that is false on a push",
    next: "copy ci.yml's block: `group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}` and `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`",
};
const CONTINUE_ON_ERROR: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_CONTINUE_ON_ERROR",
    expected: "no `continue-on-error` on a job or step (AGENTS.md › Security and human approval lists it as weakening a gate)",
    next: "remove it; a step that must not run in some case is skipped by an `if:` on that condition instead",
};
const SHELL: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_SHELL",
    expected: "every `run:` step to resolve to `shell: bash --noprofile --norc -euo pipefail {0}` or to start with `set -euo pipefail`",
    next: "add a top-level `defaults: run: shell: bash --noprofile --norc -euo pipefail {0}` (as ci.yml does), or start the script with `set -euo pipefail`",
};
const FAIL_OPEN: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_FAIL_OPEN",
    expected: "no `set +e`/`set +u`/`set +o errexit|nounset|pipefail`, and no `|| true`, `|| :`, `|| exit 0`, `|| echo`, or `|| printf` fallback, in a `run:`",
    next: "let the command fail the step; when a failure is expected, test for it explicitly (`if ! cmd; then …; exit 1; fi`) or skip the step with an `if:`",
};
const UNLOCKED: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_UNLOCKED",
    expected: "no `npm install`, and `--locked` on every cargo build/check/clippy/doc/test/bench/run/install/fetch/nextest/llvm-cov/deny/shear before any `--`",
    next: "add the flag, or call the `just` recipe that already carries it; pin a tool in mise.toml instead of installing it from npm",
};
const BOT_PREFIX: Rule = Rule {
    code: "ERR_CHECK_WORKFLOW_BOT_PREFIX",
    expected: "every Dependabot `commit-message.prefix` and Renovate `commitMessagePrefix` set, with a type every PR-title check's `types` lists",
    next: "set the prefix (e.g. `deps:`) and add its type to check-pr-title.yml's `types` in the same change, or use a type it already lists",
};

fn found(rule: &Rule, summary: String, actual: impl Into<String>) -> FailureDetails {
    FailureDetails {
        code: rule.code.to_owned(),
        summary,
        expected: rule.expected.to_owned(),
        actual: actual.into(),
        next: rule.next.to_owned(),
    }
}

/// The patterns the rules match, compiled once per run.
struct Patterns {
    pinned: Regex,
    version_comment: Regex,
    set_fail_closed: Regex,
    errexit_off: Regex,
    fail_open_split: Regex,
    command_separators: Regex,
    single_quoted: Regex,
    trailing_comment: Regex,
    prefix_type: Regex,
}

impl Patterns {
    fn new() -> Result<Self, FailureDetails> {
        let compile = pattern;
        Ok(Self {
            pinned: compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[^@\s]+)?@[0-9a-f]{40}$")?,
            version_comment: compile(r"#\s*v[0-9]+\.[0-9]+\.[0-9]+(?:[\s-]|$)")?,
            set_fail_closed: compile(r"^set\s+-([A-Za-z]*o)\s+pipefail(?:[\s;]|$)")?,
            errexit_off: compile(
                r"^set\s(?:.*\s)?(?:\+[A-Za-z]*[eu][A-Za-z]*|\+o\s+(?:errexit|nounset|pipefail))(?:\s|$)",
            )?,
            // ASCII word boundaries, as in the JavaScript original.
            fail_open_split: compile(r"&&|\|\||;|\||(?-u:\b)(?:then|do)(?-u:\b)")?,
            command_separators: compile(r"&&|\|\||;|\|")?,
            single_quoted: compile(r"'[^']*'")?,
            trailing_comment: compile(r"(?:^|\s)#.*$")?,
            prefix_type: compile(r"^[A-Za-z0-9_-]+")?,
        })
    }
}

/// Text with runs of whitespace collapsed to one space, trimmed.
fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A value as `JSON.stringify` writes it, or `none declared` when absent.
fn describe(value: Option<&Node>) -> String {
    value.map_or_else(|| "none declared".to_owned(), Node::to_json)
}

/// Where one step sits: in a workflow job, or in a composite action.
enum Place {
    Job(String),
    Action,
}

/// One step, in a workflow's job or a composite action, with what the step rules need.
struct StepSite<'a> {
    file: &'a YamlFile,
    place: Place,
    index: usize,
    /// Who owns the step, for a message: "job `build`" or "action `…/action.yml`".
    owner: String,
    step: &'a Node,
    /// The job's or workflow's `defaults.run.shell`, which a step without its own inherits.
    default_shell: Option<String>,
}

impl StepSite<'_> {
    /// The line a key under the step sits on (the step's own line when the key is absent).
    fn line_of(&self, key: &str) -> (usize, bool) {
        let location = match &self.place {
            Place::Job(id) => self.file.root.locate(&[
                Key::Name("jobs"),
                Key::Name(id),
                Key::Name("steps"),
                Key::Index(self.index),
                Key::Name(key),
            ]),
            Place::Action => self.file.root.locate(&[
                Key::Name("runs"),
                Key::Name("steps"),
                Key::Index(self.index),
                Key::Name(key),
            ]),
        };
        (location.line, location.block)
    }

    fn at(&self, key: &str) -> String {
        format!("{}:{}", self.file.path, self.line_of(key).0)
    }
}

fn shell_of(value: Option<&Node>) -> Option<String> {
    value?.get("run")?.get("shell")?.as_str().map(str::to_owned)
}

fn workflow_steps(workflow: &YamlFile) -> Vec<StepSite<'_>> {
    let workflow_shell = shell_of(workflow.root.get("defaults"));
    let mut sites = Vec::new();
    for (id, job) in jobs_of(workflow) {
        let default_shell = shell_of(job.get("defaults")).or_else(|| workflow_shell.clone());
        for (index, step) in steps_of(job) {
            sites.push(StepSite {
                file: workflow,
                place: Place::Job(id.clone()),
                index,
                owner: format!("job `{id}`"),
                step,
                default_shell: default_shell.clone(),
            });
        }
    }
    sites
}

fn action_steps(action: &YamlFile) -> Vec<StepSite<'_>> {
    action_steps_of(action)
        .into_iter()
        .map(|(index, step)| StepSite {
            file: action,
            place: Place::Action,
            index,
            owner: format!("action `{}`", action.path),
            step,
            default_shell: None,
        })
        .collect()
}

fn check_uses(
    file: &YamlFile,
    line: usize,
    uses: &str,
    patterns: &Patterns,
) -> Option<FailureDetails> {
    if uses.starts_with("./") {
        return None;
    }
    let place = format!("{}:{line}", file.path);
    if !patterns.pinned.is_match(uses) {
        return Some(found(
            &UNPINNED,
            format!("{place}: `{uses}` is not pinned to a commit SHA"),
            uses,
        ));
    }
    let raw = file
        .lines
        .get(line.wrapping_sub(1))
        .map_or("", String::as_str);
    if !patterns.version_comment.is_match(raw) {
        return Some(found(
            &PIN_COMMENT,
            format!("{place}: `{uses}` has no `# vX.Y.Z` comment"),
            raw.trim(),
        ));
    }
    None
}

fn check_job_calls(workflow: &YamlFile, patterns: &Patterns) -> Vec<FailureDetails> {
    jobs_of(workflow)
        .into_iter()
        .filter_map(|(id, job)| {
            let call = job.get("uses")?.as_str()?;
            let line = workflow.line(&[Key::Name("jobs"), Key::Name(&id), Key::Name("uses")]);
            check_uses(workflow, line, call, patterns)
        })
        .collect()
}

fn check_timeouts(workflow: &YamlFile) -> Vec<FailureDetails> {
    jobs_of(workflow)
        .into_iter()
        .filter(|(_, job)| !job.has("uses") && !job.has("timeout-minutes"))
        .map(|(id, _)| {
            found(
                &TIMEOUT,
                format!(
                    "{}: job `{id}` has no timeout-minutes",
                    workflow.at(&[Key::Name("jobs"), Key::Name(&id)])
                ),
                "no `timeout-minutes:` on the job (a step's does not count)",
            )
        })
        .collect()
}

fn check_permissions(workflow: &YamlFile) -> Vec<FailureDetails> {
    let mut findings = Vec::new();
    let top = workflow.root.get("permissions");
    let narrow = top.is_some_and(|top| {
        top.is_map()
            && top.entries().all(|(scope, level)| {
                scope.as_deref() == Some("contents")
                    && matches!(level.as_str(), Some("read" | "none"))
            })
    });
    if !narrow {
        let summary = if top.is_none() {
            format!("{}: no top-level permissions", workflow.path)
        } else {
            format!(
                "{}: the top-level permissions are broader than contents: read",
                workflow.at(&[Key::Name("permissions")])
            )
        };
        findings.push(found(
            &PERMISSIONS,
            summary,
            format!("permissions: {}", describe(top)),
        ));
    }
    for (id, job) in jobs_of(workflow) {
        let own = job.get("permissions");
        if own.is_some_and(Node::is_map) {
            continue;
        }
        findings.push(found(
            &JOB_PERMISSIONS,
            format!(
                "{}: job `{id}` declares no permissions mapping of its own",
                workflow.at(&[Key::Name("jobs"), Key::Name(&id)])
            ),
            format!("permissions: {}", describe(own)),
        ));
    }
    findings
}

fn check_checkout(site: &StepSite<'_>) -> Option<FailureDetails> {
    let uses = site.step.get("uses")?.as_str()?;
    if !uses.starts_with("actions/checkout@") {
        return None;
    }
    let persist = site
        .step
        .get("with")
        .and_then(|inputs| inputs.get("persist-credentials"));
    if persist
        .is_some_and(|value| value.as_bool() == Some(false) || value.as_str() == Some("false"))
    {
        return None;
    }
    Some(found(
        &CHECKOUT,
        format!(
            "{}: actions/checkout in {} keeps its credentials",
            site.at("uses"),
            site.owner
        ),
        format!("persist-credentials: {}", describe(persist)),
    ))
}

/// Why a push run's concurrency group is not unique per run, or `None` when it is.
fn shared_push_group(group: &str) -> Option<String> {
    let Some(parts) = template_on(Event::Push, group) else {
        return Some(format!(
            "group `{group}` cannot be evaluated for a push run (only literals, contexts, !, ==, !=, &&, ||, and parentheses are read), so it is not shown unique per push run"
        ));
    };
    let per_run = parts.iter().any(
        |part| matches!(part, Value::Context(path) if PER_RUN_CONTEXTS.contains(&path.as_str())),
    );
    (!per_run).then(|| format!("group `{group}` is shared by push runs (on a push it has no github.sha, run_id, or run_number), so a newer push cancels a pending one"))
}

/// Whether a `cancel-in-progress` value is false on a push run.
fn cancel_safe_on_push(cancel: Option<&Node>) -> bool {
    let Some(cancel) = cancel else {
        return true;
    };
    if cancel.as_bool() == Some(false) || cancel.as_str() == Some("false") {
        return true;
    }
    let Some(text) = cancel.as_str().filter(|text| is_whole_expression(text)) else {
        return false;
    };
    template_on(Event::Push, text.trim())
        .and_then(|parts| parts.into_iter().next())
        .is_some_and(|value| truthy(&value, Event::Push) == Some(false))
}

/// A concurrency's group: the `group` of a mapping, or the value itself.
fn group_of(concurrency: &Node) -> Option<&Node> {
    if concurrency.is_map() {
        concurrency.get("group")
    } else {
        Some(concurrency)
    }
}

/// What is wrong with one concurrency (top-level or a job's) on a workflow run on push.
fn push_concurrency_problems(concurrency: &Node) -> Vec<String> {
    let cancel = if concurrency.is_map() {
        concurrency.get("cancel-in-progress")
    } else {
        None
    };
    let mut problems = Vec::new();
    if !cancel_safe_on_push(cancel) {
        problems.push(format!(
            "cancel-in-progress `{}` is not false on a push, so it can cancel a push run",
            cancel.map_or_else(|| "undefined".to_owned(), Node::to_json)
        ));
    }
    if let Some(group) = group_of(concurrency).and_then(Node::as_str) {
        problems.extend(shared_push_group(group));
    }
    problems
}

fn named_group(concurrency: &Node) -> Option<&str> {
    group_of(concurrency)
        .and_then(Node::as_str)
        .filter(|group| !group.trim().is_empty())
}

fn check_triggers_and_concurrency(workflow: &YamlFile) -> Vec<FailureDetails> {
    let mut findings = Vec::new();
    let events = trigger_names(&workflow.root);
    let has = |event: &str| events.iter().any(|name| name == event);
    if has("pull_request_target") {
        findings.push(found(
            &PULL_REQUEST_TARGET,
            format!(
                "{}: the workflow runs on pull_request_target",
                workflow.at(&[Key::Name("on")])
            ),
            format!("on: {}", events.join(", ")),
        ));
    }
    let on_push = has("push");
    for (id, job) in jobs_of(workflow) {
        let Some(own) = job.get("concurrency").filter(|_| on_push) else {
            continue;
        };
        let mut problems = push_concurrency_problems(own);
        if named_group(own).is_none() {
            problems.insert(0, "the job's concurrency has no group".to_owned());
        }
        let place = workflow.at(&[Key::Name("jobs"), Key::Name(&id), Key::Name("concurrency")]);
        for problem in problems {
            findings.push(found(
                &CONCURRENCY,
                format!("{place}: job `{id}`: {problem}"),
                own.to_json(),
            ));
        }
    }
    let on_pull_request = has("pull_request") || has("pull_request_target");
    let Some(concurrency) = workflow.root.get("concurrency") else {
        if on_pull_request {
            findings.push(found(
                &CONCURRENCY,
                format!(
                    "{}: runs on pull requests but has no top-level concurrency",
                    workflow.path
                ),
                "no `concurrency:`, so a superseded run keeps its runner until it finishes",
            ));
        }
        return findings;
    };
    let mut problems = Vec::new();
    match named_group(concurrency) {
        None => problems.push("the concurrency has no group".to_owned()),
        Some(group) if !group.contains("github.workflow") => problems.push(format!(
            "group `{group}` does not name github.workflow, so another workflow can share it"
        )),
        Some(_) => {}
    }
    if on_push {
        problems.extend(push_concurrency_problems(concurrency));
    }
    let place = workflow.at(&[Key::Name("concurrency")]);
    for problem in problems {
        findings.push(found(
            &CONCURRENCY,
            format!("{place}: {problem}"),
            concurrency.to_json(),
        ));
    }
    findings
}

fn check_job_continue_on_error(workflow: &YamlFile) -> Vec<FailureDetails> {
    jobs_of(workflow)
        .into_iter()
        .filter_map(|(id, job)| {
            let value = job
                .get("continue-on-error")
                .filter(|value| continues_on_error(Some(value)))?;
            Some(found(
                &CONTINUE_ON_ERROR,
                format!(
                    "{}: job `{id}` sets continue-on-error, so its failure never fails the run",
                    workflow.at(&[
                        Key::Name("jobs"),
                        Key::Name(&id),
                        Key::Name("continue-on-error")
                    ])
                ),
                format!("continue-on-error: {}", value.to_json()),
            ))
        })
        .collect()
}

fn check_step_continue_on_error(site: &StepSite<'_>) -> Option<FailureDetails> {
    let value = site
        .step
        .get("continue-on-error")
        .filter(|value| continues_on_error(Some(value)))?;
    Some(found(
        &CONTINUE_ON_ERROR,
        format!(
            "{}: a step in {} sets continue-on-error, so its failure never fails the job",
            site.at("continue-on-error"),
            site.owner
        ),
        format!("continue-on-error: {}", value.to_json()),
    ))
}

fn check_shell(site: &StepSite<'_>, patterns: &Patterns) -> Option<FailureDetails> {
    let run = site.step.get("run")?.as_str()?;
    let shell = site
        .step
        .get("shell")
        .and_then(Node::as_str)
        .map(str::to_owned)
        .or_else(|| site.default_shell.clone());
    let first_word = shell.as_deref().map_or("bash", |shell| {
        shell.split_whitespace().next().unwrap_or_default()
    });
    // The basename, as Node's `path.basename` takes it: trailing slashes dropped first.
    let program = first_word
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();
    if !SH_FAMILY.contains(&program) {
        return None;
    }
    if shell
        .as_deref()
        .is_some_and(|shell| normalize(shell) == FAIL_CLOSED_SHELL)
    {
        return None;
    }
    let first = script_lines(run)
        .into_iter()
        .next()
        .map(|(_, text)| text)
        .unwrap_or_default();
    let fail_closed = patterns
        .set_fail_closed
        .captures(&first)
        .and_then(|captures| captures.get(1))
        .is_some_and(|flags| flags.as_str().contains('e') && flags.as_str().contains('u'));
    if fail_closed {
        return None;
    }
    Some(found(
        &SHELL,
        format!(
            "{}: a run step in {} does not fail closed",
            site.at("run"),
            site.owner
        ),
        format!(
            "shell: {}; first command: {first}",
            shell
                .as_deref()
                .unwrap_or("(the runner's default, bash -e {0})")
        ),
    ))
}

/// A run script's logical lines with the file line each starts on.
fn run_lines(site: &StepSite<'_>) -> Vec<(usize, String)> {
    let Some(run) = site.step.get("run").and_then(Node::as_str) else {
        return Vec::new();
    };
    let (line, block) = site.line_of("run");
    script_lines(run)
        .into_iter()
        .map(|(offset, text)| (if block { line + 1 + offset } else { line }, text))
        .collect()
}

/// The `|| <command that always succeeds>` in `text`, if any: `|| true`, `|| :`,
/// `|| exit 0` (each ending the command), or `|| echo`/`|| printf`.
fn swallowing_fallback(text: &str) -> Option<&str> {
    let mut search = 0;
    while let Some(offset) = text[search..].find("||") {
        let start = search + offset;
        let after = &text[start + 2..];
        let token = start + 2 + (after.len() - after.trim_start().len());
        let tail = &text[token..];
        let ends_command = |rest: &str| {
            let rest = rest.trim_start();
            rest.is_empty() || rest.starts_with([';', '&', '|', ')', '}', '#'])
        };
        let exit_zero = tail.strip_prefix("exit").and_then(|rest| {
            let spaces = rest.len() - rest.trim_start().len();
            (spaces > 0 && rest[spaces..].starts_with('0')).then_some(4 + spaces + 1)
        });
        let swallowing = [("true", Some(4)), (":", Some(1)), ("exit", exit_zero)]
            .into_iter()
            .find_map(|(word, length)| {
                let length = length?;
                (tail.starts_with(word) && ends_command(&tail[length..])).then_some(length)
            })
            .or_else(|| {
                ["echo", "printf"].into_iter().find_map(|word| {
                    let rest = tail.strip_prefix(word)?;
                    rest.chars()
                        .next()
                        .is_none_or(|c| c.is_whitespace() || ";&|)}".contains(c))
                        .then_some(word.len())
                })
            });
        if let Some(length) = swallowing {
            return Some(&text[start..token + length]);
        }
        search = start + 1;
    }
    None
}

/// Why one shell line fails open, or `None` when it does not.
fn fail_open_line(line: &str, patterns: &Patterns) -> Option<String> {
    let emptied = patterns.single_quoted.replace_all(line, "''");
    let text = patterns.trailing_comment.replace(&emptied, "");
    if let Some(fallback) = swallowing_fallback(&text) {
        return Some(format!(
            "`{}` swallows the failure of the command before it",
            normalize(fallback)
        ));
    }
    patterns
        .fail_open_split
        .split(&text)
        .find(|command| patterns.errexit_off.is_match(command.trim()))
        .map(|command| format!("`{}` turns off failing on an error", normalize(command)))
}

fn check_fail_open(site: &StepSite<'_>, patterns: &Patterns) -> Vec<FailureDetails> {
    let lines = run_lines(site);
    let mut findings = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let (line, mut text) = lines[index].clone();
        // Bash continues a line that ends in `||` onto the next one.
        while text.trim_end().ends_with("||") && index + 1 < lines.len() {
            index += 1;
            text = format!("{text} {}", lines[index].1);
        }
        index += 1;
        if let Some(problem) = fail_open_line(&text, patterns) {
            findings.push(found(
                &FAIL_OPEN,
                format!(
                    "{}:{line}: a run step in {} fails open: {problem}",
                    site.file.path, site.owner
                ),
                text,
            ));
        }
    }
    findings
}

/// The subcommand after a package manager's global options.
fn subcommand<'a>(words: &[&'a str], index: usize, wanted: &[&str]) -> Option<&'a str> {
    let mut at = index + 1;
    while let Some(flag) = words.get(at).filter(|word| word.starts_with('-')) {
        at += 1;
        // `--prefix ui install`: a flag's value, unless it is already the wanted subcommand.
        if let Some(next) = words.get(at)
            && !flag.contains('=')
            && !next.starts_with('-')
            && !wanted.contains(next)
        {
            at += 1;
        }
    }
    words.get(at).copied()
}

/// Why one shell command ignores the lockfile, or `None` when it does not.
fn unlocked_command(command: &str) -> Option<String> {
    let words: Vec<&str> = command.split_whitespace().collect();
    for (index, word) in words.iter().enumerate() {
        match *word {
            "npm" => {
                if let Some(sub) =
                    subcommand(&words, index, &NPM_INSTALL).filter(|sub| NPM_INSTALL.contains(sub))
                {
                    return Some(format!(
                        "`npm {sub}`, which installs from the registry with no lockfile or pin (pin the tool in mise.toml)"
                    ));
                }
            }
            "cargo" => {
                let start = if words
                    .get(index + 1)
                    .is_some_and(|next| next.starts_with('+'))
                {
                    index + 1
                } else {
                    index
                };
                let Some(sub) = subcommand(&words, start, &CARGO_LOCKED)
                    .filter(|sub| CARGO_LOCKED.contains(sub))
                else {
                    continue;
                };
                // Global flags before the subcommand count too: `cargo --locked build` is locked.
                let rest = &words[start + 1..];
                let args = rest
                    .iter()
                    .position(|word| *word == "--")
                    .map_or(rest, |separator| &rest[..separator]);
                if !args.contains(&"--locked") && !args.contains(&"--frozen") {
                    return Some(format!("`cargo {sub}` without --locked"));
                }
            }
            _ => {}
        }
    }
    None
}

fn check_locked(site: &StepSite<'_>, patterns: &Patterns) -> Vec<FailureDetails> {
    let mut findings = Vec::new();
    for (line, text) in run_lines(site) {
        for command in patterns.command_separators.split(&text) {
            if let Some(problem) = unlocked_command(command) {
                findings.push(found(
                    &UNLOCKED,
                    format!("{}:{line}: {problem} in {}", site.file.path, site.owner),
                    command.trim(),
                ));
            }
        }
    }
    findings
}

/// The lockfile rule over every justfile recipe line (an indented line, `\` continuations
/// joined, a leading `@`/`-` dropped), since a workflow's `just <recipe>` relies on it.
fn check_justfile_locked(root: &Path, patterns: &Patterns) -> Vec<FailureDetails> {
    let Some(text) = read_file(root, JUSTFILE) else {
        return Vec::new();
    };
    let lines: Vec<&str> = text.split('\n').collect();
    let mut findings = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let start = index;
        let mut line = lines[index].to_owned();
        index += 1;
        let indented = line.starts_with(char::is_whitespace) && !line.trim().is_empty();
        if !indented {
            continue;
        }
        while line.ends_with('\\') && index < lines.len() {
            line.pop();
            line.push(' ');
            line.push_str(lines[index]);
            index += 1;
        }
        let body = line.trim().trim_start_matches(['@', '-']);
        if body.starts_with('#') {
            continue;
        }
        for command in patterns.command_separators.split(body) {
            if let Some(problem) = unlocked_command(command) {
                findings.push(found(
                    &UNLOCKED,
                    format!("{JUSTFILE}:{}: {problem} in a recipe", start + 1),
                    command.trim(),
                ));
            }
        }
    }
    findings
}

fn check_steps(sites: &[StepSite<'_>], patterns: &Patterns) -> Vec<FailureDetails> {
    let mut findings = Vec::new();
    for site in sites {
        if let Some(uses) = site.step.get("uses").and_then(Node::as_str) {
            findings.extend(check_uses(
                site.file,
                site.line_of("uses").0,
                uses,
                patterns,
            ));
        }
        findings.extend(check_checkout(site));
        findings.extend(check_step_continue_on_error(site));
        findings.extend(check_shell(site, patterns));
        findings.extend(check_fail_open(site, patterns));
        findings.extend(check_locked(site, patterns));
    }
    findings
}

/// One bot commit prefix: where it is, which setting, and its value.
struct Prefix {
    place: String,
    setting: String,
    value: Option<String>,
}

/// A bot's prefixes, and the problems reading its config.
struct BotPrefixes {
    prefixes: Vec<Prefix>,
    problems: Vec<String>,
}

fn dependabot_prefixes(root: &Path) -> Option<BotPrefixes> {
    let path = DEPENDABOT_FILES
        .into_iter()
        .find(|path| read_file(root, path).is_some())?;
    let file = match read_yaml(root, path)? {
        Ok(file) => file,
        Err(problem) => {
            return Some(BotPrefixes {
                prefixes: Vec::new(),
                problems: vec![problem],
            });
        }
    };
    let mut prefixes = Vec::new();
    for (index, entry) in file
        .root
        .get("updates")
        .map(Node::items)
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        if !entry.is_map() {
            continue;
        }
        let ecosystem = entry
            .get("package-ecosystem")
            .and_then(Node::as_str)
            .map_or_else(|| format!("updates[{index}]"), str::to_owned);
        let message = entry
            .get("commit-message")
            .filter(|message| message.is_map());
        let place = |key: &str| {
            file.at(&[
                Key::Name("updates"),
                Key::Index(index),
                Key::Name("commit-message"),
                Key::Name(key),
            ])
        };
        let value = |key: &str| message.and_then(|message| message.get(key));
        prefixes.push(Prefix {
            place: place("prefix"),
            setting: format!("Dependabot `{ecosystem}` commit-message.prefix"),
            value: value("prefix").and_then(Node::as_str).map(str::to_owned),
        });
        if let Some(development) = value("prefix-development") {
            prefixes.push(Prefix {
                place: place("prefix-development"),
                setting: format!("Dependabot `{ecosystem}` commit-message.prefix-development"),
                value: development.as_str().map(str::to_owned),
            });
        }
    }
    Some(BotPrefixes {
        prefixes,
        problems: Vec::new(),
    })
}

fn renovate_prefixes(root: &Path) -> Option<BotPrefixes> {
    let (path, config) = match read_renovate(root)? {
        Renovate::Problem { problem, .. } => {
            return Some(BotPrefixes {
                prefixes: Vec::new(),
                problems: vec![problem],
            });
        }
        Renovate::Config { path, config, .. } => (path, config),
    };
    let text = |value: Option<&serde_json::Value>| {
        value.and_then(serde_json::Value::as_str).map(str::to_owned)
    };
    let mut prefixes = vec![Prefix {
        place: path.clone(),
        setting: "Renovate commitMessagePrefix".to_owned(),
        value: text(config.get("commitMessagePrefix")),
    }];
    if let Some(serde_json::Value::Array(rules)) = config.get("packageRules") {
        for (index, rule) in rules.iter().enumerate() {
            if let Some(prefix) = rule.get("commitMessagePrefix") {
                prefixes.push(Prefix {
                    place: path.clone(),
                    setting: format!("Renovate packageRules[{index}].commitMessagePrefix"),
                    value: text(Some(prefix)),
                });
            }
        }
    }
    Some(BotPrefixes {
        prefixes,
        problems: Vec::new(),
    })
}

fn check_bot_prefixes(
    root: &Path,
    workflows: &[YamlFile],
    patterns: &Patterns,
) -> Vec<FailureDetails> {
    let bots: Vec<BotPrefixes> = [dependabot_prefixes(root), renovate_prefixes(root)]
        .into_iter()
        .flatten()
        .collect();
    if bots.is_empty() {
        return Vec::new();
    }
    let mut findings: Vec<FailureDetails> = bots
        .iter()
        .flat_map(|bot| &bot.problems)
        .map(|problem| {
            found(
                &BOT_PREFIX,
                "a dependency bot's config cannot be read".to_owned(),
                problem.clone(),
            )
        })
        .collect();
    let checks: Vec<TitleCheck> = title_checks(workflows);
    if checks.is_empty() {
        findings.push(found(
            &BOT_PREFIX,
            "no workflow step uses amannn/action-semantic-pull-request, so no bot prefix can be checked".to_owned(),
            format!("no {TITLE_ACTION}… step under {WORKFLOWS_DIR}/"),
        ));
        return findings;
    }
    for prefix in bots.iter().flat_map(|bot| &bot.prefixes) {
        let Some(value) = prefix
            .value
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        else {
            findings.push(found(
                &BOT_PREFIX,
                format!("{}: {} is not set", prefix.place, prefix.setting),
                "no prefix, so the bot titles its PRs `Bump …`",
            ));
            continue;
        };
        let kind = patterns
            .prefix_type
            .find(value.trim())
            .map(|kind| kind.as_str());
        for title in checks.iter().filter(|title| {
            kind.is_none_or(|kind| !title.types.iter().any(|accepted| accepted == kind))
        }) {
            findings.push(found(
                &BOT_PREFIX,
                format!(
                    "{}: {} `{value}` is not a type the title check at {} accepts",
                    prefix.place, prefix.setting, title.place
                ),
                format!(
                    "type {}; accepted: {}",
                    kind.map_or_else(|| "(none)".to_owned(), |kind| format!("`{kind}`")),
                    title.types.join(", ")
                ),
            ));
        }
    }
    findings
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let patterns = match Patterns::new() {
        Ok(patterns) => patterns,
        Err(invalid) => return vec![invalid],
    };
    let (workflows, unreadable) = read_workflows(input.root);
    let (actions, unreadable_actions) = read_actions(input.root, &workflows);
    let mut findings = unreadable;
    findings.extend(unreadable_actions);
    for workflow in &workflows {
        findings.extend(check_job_calls(workflow, &patterns));
        findings.extend(check_timeouts(workflow));
        findings.extend(check_permissions(workflow));
        findings.extend(check_triggers_and_concurrency(workflow));
        findings.extend(check_job_continue_on_error(workflow));
        findings.extend(check_steps(&workflow_steps(workflow), &patterns));
    }
    for action in &actions {
        findings.extend(check_steps(&action_steps(action), &patterns));
    }
    findings.extend(check_justfile_locked(input.root, &patterns));
    findings.extend(check_bot_prefixes(input.root, &workflows, &patterns));
    findings
}

#[cfg(test)]
mod tests {
    use super::{Patterns, fail_open_line, run, unlocked_command};
    use crate::check_harness::test_support::{codes, run_at, summaries};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const SHA: &str = "3d3c42e5aac5ba805825da76410c181273ba90b1";

    fn ci_text() -> String {
        format!(
            "name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\npermissions:\n  contents: read\nconcurrency:\n  group: ${{{{ github.workflow }}}}-${{{{ github.event_name == 'pull_request' && github.ref || github.sha }}}}\n  cancel-in-progress: ${{{{ github.event_name == 'pull_request' }}}}\ndefaults:\n  run:\n    shell: bash --noprofile --norc -euo pipefail {{0}}\njobs:\n  build:\n    name: Build\n    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@{SHA} # v7.0.1\n        with:\n          persist-credentials: false\n      - uses: ./.github/actions/local\n      - run: cargo fetch --locked\n      - run: |\n          cargo test --locked -p core\n          cargo clippy --locked --all-targets -- -D warnings\n          cargo fmt --all --check\n      - run: just test-core\n"
        )
    }

    fn title_text() -> String {
        format!(
            "name: Check PR title\non:\n  pull_request:\n    types: [opened, edited]\npermissions: {{}}\nconcurrency:\n  group: ${{{{ github.workflow }}}}-${{{{ github.ref }}}}\n  cancel-in-progress: true\njobs:\n  main:\n    name: Validate PR title\n    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n    permissions:\n      pull-requests: read\n    steps:\n      - uses: amannn/action-semantic-pull-request@{SHA} # v6.1.1\n        with:\n          types: |\n            feat\n            fix\n            ci\n            deps\n"
        )
    }

    const DEPENDABOT: &str = "version: 2\nupdates:\n  - package-ecosystem: cargo\n    directory: /\n    commit-message:\n      prefix: \"deps:\"\n  - package-ecosystem: github-actions\n    directory: /\n    commit-message:\n      prefix: \"ci:\"\n      prefix-development: \"deps\"\n";
    const RENOVATE: &str = r#"{"commitMessagePrefix":"deps:"}"#;
    const CI: &str = ".github/workflows/ci.yml";
    const TITLE: &str = ".github/workflows/check-pr-title.yml";

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<FailureDetails> {
        let ci = ci_text();
        let title = title_text();
        let mut files: Vec<(&str, Option<&str>)> = vec![
            (CI, Some(&ci)),
            (TITLE, Some(&title)),
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

    /// The base ci.yml with `from` replaced by `to` (which must change it).
    fn ci(from: &str, to: &str) -> String {
        let base = ci_text();
        assert!(base.contains(from), "the base ci.yml has no {from:?}");
        base.replacen(from, to, 1)
    }

    fn ci_codes(from: &str, to: &str) -> Vec<String> {
        codes(&check(&[(CI, Some(&ci(from, to)))]))
    }

    fn no_defaults(text: &str) -> String {
        text.replacen(
            "defaults:\n  run:\n    shell: bash --noprofile --norc -euo pipefail {0}\n",
            "",
            1,
        )
    }

    fn concurrency_block(text: &str) -> (usize, usize) {
        let start = text.find("concurrency:\n").expect("block");
        let mut end = start + "concurrency:\n".len();
        while text[end..].starts_with("  ") {
            end += text[end..].find('\n').expect("line") + 1;
        }
        (start, end)
    }

    #[test]
    fn passes_a_workflow_set_that_satisfies_every_rule() {
        assert_eq!(check(&[]), []);
        let none = [
            (CI, None),
            (TITLE, None),
            (".github/dependabot.yml", None),
            (".github/renovate.json", None),
        ];
        assert_eq!(check(&none), []);
    }

    #[test]
    fn reports_a_workflow_it_cannot_read() {
        for (path, text) in [
            (".github/workflows/bad.yml", "jobs: [\n"),
            (".github/workflows/bad.yaml", "name: x\non: push\n"),
            (".github/workflows/bad.yml", "- a\n"),
        ] {
            assert_eq!(
                codes(&check(&[(path, Some(text))])),
                ["ERR_CHECK_WORKFLOW_UNREADABLE"],
                "{text}"
            );
        }
    }

    #[test]
    fn requires_full_sha_pins_with_a_version_comment() {
        let checkout = format!("actions/checkout@{SHA} # v7.0.1");
        assert_eq!(
            ci_codes(&checkout, "actions/checkout@v7 # v7.0.1"),
            ["ERR_CHECK_WORKFLOW_UNPINNED"]
        );
        assert_eq!(
            ci_codes(
                &format!("actions/checkout@{SHA}"),
                &format!("actions/checkout@{}", &SHA[..12])
            ),
            ["ERR_CHECK_WORKFLOW_UNPINNED"]
        );
        assert_eq!(
            ci_codes("uses: ./.github/actions/local", "uses: docker://alpine:3"),
            ["ERR_CHECK_WORKFLOW_UNPINNED"]
        );
        let found = check(&[(CI, Some(&ci(" # v7.0.1", "")))]);
        assert_eq!(codes(&found), ["ERR_CHECK_WORKFLOW_PIN_COMMENT"]);
        assert!(found[0].summary.contains(".github/workflows/ci.yml:22"));
        assert_eq!(
            ci_codes("# v7.0.1", "# v7"),
            ["ERR_CHECK_WORKFLOW_PIN_COMMENT"]
        );
        let reuse = format!(
            "{}  reuse:\n    uses: org/repo/.github/workflows/x.yml@main\n    permissions:\n      contents: read\n",
            ci_text()
        );
        assert_eq!(
            codes(&check(&[(CI, Some(&reuse))])),
            ["ERR_CHECK_WORKFLOW_UNPINNED"]
        );
        let reuse = format!(
            "{}  reuse:\n    uses: org/repo/.github/workflows/x.yml@{SHA} # v1.2.3\n    permissions:\n      contents: read\n",
            ci_text()
        );
        assert_eq!(check(&[(CI, Some(&reuse))]), []);
    }

    #[test]
    fn requires_timeouts_and_narrow_permissions() {
        assert_eq!(
            ci_codes("    timeout-minutes: 10\n", ""),
            ["ERR_CHECK_WORKFLOW_TIMEOUT"]
        );
        assert_eq!(
            ci_codes("permissions:\n  contents: read\nconcurrency", "concurrency"),
            ["ERR_CHECK_WORKFLOW_PERMISSIONS"]
        );
        for to in [
            "permissions:\n  contents: write\n",
            "permissions:\n  contents: read\n  issues: read\n",
            "permissions: read-all\n",
        ] {
            assert_eq!(
                ci_codes("permissions:\n  contents: read\n", to),
                ["ERR_CHECK_WORKFLOW_PERMISSIONS"],
                "{to}"
            );
        }
        assert_eq!(
            ci_codes("permissions:\n  contents: read\n", "permissions: {}\n"),
            Vec::<String>::new()
        );
        assert_eq!(
            ci_codes(
                "    permissions:\n      contents: read\n    steps",
                "    steps"
            ),
            ["ERR_CHECK_WORKFLOW_JOB_PERMISSIONS"]
        );
        let found = check(&[(
            CI,
            Some(&ci(
                "    permissions:\n      contents: read\n    steps",
                "    permissions: write-all\n    steps",
            )),
        )]);
        assert_eq!(codes(&found), ["ERR_CHECK_WORKFLOW_JOB_PERMISSIONS"]);
        assert_eq!(found[0].actual, "permissions: \"write-all\"");
    }

    #[test]
    fn requires_checkout_without_persisted_credentials() {
        assert_eq!(
            ci_codes("        with:\n          persist-credentials: false\n", ""),
            ["ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS"]
        );
        assert_eq!(
            ci_codes("persist-credentials: false", "persist-credentials: true"),
            ["ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS"]
        );
        assert_eq!(
            ci_codes(
                "persist-credentials: false",
                "persist-credentials: \"false\""
            ),
            Vec::<String>::new()
        );
    }

    #[test]
    fn requires_a_concurrency_that_never_cancels_a_push_run() {
        let base = ci_text();
        let (start, end) = concurrency_block(&base);
        let without = format!("{}{}", &base[..start], &base[end..]);
        assert_eq!(
            codes(&check(&[(CI, Some(&without))])),
            ["ERR_CHECK_WORKFLOW_CONCURRENCY"]
        );
        let title = title_text();
        let no_group = title.replacen("  group: ${{ github.workflow }}-${{ github.ref }}\n", "", 1);
        assert_eq!(
            codes(&check(&[(TITLE, Some(&no_group))])),
            ["ERR_CHECK_WORKFLOW_CONCURRENCY"]
        );
        let other = title.replacen(
            "${{ github.workflow }}-${{ github.ref }}",
            "${{ github.ref }}",
            1,
        );
        assert_eq!(
            codes(&check(&[(TITLE, Some(&other))])),
            ["ERR_CHECK_WORKFLOW_CONCURRENCY"]
        );
        let (start, end) = concurrency_block(&title);
        let inline = format!(
            "{}concurrency: ${{{{ github.workflow }}}}-${{{{ github.ref }}}}\n{}",
            &title[..start],
            &title[end..]
        );
        assert_eq!(check(&[(TITLE, Some(&inline))]), []);
        let cancel = "cancel-in-progress: ${{ github.event_name == 'pull_request' }}";
        assert_eq!(
            ci_codes(cancel, "cancel-in-progress: true"),
            ["ERR_CHECK_WORKFLOW_CONCURRENCY"]
        );
        assert_eq!(
            ci_codes(
                cancel,
                "cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}"
            ),
            ["ERR_CHECK_WORKFLOW_CONCURRENCY"]
        );
        assert_eq!(
            ci_codes(cancel, "cancel-in-progress: x-${{ false }}"),
            ["ERR_CHECK_WORKFLOW_CONCURRENCY"]
        );
        assert_eq!(
            ci_codes(
                cancel,
                "cancel-in-progress: ${{ github.event_name != 'push' }}"
            ),
            Vec::<String>::new()
        );
        let group = "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}";
        assert_eq!(
            ci_codes(group, "group: ${{ github.workflow }}-${{ github.ref }}"),
            ["ERR_CHECK_WORKFLOW_CONCURRENCY"]
        );
        let found = check(&[(
            CI,
            Some(&ci(
                group,
                "group: ${{ github.workflow }}-${{ format('{0}', github.sha) }}",
            )),
        )]);
        assert_eq!(found.len(), 1);
        assert!(
            found[0]
                .summary
                .contains("cannot be evaluated for a push run")
        );
        let scheduled = "name: Weekly\non:\n  schedule:\n    - cron: \"0 0 * * 1\"\npermissions:\n  contents: read\njobs:\n  scan:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions:\n      contents: read\n    steps:\n      - run: |\n          # comment first\n          set -euo pipefail\n          echo ok | cat\n";
        assert_eq!(
            check(&[(".github/workflows/weekly.yml", Some(scheduled))]),
            []
        );
    }

    #[test]
    fn checks_each_job_concurrency_on_a_push_workflow() {
        let job = |block: &str| {
            ci(
                "    timeout-minutes: 10\n",
                &format!("    timeout-minutes: 10\n{block}"),
            )
        };
        let keyed = job(
            "    concurrency:\n      group: deploy-${{ github.sha }}\n      cancel-in-progress: false\n",
        );
        assert_eq!(check(&[(CI, Some(&keyed))]), []);
        let found = check(&[(
            CI,
            Some(&job("    concurrency:\n      cancel-in-progress: false\n")),
        )]);
        assert_eq!(found.len(), 1);
        assert!(found[0].summary.contains("no group"));
        let found = check(&[(
            CI,
            Some(&job(
                "    concurrency:\n      group: probe-main\n      cancel-in-progress: true\n",
            )),
        )]);
        assert_eq!(codes(&found), ["ERR_CHECK_WORKFLOW_CONCURRENCY"; 2]);
        assert_eq!(
            codes(&check(&[(CI, Some(&job("    concurrency: deploy\n")))])),
            ["ERR_CHECK_WORKFLOW_CONCURRENCY"]
        );
        let title = title_text().replacen("    timeout-minutes: 10\n", "    timeout-minutes: 10\n    concurrency:\n      group: probe\n      cancel-in-progress: true\n", 1);
        assert_eq!(check(&[(TITLE, Some(&title))]), []);
    }

    #[test]
    fn rejects_pull_request_target_in_any_shape_of_on() {
        assert_eq!(
            ci_codes(
                "  pull_request:\n",
                "  pull_request:\n  pull_request_target:\n"
            ),
            ["ERR_CHECK_WORKFLOW_PULL_REQUEST_TARGET"]
        );
        let title = title_text().replacen(
            "on:\n  pull_request:\n    types: [opened, edited]\n",
            "on: [pull_request, pull_request_target]\n",
            1,
        );
        assert_eq!(
            codes(&check(&[(TITLE, Some(&title))])),
            ["ERR_CHECK_WORKFLOW_PULL_REQUEST_TARGET"]
        );
    }

    #[test]
    fn requires_fail_closed_shells() {
        assert_eq!(
            codes(&check(&[(CI, Some(&no_defaults(&ci_text())))])),
            ["ERR_CHECK_WORKFLOW_SHELL"; 3]
        );
        let with_set = no_defaults(&ci_text())
            .replacen("run: cargo fetch", "run: set -euo pipefail; cargo fetch", 1)
            .replacen("run: |\n", "run: |\n          set -euo pipefail\n", 1)
            .replacen(
                "run: just test-core",
                "run: |\n          set -Eeuo pipefail\n          just test-core",
                1,
            );
        assert_eq!(check(&[(CI, Some(&with_set))]), []);
        assert_eq!(
            ci_codes("-euo pipefail {0}", "-eo pipefail {0}"),
            ["ERR_CHECK_WORKFLOW_SHELL"; 3]
        );
        assert_eq!(
            ci_codes(
                "      - run: just test-core\n",
                "      - run: just test-core\n        shell: bash\n"
            ),
            ["ERR_CHECK_WORKFLOW_SHELL"]
        );
        assert_eq!(
            ci_codes(
                "    timeout-minutes: 10\n",
                "    timeout-minutes: 10\n    defaults:\n      run:\n        shell: sh\n"
            ),
            ["ERR_CHECK_WORKFLOW_SHELL"; 3]
        );
        let other_shells = no_defaults(&ci_text())
            .replacen(
                "run: cargo fetch --locked",
                "run: cargo fetch --locked\n        shell: pwsh",
                1,
            )
            .replacen(
                "run: just test-core",
                "run: just test-core\n        shell: /usr/bin/python",
                1,
            )
            .replacen("run: |\n", "run: |\n          set -euo pipefail\n", 1);
        assert_eq!(check(&[(CI, Some(&other_shells))]), []);
        assert_eq!(
            ci_codes(
                "      - run: just test-core\n",
                "      - run: just test-core\n        shell: /bin/bash/\n"
            ),
            ["ERR_CHECK_WORKFLOW_SHELL"]
        );
        let job_default = no_defaults(&ci_text()).replacen(
            "    timeout-minutes: 10\n",
            "    timeout-minutes: 10\n    defaults:\n      run:\n        shell: bash --noprofile --norc -euo pipefail {0}\n",
            1,
        );
        assert_eq!(check(&[(CI, Some(&job_default))]), []);
    }

    #[test]
    fn rejects_continue_on_error_other_than_false() {
        let step = "      - run: just test-core\n";
        assert_eq!(
            ci_codes(step, &format!("{step}        continue-on-error: false\n")),
            Vec::<String>::new()
        );
        assert_eq!(
            ci_codes(
                step,
                &format!("{step}        continue-on-error: ${{{{ matrix.experimental }}}}\n")
            ),
            ["ERR_CHECK_WORKFLOW_CONTINUE_ON_ERROR"]
        );
        let found = check(&[(
            CI,
            Some(&ci(
                "    timeout-minutes: 10\n",
                "    timeout-minutes: 10\n    continue-on-error: true\n",
            )),
        )]);
        assert_eq!(codes(&found), ["ERR_CHECK_WORKFLOW_CONTINUE_ON_ERROR"]);
        assert_eq!(found[0].actual, "continue-on-error: true");
    }

    #[test]
    fn flags_each_fail_open_line_and_leaves_fail_closed_ones() {
        let patterns = Patterns::new().expect("patterns");
        for line in [
            "just test-platform || true",
            "just test-platform || :",
            "just test-platform || exit 0",
            "just test-platform ||   exit  0 ;",
            "just test-platform || echo skipped",
            "just test-platform || printf 'x'",
            "x=\"$(just test-platform || true)\"",
            "just a || true; just b",
            "set +e",
            "set -x +u",
            "set +o pipefail",
            "if x; then set +e; fi",
            "just a ||| true",
        ] {
            assert!(fail_open_line(line, &patterns).is_some(), "{line}");
        }
        for line in [
            "just test-platform || { echo failed; exit 1; }",
            "echo 'run a || true'",
            "just test-platform # not || true",
            "set +x",
            "set -euo pipefail",
            "[[ -n \"$a\" || -n \"$b\" ]]",
            "just test-platform || truer",
            "just test-platform || exit 1",
            "just test-platform || exit",
            "just test-platform || echoes",
        ] {
            assert_eq!(fail_open_line(line, &patterns), None, "{line}");
        }
        assert_eq!(
            fail_open_line("a || true", &patterns).as_deref(),
            Some("`|| true` swallows the failure of the command before it")
        );
        assert_eq!(
            ci_codes(
                "cargo fmt --all --check\n",
                "cargo fmt --all --check ||\n            true\n"
            ),
            ["ERR_CHECK_WORKFLOW_FAIL_OPEN"]
        );
        // `then` and `do` split at ASCII word boundaries, so `\u{e9}then` still starts one.
        let text = ci(
            "cargo fmt --all --check\n",
            "cargo fmt --all --check\n          if true; \u{e9}then set +e; fi\n",
        );
        let line = text
            .lines()
            .position(|line| line.contains("\u{e9}then"))
            .expect("the line")
            + 1;
        let found = check(&[(CI, Some(&text))]);
        assert_eq!(codes(&found), ["ERR_CHECK_WORKFLOW_FAIL_OPEN"]);
        assert!(
            found[0].summary.starts_with(&format!("{CI}:{line}: ")),
            "{}",
            found[0].summary
        );
        assert!(fail_open_line("for x in a; \u{e9}do set +e; done", &patterns).is_some());
    }

    #[test]
    fn requires_locked_builds_and_no_npm_install() {
        assert_eq!(
            ci_codes("cargo fetch --locked", "cargo fetch"),
            ["ERR_CHECK_WORKFLOW_UNLOCKED"]
        );
        assert_eq!(
            ci_codes("cargo fetch --locked", "npm i --prod"),
            ["ERR_CHECK_WORKFLOW_UNLOCKED"]
        );
        let found = check(&[(
            CI,
            Some(&ci("cargo test --locked -p core", "cargo test -p core")),
        )]);
        assert_eq!(codes(&found), ["ERR_CHECK_WORKFLOW_UNLOCKED"]);
        assert!(found[0].summary.contains("ci.yml:28"));
        assert_eq!(
            ci_codes(
                "cargo clippy --locked --all-targets -- -D warnings",
                "cargo clippy --all-targets -- --locked"
            ),
            ["ERR_CHECK_WORKFLOW_UNLOCKED"]
        );
        assert_eq!(
            ci_codes(
                "cargo fmt --all --check",
                "cargo fmt --all --check && cargo +nightly llvm-cov \\\n            nextest"
            ),
            ["ERR_CHECK_WORKFLOW_UNLOCKED"]
        );
        assert_eq!(
            ci_codes(
                "cargo fmt --all --check",
                "cargo fmt --all --check\n          cargo run --frozen -p x\n          cargo deny --locked check"
            ),
            Vec::<String>::new()
        );
        for (command, unlocked) in [
            ("npm -g install left-pad", true),
            ("npm --prefix=ui i", true),
            ("npm --prefix ui install", true),
            ("npm --silent run lint", false),
            ("npm ci", false),
            ("npm --prefix ui add left-pad", true),
            ("cargo shear --locked", false),
            ("cargo deny --locked check", false),
            ("cargo", false),
            ("cargo fmt", false),
            ("cargo -q build", true),
            ("cargo -Zfoo build", true),
            ("cargo --color always build", true),
            ("cargo +nightly -q test", true),
            ("cargo --locked build", false),
            ("cargo -q --frozen build", false),
            ("cargo --color always build --locked", false),
        ] {
            assert_eq!(unlocked_command(command).is_some(), unlocked, "{command}");
        }
    }

    #[test]
    fn reads_justfile_recipe_lines() {
        let justfile = "set shell := [\"bash\", \"-c\"]\n\nbuild:\n    # cargo build\n    @cargo build \\\n      --release\n    -cargo test --locked\n";
        let found = check(&[("justfile", Some(justfile))]);
        assert_eq!(codes(&found), ["ERR_CHECK_WORKFLOW_UNLOCKED"]);
        assert!(found[0].summary.contains("justfile:5"));
    }

    #[test]
    fn applies_the_step_rules_to_composite_actions() {
        let action = "name: Setup\ndescription: x\nruns:\n  using: composite\n  steps:\n    - uses: actions/checkout@v4\n    - run: cargo fetch\n      shell: bash\n";
        let all = [
            "ERR_CHECK_WORKFLOW_UNPINNED",
            "ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS",
            "ERR_CHECK_WORKFLOW_SHELL",
            "ERR_CHECK_WORKFLOW_UNLOCKED",
        ];
        assert_eq!(
            codes(&check(&[(
                ".github/actions/setup/action.yml",
                Some(action)
            )])),
            all
        );
        let found = check(&[
            (
                CI,
                Some(&ci("uses: ./.github/actions/local", "uses: ./tools/setup/")),
            ),
            ("tools/setup/action.yaml", Some(action)),
        ]);
        assert!(found[0].summary.contains("tools/setup/action.yaml"));
        assert_eq!(found.len(), 4);
        assert_eq!(
            ci_codes("uses: ./.github/actions/local", "uses: ./../elsewhere"),
            Vec::<String>::new()
        );
        assert_eq!(
            ci_codes("uses: ./.github/actions/local", "uses: ./"),
            Vec::<String>::new()
        );
        let node = "name: n\nruns:\n  using: node24\n  main: index.js\n";
        assert_eq!(
            check(&[(".github/actions/node/action.yml", Some(node))]),
            []
        );
        for (path, text) in [
            (".github/actions/a/action.yml", "runs: [\n"),
            (".github/actions/b/action.yaml", "- x\n"),
            (".github/actions/c/action.yml", "name: c\n"),
        ] {
            assert_eq!(
                codes(&check(&[(path, Some(text))])),
                ["ERR_CHECK_WORKFLOW_UNREADABLE"],
                "{text}"
            );
        }
    }

    #[test]
    fn requires_bot_prefixes_a_title_check_accepts() {
        let prefix = |from: &str, to: &str| {
            codes(&check(&[(
                ".github/dependabot.yml",
                Some(&DEPENDABOT.replacen(from, to, 1)),
            )]))
        };
        assert_eq!(
            prefix("prefix: \"ci:\"", "prefix: \"build(deps):\""),
            ["ERR_CHECK_WORKFLOW_BOT_PREFIX"]
        );
        assert_eq!(
            prefix("    commit-message:\n      prefix: \"deps:\"\n", ""),
            ["ERR_CHECK_WORKFLOW_BOT_PREFIX"]
        );
        assert_eq!(
            prefix(
                "prefix-development: \"deps\"",
                "prefix-development: \"[dev]\""
            ),
            ["ERR_CHECK_WORKFLOW_BOT_PREFIX"]
        );
        let found = check(&[(
            ".github/dependabot.yml",
            Some(&DEPENDABOT.replacen(
                "prefix-development: \"deps\"",
                "prefix-development: \"[dev]\"",
                1,
            )),
        )]);
        assert_eq!(
            found[0].actual,
            "type (none); accepted: feat, fix, ci, deps"
        );
        assert_eq!(
            codes(&check(&[(".github/renovate.json", Some("{}"))])),
            ["ERR_CHECK_WORKFLOW_BOT_PREFIX"]
        );
        let rules = r#"{"commitMessagePrefix":"deps:","packageRules":[{"commitMessagePrefix":"chore:"},{"matchManagers":["mise"]}]}"#;
        assert_eq!(
            codes(&check(&[
                ("renovate.json", Some(rules)),
                (".github/renovate.json", None)
            ])),
            ["ERR_CHECK_WORKFLOW_BOT_PREFIX"]
        );
        assert_eq!(
            codes(&check(&[(".github/renovate.json", Some("{ // json5\n}"))])),
            ["ERR_CHECK_WORKFLOW_BOT_PREFIX"]
        );
        for path in [
            "renovate.json5",
            ".github/renovate.json5",
            ".renovaterc.json5",
        ] {
            let found = check(&[(".github/renovate.json", None), (path, Some("{}\n"))]);
            assert_eq!(codes(&found), ["ERR_CHECK_WORKFLOW_BOT_PREFIX"]);
            assert!(found[0].actual.contains(path));
        }
        assert_eq!(
            codes(&check(&[(".github/dependabot.yml", Some("updates: [\n"))])),
            ["ERR_CHECK_WORKFLOW_BOT_PREFIX"]
        );
        let found = check(&[(TITLE, None)]);
        assert_eq!(found.len(), 1);
        assert!(
            summaries(&found)[0]
                .contains("no workflow step uses amannn/action-semantic-pull-request")
        );
        let defaults = title_text().replacen("        with:\n          types: |\n            feat\n            fix\n            ci\n            deps\n", "", 1);
        assert_eq!(
            codes(&check(&[(TITLE, Some(&defaults))])),
            ["ERR_CHECK_WORKFLOW_BOT_PREFIX"; 3]
        );
        let none = [
            (".github/dependabot.yml", None),
            (".github/renovate.json", None),
            (TITLE, None),
        ];
        assert_eq!(check(&none), []);
    }
}
