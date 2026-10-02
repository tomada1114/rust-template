//! `cargo xtask sync-labels` (`just labels`): creates or updates this repository's GitHub
//! labels from `.github/labels.yml`. It never deletes a label the manifest does not
//! mention, so a repository-local label survives running it. Needs `gh`, authenticated
//! against the repository it resolves (`gh repo view`); a human's step, never run by CI or
//! a hook, and a remote write that needs sign-off before its first run against the live
//! repository.
//!
//! ```text
//! cargo xtask sync-labels
//! ```
//!
//! The manifest is validated whole ([`parse_label_manifest`], which the labels-declared
//! harness check shares) before the first `gh` call, so a malformed one changes nothing.
//!
//! Git work tree: not checked; `gh repo view` resolves the repository from the checkout's
//! remote, and fails with `ERR_LABELS_GH` where there is none.
//!
//! Errors: `ERR_LABELS_MANIFEST` (labels.yml is missing, or not a valid label list),
//! `ERR_LABELS_GH` (`gh` could not start, a call failed, or `gh label list` returned
//! something other than a list).

use crate::check_harness::first_line;
use crate::check_harness::yaml::{self, Keys, Node, Yaml};
use crate::context::{Context, RunOptions, RunResult};
use crate::fail::{ScriptError, TaskResult};

const MANIFEST: &str = ".github/labels.yml";
/// GitHub's limit on a label description, counted in UTF-16 units as GitHub's API does.
const MAX_DESCRIPTION: usize = 100;

/// One label as `.github/labels.yml` declares it, or as `gh label list` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LabelDeclaration {
    pub(crate) name: String,
    pub(crate) color: String,
    pub(crate) description: String,
}

/// `.github/labels.yml` as `just labels` reads it: a YAML list of `{ name, color,
/// description }`, validated for what GitHub itself would reject (a color that is not six
/// lowercase hex digits, a description over 100 characters, a repeated name), so a run
/// fails before its first API call instead of halfway through. The error is the first
/// problem found, in a form fit for an `Actual:` line.
pub(crate) fn parse_label_manifest(text: &str) -> Result<Vec<LabelDeclaration>, String> {
    let document =
        yaml::parse(text, Keys::Unique).map_err(|error| first_line(&error.message).to_owned())?;
    let Yaml::Seq(entries) = &document.root.value else {
        return Err("the top level is not a list".to_owned());
    };
    let mut labels: Vec<LabelDeclaration> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let place = format!("entry {}", index + 1);
        // A JavaScript array is an object too, so a list entry falls through to "no name".
        if !entry.is_map() && !entry.is_seq() {
            return Err(format!("{place} is not a mapping"));
        }
        let Some(name) = entry
            .get("name")
            .and_then(Node::as_str)
            .filter(|name| !name.is_empty())
        else {
            return Err(format!("{place} has no name"));
        };
        let color = entry.get("color");
        let Some(hex) = color.and_then(Node::as_str).filter(|color| {
            color.len() == 6
                && color
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        }) else {
            return Err(format!(
                "{name}: color {}",
                color.map_or_else(|| "undefined".to_owned(), Node::to_json)
            ));
        };
        let Some(description) = entry
            .get("description")
            .and_then(Node::as_str)
            .filter(|text| text.encode_utf16().count() <= MAX_DESCRIPTION)
        else {
            return Err(format!(
                "{name}: a missing description, or one over {MAX_DESCRIPTION} characters"
            ));
        };
        if labels.iter().any(|label| label.name == name) {
            return Err(format!("{name} is declared twice"));
        }
        labels.push(LabelDeclaration {
            name: name.to_owned(),
            color: hex.to_owned(),
            description: description.to_owned(),
        });
    }
    Ok(labels)
}

/// What a run does to one label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Create,
    Update,
}

/// What it takes to make the repository match the manifest, in manifest order. A remote
/// color is compared case-insensitively; a remote label the manifest does not name is
/// left alone.
fn diff_labels<'a>(
    manifest: &'a [LabelDeclaration],
    remote: &[LabelDeclaration],
) -> Vec<(Kind, &'a LabelDeclaration)> {
    manifest
        .iter()
        .filter_map(
            |label| match remote.iter().find(|existing| existing.name == label.name) {
                None => Some((Kind::Create, label)),
                Some(existing)
                    if existing.color.to_lowercase() == label.color
                        && existing.description == label.description =>
                {
                    None
                }
                Some(_) => Some((Kind::Update, label)),
            },
        )
        .collect()
}

