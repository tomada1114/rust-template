//! What the workflow checks share: reading YAML with line numbers, the workflow files and
//! their jobs and steps, the repository's own composite actions, the Dependabot and
//! Renovate file locations and the Renovate config, the PR-title checks' accepted types,
//! and a run script's logical lines.

use std::path::Path;

use super::yaml::{self, Key, Keys, Node, Yaml};
use super::{finding, has_extension, list_dir, read_file};
use crate::fail::FailureDetails;

const WORKFLOWS_DIR: &str = ".github/workflows";
const ACTIONS_DIR: &str = ".github/actions";
const ACTION_FILES: [&str; 2] = ["action.yml", "action.yaml"];

pub(super) const DEPENDABOT_FILES: [&str; 2] =
    [".github/dependabot.yml", ".github/dependabot.yaml"];
/// Every file name Renovate reads its config from, in the order it looks for them.
const RENOVATE_FILES: [&str; 9] = [
    "renovate.json",
    "renovate.json5",
    ".github/renovate.json",
    ".github/renovate.json5",
    ".gitlab/renovate.json",
    ".gitlab/renovate.json5",
    ".renovaterc",
    ".renovaterc.json",
    ".renovaterc.json5",
];

/// A Renovate config read as JSON, or why it could not be.
pub(super) enum Renovate {
    Config {
        path: String,
        text: String,
        config: serde_json::Map<String, serde_json::Value>,
    },
    Problem {
        path: String,
        problem: String,
    },
}

/// The Renovate config under the root: the first of [`RENOVATE_FILES`] present, parsed as
/// JSON, or `None` when there is none. A JSON5 file anywhere in the list is a problem,
/// never a skip: no JSON5 parser is a dependency, so the cooldown, prefix, and label rules
/// would otherwise pass on a config they never read.
pub(super) fn read_renovate(root: &Path) -> Option<Renovate> {
    let present: Vec<&str> = RENOVATE_FILES
        .into_iter()
        .filter(|path| read_file(root, path).is_some())
        .collect();
    if let Some(json5) = present.iter().find(|path| has_extension(path, &["json5"])) {
        return Some(Renovate::Problem {
            path: (*json5).to_owned(),
            problem: format!(
                "{json5}: a JSON5 Renovate config, which the harness checks cannot read (rename it to renovate.json and write it as JSON)"
            ),
        });
    }
    let path = (*present.first()?).to_owned();
    let text = read_file(root, &path).unwrap_or_default();
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Object(config)) => Some(Renovate::Config { path, text, config }),
        Ok(_) => Some(Renovate::Config {
            path,
            text,
            config: serde_json::Map::new(),
        }),
        Err(error) => Some(Renovate::Problem {
            problem: format!("{path}: not JSON ({error})"),
            path,
        }),
    }
}

/// Whether a `continue-on-error:` value lets a failure pass (anything but absent or false).
pub(super) fn continues_on_error(value: Option<&Node>) -> bool {
    value.is_some_and(|value| value.as_bool() != Some(false) && value.as_str() != Some("false"))
}

/// A parsed YAML file: its path, its lines, and its document.
pub(super) struct YamlFile {
    pub(super) path: String,
    pub(super) lines: Vec<String>,
    pub(super) root: Node,
}