fn gh_failed(summary: String, actual: String) -> ScriptError {
    ScriptError::new(
        "ERR_LABELS_GH",
        summary,
        "the GitHub CLI on PATH, authenticated with write access to this repository",
        actual,
        "run `gh auth status` and confirm this checkout has a GitHub remote",
    )
}

/// Run one `gh` call in the repository root; its standard output, or `ERR_LABELS_GH`.
fn gh(context: &Context<'_>, args: &[&str]) -> Result<String, ScriptError> {
    let result: RunResult = context.run(
        "gh",
        args,
        &RunOptions {
            cwd: Some(context.root.clone()),
            env: None,
            input: None,
        },
    );
    if !result.started {
        return Err(ScriptError::new(
            "ERR_LABELS_GH",
            "'gh' could not be started",
            "the GitHub CLI ('gh') on PATH, authenticated with write access to this repository",
            result.stderr_text().trim(),
            "install the GitHub CLI and run `gh auth login`",
        ));
    }
    if !result.success() {
        let stderr = result.stderr_text().trim().to_owned();
        let actual = if !stderr.is_empty() {
            stderr
        } else if let Some(status) = result.status {
            format!("exit status {status}")
        } else {
            "stopped by a signal before it exited".to_owned()
        };
        let shown: Vec<&str> = args.iter().copied().take(3).collect();
        return Err(gh_failed(
            format!("`gh {}` failed", shown.join(" ")),
            actual,
        ));
    }
    Ok(result.stdout_text())
}

fn remote_labels(context: &Context<'_>, repo: &str) -> Result<Vec<LabelDeclaration>, ScriptError> {
    let output = gh(
        context,
        &[
            "label",
            "list",
            "--repo",
            repo,
            "--limit",
            "200",
            "--json",
            "name,color,description",
        ],
    )?;
    let rows = match serde_json::from_str::<serde_json::Value>(&output) {
        Ok(serde_json::Value::Array(rows)) => rows,
        Ok(other) => {
            return Err(not_a_list(&other.to_string()));
        }
        Err(error) => return Err(not_a_list(&format!("not JSON ({error})"))),
    };
    let field = |row: &serde_json::Value, key: &str| {
        row.get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Ok(rows
        .iter()
        .map(|row| LabelDeclaration {
            name: field(row, "name"),
            color: field(row, "color"),
            description: field(row, "description"),
        })
        .collect())
}

fn not_a_list(actual: &str) -> ScriptError {
    ScriptError::new(
        "ERR_LABELS_GH",
        "`gh label list` did not return a list",
        "a JSON array of labels",
        actual.chars().take(200).collect::<String>(),
        "update the GitHub CLI, then run `just labels` again",
    )
}

pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    let Ok(text) = std::fs::read_to_string(context.root.join(MANIFEST)) else {
        return Err(ScriptError::new(
            "ERR_LABELS_MANIFEST",
            format!("{MANIFEST} cannot be read"),
            format!("a committed {MANIFEST}"),
            "no such file",
            format!("restore {MANIFEST} from version control"),
        ));
    };
    let manifest = parse_label_manifest(&text).map_err(|actual| {
        ScriptError::new(
            "ERR_LABELS_MANIFEST",
            format!("{MANIFEST} is not a valid label list"),
            format!(
                "a YAML list of {{ name, color: six lowercase hex digits, description: ≤ {MAX_DESCRIPTION} characters }}, names unique"
            ),
            actual,
            format!("fix {MANIFEST}"),
        )
    })?;
    let repo = gh(
        context,
        &[
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "--jq",
            ".nameWithOwner",
        ],
    )?
    .trim()
    .to_owned();
    let remote = remote_labels(context, &repo)?;
    let actions = diff_labels(&manifest, &remote);

    for (kind, label) in &actions {
        let (verb, done) = match kind {
            Kind::Create => ("create", "created"),
            Kind::Update => ("edit", "updated"),
        };
        gh(
            context,
            &[
                "label",
                verb,
                &label.name,
                "--repo",
                &repo,
                "--color",
                &label.color,
                "--description",
                &label.description,
            ],
        )?;
        context.log(&format!("labels: {done} {}", label.name));
    }
    let created = actions
        .iter()
        .filter(|(kind, _)| *kind == Kind::Create)
        .count();
    context.log(&format!(
        "labels: {repo} matches {MANIFEST} ({created} created, {} updated)",
        actions.len() - created
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::Path;

    use super::{Kind, LabelDeclaration, diff_labels, main, parse_label_manifest};
    use crate::context::{RunOptions, RunResult};
    use crate::test_support::{Fake, Outcome, temp_dir, write};

    fn label(name: &str, color: &str, description: &str) -> LabelDeclaration {
        LabelDeclaration {
            name: name.to_owned(),
            color: color.to_owned(),
            description: description.to_owned(),
        }
    }

    #[test]
    fn creates_a_missing_label_updates_a_changed_one_and_leaves_the_rest_alone() {
        let bug = label("bug", "d73a4a", "Broken.");
        let ci = label("ci", "006b75", "CI only.");
        let manifest = [bug.clone(), ci.clone()];
        let remote = [
            label("bug", "D73A4A", "Old words."),
            label("wontfix", "ffffff", ""),
        ];
        assert_eq!(
            diff_labels(&manifest, &remote),
            [(Kind::Update, &bug), (Kind::Create, &ci)]
        );
    }

    #[test]
    fn does_nothing_when_the_repository_already_matches_whatever_the_colors_case() {
        let manifest = [label("bug", "d73a4a", "Broken.")];
        assert_eq!(
            diff_labels(&manifest, &[label("bug", "D73A4A", "Broken.")]),
            []
        );
    }

    #[test]
    fn reads_name_color_and_description_of_each_label() {
        let text = "- name: bug\n  color: d73a4a\n  description: \"Broken.\"\n- name: \"priority: P0\"\n  color: b60205\n  description: Now.\n";
        assert_eq!(
            parse_label_manifest(text),
            Ok(vec![
                label("bug", "d73a4a", "Broken."),
                label("priority: P0", "b60205", "Now."),
            ])
        );
    }

    #[test]
    fn returns_every_entry_in_order_when_the_names_are_unique() {
        let text = ["bug", "ci", "tracking"]
            .map(|name| format!("- name: {name}\n  color: ededed\n  description: x\n"))
            .concat();
        let names: Vec<String> = parse_label_manifest(&text)
            .expect("a valid manifest")
            .into_iter()
            .map(|label| label.name)
            .collect();
        assert_eq!(names, ["bug", "ci", "tracking"]);
    }

    #[test]
    fn counts_a_description_in_utf16_units() {
        let at_limit = format!(
            "- name: bug\n  color: d73a4a\n  description: {}\n",
            "\u{1F600}".repeat(50)
        );
        assert!(parse_label_manifest(&at_limit).is_ok());
        let over = format!(
            "- name: bug\n  color: d73a4a\n  description: {}x\n",
            "\u{1F600}".repeat(50)
        );
        assert_eq!(
            parse_label_manifest(&over),
            Err("bug: a missing description, or one over 100 characters".to_owned())
        );
    }

    #[test]
    fn rejects_what_github_would() {
        for (case, text, actual) in [
            ("not YAML", "- name: [unclosed", None),
            (
                "not a list",
                "name: bug",
                Some("the top level is not a list"),
            ),
            (
                "an entry that is not a mapping",
                "- bug",
                Some("entry 1 is not a mapping"),
            ),
            ("a list entry", "- [bug]", Some("entry 1 has no name")),
            (
                "a missing name",
                "- color: d73a4a\n  description: x",
                Some("entry 1 has no name"),
            ),
            (
                "an empty name",
                "- name: \"\"\n  color: d73a4a\n  description: x",
                Some("entry 1 has no name"),
            ),
            (
                "an upper-case color",
                "- name: bug\n  color: D73A4A\n  description: x",
                Some("bug: color \"D73A4A\""),
            ),
            (
                "a color with #",
                "- name: bug\n  color: \"#d73a4a\"\n  description: x",
                Some("bug: color \"#d73a4a\""),
            ),
            (
                "a missing color",
                "- name: bug\n  description: x",
                Some("bug: color undefined"),
            ),
            (
                "a numeric color",
                "- name: bug\n  color: 123456\n  description: x",
                Some("bug: color 123456"),
            ),
            (
                "a missing description",
                "- name: bug\n  color: d73a4a",
                Some("bug: a missing description, or one over 100 characters"),
            ),
            (
                "a repeated key",
                "- name: bug\n  color: d73a4a\n  name: bug\n  description: x",
                None,
            ),
            (
                "a duplicate name",
                "- name: bug\n  color: d73a4a\n  description: x\n- name: bug\n  color: d73a4a\n  description: y",
                Some("bug is declared twice"),
            ),
        ] {
            let found = parse_label_manifest(text);
            assert!(found.is_err(), "{case}");
            if let Some(actual) = actual {
                assert_eq!(found, Err(actual.to_owned()), "{case}");
            }
        }
        let long = format!(
            "- name: bug\n  color: d73a4a\n  description: {}",
            "x".repeat(101)
        );
        assert!(parse_label_manifest(&long).is_err());
    }

    const MANIFEST: &str = "- name: bug\n  color: d73a4a\n  description: Broken.\n- name: ci\n  color: 006b75\n  description: CI only.\n";

    type Call = (String, Vec<String>, RunOptions);

    /// Run the task at a root holding `manifest` (none when `None`), answering each `gh`
    /// call through `respond` (a success with empty output when it returns `None`).
    fn sync(
        manifest: Option<&str>,
        respond: &dyn Fn(&[&str]) -> Option<RunResult>,
    ) -> (Outcome, Vec<Call>, std::path::PathBuf) {
        let dir = temp_dir();
        if let Some(manifest) = manifest {
            write(dir.path(), ".github/labels.yml", manifest);
        }
        let calls = RefCell::new(Vec::new());
        let run = |command: &str, args: &[&str], options: &RunOptions| {
            calls.borrow_mut().push((
                command.to_owned(),
                args.iter().map(ToString::to_string).collect(),
                options.clone(),
            ));
            respond(args).unwrap_or_else(|| RunResult::exited(0, "", ""))
        };
        let outcome = Fake::at(dir.path()).run(&run).task(main);
        (outcome, calls.into_inner(), dir.path().to_path_buf())
    }

    fn live_repo(args: &[&str]) -> Option<RunResult> {
        match args {
            ["repo", ..] => Some(RunResult::exited(0, "owner/repo\n", "")),
            ["label", "list", ..] => Some(RunResult::exited(
                0,
                r#"[{"name":"bug","color":"d73a4a","description":"Old."}]"#,
                "",
            )),
            _ => None,
        }
    }

    fn args_of(calls: &[Call]) -> Vec<Vec<String>> {
        calls.iter().map(|(_, args, _)| args.clone()).collect()
    }

    #[test]
    fn updates_and_creates_labels_on_the_repository_gh_points_at() {
        let (outcome, calls, root) = sync(Some(MANIFEST), &live_repo);
        outcome.assert_ok();
        assert!(calls.iter().all(|(command, _, options)| command == "gh"
            && options.cwd.as_deref() == Some(Path::new(&root))
            && options.env.is_none()));
        assert_eq!(
            args_of(&calls),
            [
                vec![
                    "repo",
                    "view",
                    "--json",
                    "nameWithOwner",
                    "--jq",
                    ".nameWithOwner"
                ],
                vec![
                    "label",
                    "list",
                    "--repo",
                    "owner/repo",
                    "--limit",
                    "200",
                    "--json",
                    "name,color,description",
                ],
                vec![
                    "label",
                    "edit",
                    "bug",
                    "--repo",
                    "owner/repo",
                    "--color",
                    "d73a4a",
                    "--description",
                    "Broken.",
                ],
                vec![
                    "label",
                    "create",
                    "ci",
                    "--repo",
                    "owner/repo",
                    "--color",
                    "006b75",
                    "--description",
                    "CI only.",
                ],
            ]
        );
        assert_eq!(
            outcome.lines,
            [
                "labels: updated bug",
                "labels: created ci",
                "labels: owner/repo matches .github/labels.yml (1 created, 1 updated)",
            ]
        );
    }

    #[test]
    fn changes_nothing_when_the_repository_already_matches() {
        let (outcome, calls, _) = sync(Some(MANIFEST), &|args| match args {
            ["label", ..] => Some(RunResult::exited(
                0,
                r#"[{"name":"bug","color":"d73a4a","description":"Broken."},{"name":"ci","color":"006b75","description":"CI only."}]"#,
                "",
            )),
            _ => live_repo(args),
        });
        outcome.assert_ok();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            outcome.lines,
            ["labels: owner/repo matches .github/labels.yml (0 created, 0 updated)"]
        );
    }

    #[test]
    fn fails_with_err_labels_manifest_when_the_manifest_is_missing_or_invalid() {
        let (outcome, calls, _) = sync(None, &live_repo);
        assert_eq!(outcome.code(), "ERR_LABELS_MANIFEST");
        assert!(calls.is_empty());
        let (outcome, calls, _) = sync(Some("- name: bug\n"), &live_repo);
        let error = outcome.failure();
        assert_eq!(error.code(), "ERR_LABELS_MANIFEST");
        assert_eq!(error.details.actual, "bug: color undefined");
        assert!(calls.is_empty());
    }

    #[test]
    fn fails_with_err_labels_gh_when_gh_cannot_start() {
        let (outcome, _, _) = sync(Some(MANIFEST), &|_| {
            Some(RunResult {
                status: None,
                started: false,
                stdout: Vec::new(),
                stderr: b"gh: No such file or directory (os error 2)".to_vec(),
            })
        });
        let error = outcome.failure();
        assert_eq!(error.code(), "ERR_LABELS_GH");
        assert!(error.details.summary.contains("could not be started"));
        assert!(error.details.actual.contains("No such file"));
    }

    #[test]
    fn fails_with_err_labels_gh_when_a_gh_call_fails_naming_the_call() {
        let (outcome, calls, _) = sync(Some(MANIFEST), &|args| match args {
            ["label", "create", ..] => Some(RunResult::exited(1, "", "HTTP 403\n")),
            _ => live_repo(args),
        });
        let error = outcome.failure();
        assert_eq!(error.code(), "ERR_LABELS_GH");
        assert_eq!(error.details.summary, "`gh label create ci` failed");
        assert_eq!(error.details.actual, "HTTP 403");
        assert_eq!(calls.len(), 4);
    }

    #[test]
    fn names_the_exit_status_or_signal_when_a_failing_gh_prints_nothing() {
        let (outcome, _, _) = sync(Some(MANIFEST), &|_| Some(RunResult::exited(4, "", "")));
        assert_eq!(outcome.failure().details.actual, "exit status 4");
        let (outcome, _, _) = sync(Some(MANIFEST), &|_| {
            Some(RunResult {
                status: None,
                started: true,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        });
        let error = outcome.failure();
        assert_eq!(error.code(), "ERR_LABELS_GH");
        assert!(error.details.actual.contains("signal"));
    }

    #[test]
    fn fails_with_err_labels_gh_when_gh_lists_something_that_is_not_a_label_list() {
        for listed in [r#"{"not":"a list"}"#, "not json"] {
            let (outcome, _, _) = sync(Some(MANIFEST), &|args| match args {
                ["label", ..] => Some(RunResult::exited(0, listed, "")),
                _ => live_repo(args),
            });
            let error = outcome.failure();
            assert_eq!(error.code(), "ERR_LABELS_GH", "{listed}");
            assert_eq!(
                error.details.summary,
                "`gh label list` did not return a list"
            );
        }
    }

    #[test]
    fn reads_a_remote_label_with_missing_fields_as_empty() {
        let (outcome, calls, _) = sync(Some(MANIFEST), &|args| match args {
            ["label", "list", ..] => Some(RunResult::exited(0, r#"[{"name":"bug"}, 3]"#, "")),
            _ => live_repo(args),
        });
        outcome.assert_ok();
        let verbs: Vec<String> = args_of(&calls)
            .iter()
            .skip(2)
            .filter_map(|args| args.get(1).cloned())
            .collect();
        assert_eq!(verbs, ["edit", "create"]);
    }
}