impl YamlFile {
    /// `path:line` of a key path.
    pub(super) fn at(&self, keys: &[Key<'_>]) -> String {
        format!("{}:{}", self.path, self.root.locate(keys).line)
    }

    /// The 1-based line a key path sits on.
    pub(super) fn line(&self, keys: &[Key<'_>]) -> usize {
        self.root.locate(keys).line
    }
}

/// Parse a YAML file under the root: `None` when absent, `Err` with the parse error.
pub(super) fn read_yaml(root: &Path, path: &str) -> Option<Result<YamlFile, String>> {
    let text = read_file(root, path)?;
    Some(
        yaml::parse(&text, Keys::Unique)
            .map(|document| YamlFile {
                path: path.to_owned(),
                lines: text.split('\n').map(str::to_owned).collect(),
                root: document.root,
            })
            .map_err(|error| format!("{path}:{}: {}", error.line, error.message)),
    )
}

/// The workflow files under the root, as repository-relative paths, sorted.
fn workflow_paths(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = list_dir(root, WORKFLOWS_DIR)
        .into_iter()
        .map(|(name, _)| name)
        .filter(|name| {
            std::path::Path::new(name)
                .extension()
                .is_some_and(|extension| extension == "yml" || extension == "yaml")
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| format!("{WORKFLOWS_DIR}/{name}"))
        .collect()
}

const UNREADABLE: &str = "ERR_CHECK_WORKFLOW_UNREADABLE";
const UNREADABLE_NEXT: &str =
    "fix the file so `mise exec -- actionlint` accepts it, then rerun the check";

/// Every workflow parsed, and a finding for each one that cannot be read.
pub(super) fn read_workflows(root: &Path) -> (Vec<YamlFile>, Vec<FailureDetails>) {
    let mut workflows = Vec::new();
    let mut unreadable = Vec::new();
    for path in workflow_paths(root) {
        let problem = match read_yaml(root, &path) {
            None => continue,
            Some(Err(problem)) => problem,
            Some(Ok(file)) if !file.root.is_map() => {
                format!("{path}: the document is not a mapping")
            }
            Some(Ok(file)) if !file.root.get("jobs").is_some_and(Node::is_map) => {
                format!("{path}: no `jobs` mapping")
            }
            Some(Ok(file)) => {
                workflows.push(file);
                continue;
            }
        };
        unreadable.push(finding(
            UNREADABLE,
            format!("{path} cannot be read as a workflow"),
            "every .github/workflows/*.yml to parse as a YAML mapping with a `jobs` mapping",
            problem,
            UNREADABLE_NEXT,
        ));
    }
    (workflows, unreadable)
}

fn action_files_under(root: &Path, dir: &str) -> Vec<String> {
    let mut entries = list_dir(root, dir);
    entries.sort_by_key(|(name, _)| name.to_lowercase());
    entries
        .into_iter()
        .flat_map(|(name, kind)| {
            let path = format!("{dir}/{name}");
            if kind.is_dir() {
                action_files_under(root, &path)
            } else if kind.is_file() && ACTION_FILES.contains(&name.as_str()) {
                vec![path]
            } else {
                Vec::new()
            }
        })
        .collect()
}

/// A `/`-separated path with `.` and `..` segments resolved (`..` kept at the front), as
/// `path.posix.normalize` does, without a trailing slash; `.` when nothing is left.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("/")
    }
}

/// The metadata file a local `uses: ./dir` names, when it exists under the root.
fn local_action_file(root: &Path, uses: &str) -> Option<String> {
    let dir = normalize(&uses[2..]);
    if dir.starts_with("..") {
        return None;
    }
    ACTION_FILES
        .iter()
        .map(|name| {
            if dir == "." {
                (*name).to_owned()
            } else {
                format!("{dir}/{name}")
            }
        })
        .find(|path| root.join(path).is_file())
}

/// The repository's own actions: every `action.yml`/`action.yaml` under
/// `.github/actions/`, and any other one a workflow step's `uses: ./…` names, parsed, with
/// a finding for each one that cannot be read. Their steps run inside a workflow's job, so
/// the step rules apply to them as well.
pub(super) fn read_actions(
    root: &Path,
    workflows: &[YamlFile],
) -> (Vec<YamlFile>, Vec<FailureDetails>) {
    let mut paths = action_files_under(root, ACTIONS_DIR);
    for workflow in workflows {
        for (_, job) in jobs_of(workflow) {
            for (_, step) in steps_of(job) {
                let named = step
                    .get("uses")
                    .and_then(Node::as_str)
                    .filter(|uses| uses.starts_with("./"))
                    .and_then(|uses| local_action_file(root, uses));
                if let Some(path) = named.filter(|path| !paths.contains(path)) {
                    paths.push(path);
                }
            }
        }
    }
    let mut actions = Vec::new();
    let mut unreadable = Vec::new();
    for path in paths {
        let problem = match read_yaml(root, &path) {
            None => continue,
            Some(Err(problem)) => problem,
            Some(Ok(file)) if !file.root.is_map() => {
                format!("{path}: the document is not a mapping")
            }
            Some(Ok(file)) if !file.root.get("runs").is_some_and(Node::is_map) => {
                format!("{path}: no `runs` mapping")
            }
            Some(Ok(file)) => {
                actions.push(file);
                continue;
            }
        };
        unreadable.push(finding(
            UNREADABLE,
            format!("{path} cannot be read as an action"),
            "every local action's action.yml to parse as a YAML mapping with a `runs` mapping",
            problem,
            UNREADABLE_NEXT,
        ));
    }
    (actions, unreadable)
}

/// A composite action's steps that are mappings, with their index.
pub(super) fn action_steps_of(action: &YamlFile) -> Vec<(usize, &Node)> {
    match action.root.get("runs") {
        Some(runs) if runs.get("using").and_then(Node::as_str) == Some("composite") => {
            steps_of(runs)
        }
        _ => Vec::new(),
    }
}

/// The event names a workflow's `on:` declares, in any of its shapes.
pub(super) fn trigger_names(root: &Node) -> Vec<String> {
    let Some(on) = root.get("on") else {
        return Vec::new();
    };
    match &on.value {
        Yaml::Str(event) => vec![event.clone()],
        Yaml::Seq(events) => events
            .iter()
            .filter_map(|event| event.as_str().map(str::to_owned))
            .collect(),
        Yaml::Map(_) => on.pairs().map(|(event, _)| event).collect(),
        Yaml::Null | Yaml::Bool(_) | Yaml::Number(_) => Vec::new(),
    }
}

/// A job's steps that are mappings, with their index.
pub(super) fn steps_of(job: &Node) -> Vec<(usize, &Node)> {
    job.get("steps")
        .map(Node::items)
        .unwrap_or_default()
        .iter()
        .enumerate()
        .filter(|(_, step)| step.is_map())
        .collect()
}

/// The jobs of a workflow that are mappings, by id.
pub(super) fn jobs_of(workflow: &YamlFile) -> Vec<(String, &Node)> {
    workflow
        .root
        .get("jobs")
        .map(|jobs| jobs.pairs().filter(|(_, job)| job.is_map()).collect())
        .unwrap_or_default()
}

/// A run script's lines with `\` continuations joined, each with its 0-based first line;
/// blank and comment lines dropped.
pub(super) fn script_lines(script: &str) -> Vec<(usize, String)> {
    let physical: Vec<&str> = script.split('\n').collect();
    let mut joined = Vec::new();
    let mut index = 0;
    while index < physical.len() {
        let start = index;
        let mut line = physical[index].to_owned();
        while line.ends_with('\\') && index + 1 < physical.len() {
            index += 1;
            line.pop();
            line.push(' ');
            line.push_str(physical[index]);
        }
        let text = line.trim();
        if !text.is_empty() && !text.starts_with('#') {
            joined.push((start, text.to_owned()));
        }
        index += 1;
    }
    joined
}

/// amannn/action-semantic-pull-request's `types` when the input is unset (v6).
pub(super) const DEFAULT_TITLE_TYPES: [&str; 11] = [
    "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
];
pub(super) const TITLE_ACTION: &str = "amannn/action-semantic-pull-request@";

/// A PR-title check: where its step is, and the Conventional Commit types it accepts.
pub(super) struct TitleCheck {
    /// `path:line` of the step's `uses:`.
    pub(super) place: String,
    pub(super) types: Vec<String>,
}

/// Every workflow step using amannn/action-semantic-pull-request, with its `types`.
pub(super) fn title_checks(workflows: &[YamlFile]) -> Vec<TitleCheck> {
    let mut checks = Vec::new();
    for workflow in workflows {
        for (id, job) in jobs_of(workflow) {
            for (index, step) in steps_of(job) {
                let is_title = step
                    .get("uses")
                    .and_then(Node::as_str)
                    .is_some_and(|uses| uses.starts_with(TITLE_ACTION));
                if !is_title {
                    continue;
                }
                let types = step
                    .get("with")
                    .and_then(|inputs| inputs.get("types"))
                    .and_then(Node::as_str)
                    .map_or_else(
                        || DEFAULT_TITLE_TYPES.map(str::to_owned).to_vec(),
                        |types| {
                            types
                                .split(|c: char| c.is_whitespace() || c == ',')
                                .filter(|kind| !kind.is_empty())
                                .map(str::to_owned)
                                .collect()
                        },
                    );
                checks.push(TitleCheck {
                    place: workflow.at(&[
                        Key::Name("jobs"),
                        Key::Name(&id),
                        Key::Name("steps"),
                        Key::Index(index),
                        Key::Name("uses"),
                    ]),
                    types,
                });
            }
        }
    }
    checks
}

#[cfg(test)]
mod tests {
    use super::{
        Renovate, normalize, read_actions, read_renovate, read_workflows, script_lines,
        title_checks, trigger_names,
    };
    use crate::check_harness::yaml::{Keys, parse};
    use crate::test_support::{temp_dir, write};

    #[test]
    fn joins_continuations_and_drops_comments_and_blanks() {
        assert_eq!(
            script_lines("a \\\n  b\n\n# note\n  c\nd \\"),
            [
                (0, "a    b".to_owned()),
                (4, "c".to_owned()),
                (5, "d \\".to_owned())
            ]
        );
    }

    #[test]
    fn normalizes_a_local_path() {
        assert_eq!(normalize("./a//b/../c/"), "a/c");
        assert_eq!(normalize(""), ".");
        assert_eq!(normalize("../x"), "../x");
        assert_eq!(normalize("a/../.."), "..");
    }

    #[test]
    fn reads_triggers_in_every_shape() {
        let names = |text: &str| trigger_names(&parse(text, Keys::Unique).expect("yaml").root);
        assert_eq!(names("on: push\n"), ["push"]);
        assert_eq!(
            names("on: [push, 1, pull_request]\n"),
            ["push", "pull_request"]
        );
        assert_eq!(
            names("on:\n  push:\n  workflow_call:\n"),
            ["push", "workflow_call"]
        );
        assert_eq!(names("on: 1\n"), Vec::<String>::new());
        assert_eq!(names("name: x\n"), Vec::<String>::new());
    }

    #[test]
    fn reports_unreadable_workflows_and_actions() {
        let dir = temp_dir();
        let root = dir.path();
        write(root, ".github/workflows/a.yml", "jobs: [\n");
        write(root, ".github/workflows/b.yml", "- x\n");
        write(root, ".github/workflows/c.yaml", "name: c\n");
        write(root, ".github/workflows/d.txt", "ignored\n");
        write(
            root,
            ".github/workflows/e.yml",
            "jobs:\n  a:\n    steps:\n      - uses: ./tools/act\n      - uses: ./nowhere\n      - uses: ../x\n      - uses: ./.github/actions/one\n",
        );
        write(root, "tools/act/action.yaml", "runs: x\n");
        write(
            root,
            ".github/actions/one/action.yml",
            "runs:\n  using: composite\n",
        );
        write(root, ".github/actions/two/action.yml", "- no\n");
        let (workflows, unreadable) = read_workflows(root);
        assert_eq!(workflows.len(), 1);
        let problems: Vec<&str> = unreadable
            .iter()
            .map(|found| found.actual.as_str())
            .collect();
        assert!(
            problems[0].starts_with(".github/workflows/a.yml:"),
            "{problems:?}"
        );
        assert_eq!(
            problems[1..],
            [
                ".github/workflows/b.yml: the document is not a mapping",
                ".github/workflows/c.yaml: no `jobs` mapping",
            ]
        );
        let (actions, unreadable) = read_actions(root, &workflows);
        assert_eq!(
            actions.iter().map(|a| a.path.as_str()).collect::<Vec<_>>(),
            [".github/actions/one/action.yml"]
        );
        assert_eq!(
            unreadable
                .iter()
                .map(|found| found.actual.as_str())
                .collect::<Vec<_>>(),
            [
                ".github/actions/two/action.yml: the document is not a mapping",
                "tools/act/action.yaml: no `runs` mapping",
            ]
        );
    }

    #[test]
    fn reads_title_types_or_the_defaults() {
        let dir = temp_dir();
        write(
            dir.path(),
            ".github/workflows/t.yml",
            "jobs:\n  t:\n    steps:\n      - uses: amannn/action-semantic-pull-request@abc\n        with:\n          types: |\n            feat, fix\n            deps\n      - uses: amannn/action-semantic-pull-request@abc\n",
        );
        let (workflows, _) = read_workflows(dir.path());
        let checks = title_checks(&workflows);
        assert_eq!(checks[0].place, ".github/workflows/t.yml:4");
        assert_eq!(checks[0].types, ["feat", "fix", "deps"]);
        assert_eq!(checks[1].types.len(), 11);
    }

    #[test]
    fn reads_the_first_renovate_config_and_refuses_json5() {
        let dir = temp_dir();
        assert!(read_renovate(dir.path()).is_none());
        write(dir.path(), ".github/renovate.json", "[1]");
        assert!(
            matches!(read_renovate(dir.path()), Some(Renovate::Config { config, .. }) if config.is_empty())
        );
        write(dir.path(), "renovate.json", "{ nope");
        assert!(
            matches!(read_renovate(dir.path()), Some(Renovate::Problem { path, .. }) if path == "renovate.json")
        );
        write(dir.path(), ".renovaterc.json5", "{}");
        assert!(
            matches!(read_renovate(dir.path()), Some(Renovate::Problem { path, .. }) if path == ".renovaterc.json5")
        );
    }
}
