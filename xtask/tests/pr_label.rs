//! `.github/workflows/pr-label.yml`'s labeling step, run as GitHub runs it — its `run:`
//! script under the workflow's default `shell:` with the step's `env:` — against a fake
//! `gh` first on PATH that records every call and answers with canned output. Nothing
//! else executes that script, so a broken guard in its jq would otherwise surface only
//! as a wrong label on a real pull request.

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use yaml_rust2::{Yaml, YamlLoader};

/// The value, or a panic that names what failed: a panic is how a test fails.
fn must<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> T {
    result.unwrap_or_else(|error| panic!("{what}: {error}"))
}

fn workflow_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../.github/workflows/pr-label.yml")
}

/// The step's script, its `TYPE_LABELS`, and the workflow's default shell, read from a
/// workflow file (the checkout's, or a mutated copy).
struct Step {
    script: String,
    type_labels: String,
    shell: String,
}

fn str_at<'a>(node: &'a Yaml, what: &str) -> &'a str {
    node.as_str()
        .unwrap_or_else(|| panic!("pr-label.yml: {what} is not a string"))
}

fn read_step(text: &str) -> Step {
    let docs = must(YamlLoader::load_from_str(text), "parse pr-label.yml");
    let doc = &docs[0];
    let shell = str_at(&doc["defaults"]["run"]["shell"], "defaults.run.shell").to_owned();
    let steps = doc["jobs"]["label"]["steps"]
        .as_vec()
        .unwrap_or_else(|| panic!("pr-label.yml: jobs.label.steps is not a list"));
    let step = steps
        .iter()
        .find(|step| !step["env"]["TYPE_LABELS"].is_badvalue())
        .unwrap_or_else(|| panic!("pr-label.yml: no step sets TYPE_LABELS"));
    Step {
        script: str_at(&step["run"], "the step's run").to_owned(),
        type_labels: str_at(&step["env"]["TYPE_LABELS"], "TYPE_LABELS").to_owned(),
        shell,
    }
}

fn checkout_step() -> Step {
    read_step(&must(
        std::fs::read_to_string(workflow_path()),
        "read pr-label.yml",
    ))
}

fn jq_missing() -> bool {
    let found = Command::new("sh")
        .args(["-c", "command -v jq"])
        .output()
        .is_ok_and(|output| output.status.success());
    if !found {
        eprintln!("skipped: jq is not on PATH (GitHub's ubuntu runners ship it)");
    }
    !found
}

/// What the fake `gh` answers.
struct Gh<'a> {
    view_stdout: &'a str,
    view_status: i32,
    edit_status: i32,
}

const NO_LABELS: Gh<'static> = Gh {
    view_stdout: r#"{"labels":[]}"#,
    view_status: 0,
    edit_status: 0,
};

/// Every `gh` call the script made, one line each, and the script's exit code.
struct Run {
    calls: Vec<String>,
    status: Option<i32>,
    stdout: String,
}

fn run(step: &Step, title: &str, gh: &Gh<'_>) -> Run {
    let dir = must(TempDir::new(), "tempdir");
    let bin = dir.path().join("bin");
    must(std::fs::create_dir_all(&bin), "mkdir");
    let log = dir.path().join("gh.log");
    std::fs::write(dir.path().join("view.json"), gh.view_stdout)
        .unwrap_or_else(|e| panic!("write: {e}"));
    let fake = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{log}'\ncase \"$1 $2\" in\n  'pr view') cat '{view}'; [ {vs} -ne 0 ] && echo 'view refused' >&2; exit {vs} ;;\n  'pr edit') [ {es} -ne 0 ] && echo 'edit refused' >&2; exit {es} ;;\nesac\necho \"unexpected gh $*\" >&2\nexit 99\n",
        log = log.display(),
        view = dir.path().join("view.json").display(),
        vs = gh.view_status,
        es = gh.edit_status,
    );
    let gh_path = bin.join("gh");
    must(std::fs::write(&gh_path, fake), "write the fake gh");
    let mut permissions = must(std::fs::metadata(&gh_path), "stat").permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
    must(std::fs::set_permissions(&gh_path, permissions), "chmod");
    let script = dir.path().join("step.sh");
    must(std::fs::write(&script, &step.script), "write the script");

    // GitHub substitutes the script's path for `{0}` and runs the result as argv.
    let mut argv: Vec<String> = step
        .shell
        .split_whitespace()
        .map(|word| {
            if word == "{0}" {
                script.display().to_string()
            } else {
                word.to_owned()
            }
        })
        .collect();
    let program = argv.remove(0);
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let output = must(
        Command::new(program)
            .args(argv)
            .current_dir(dir.path())
            .env_clear()
            .env("PATH", path)
            .env("TMPDIR", dir.path())
            .env("GH_TOKEN", "fake")
            .env("GH_REPO", "owner/repo")
            .env("PR_NUMBER", "7")
            .env("PR_TITLE", title)
            .env("TYPE_LABELS", &step.type_labels)
            .output(),
        "run the step",
    );
    let calls = std::fs::read_to_string(&log)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect();
    Run {
        calls,
        status: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
    }
}

fn view_with(labels: &str) -> String {
    format!(r#"{{"labels":[{labels}]}}"#)
}

const VIEW: &str = "pr view 7 --json labels";

fn assert_calls(run: &Run, expected: &[&str]) {
    assert_eq!(run.status, Some(0), "exit status; stdout: {}", run.stdout);
    assert_eq!(run.calls, expected);
}

#[test]
fn adds_the_titles_label_when_the_pr_has_none() {
    if jq_missing() {
        return;
    }
    let result = run(&checkout_step(), "fix(core): handle overflow", &NO_LABELS);
    assert_calls(&result, &[VIEW, "pr edit 7 --add-label bug"]);
}

#[test]
fn replaces_a_stale_type_label() {
    if jq_missing() {
        return;
    }
    let view = view_with(r#"{"name":"bug"},{"name":"needs review"}"#);
    let gh = Gh {
        view_stdout: &view,
        ..NO_LABELS
    };
    let result = run(&checkout_step(), "feat!: new thing", &gh);
    assert_calls(
        &result,
        &[VIEW, "pr edit 7 --add-label enhancement --remove-label bug"],
    );
}

#[test]
fn keeps_dependencies_when_the_title_wants_another_label() {
    if jq_missing() {
        return;
    }
    let view = view_with(r#"{"name":"dependencies"}"#);
    let gh = Gh {
        view_stdout: &view,
        ..NO_LABELS
    };
    let result = run(&checkout_step(), "chore: bump", &gh);
    assert_calls(&result, &[VIEW, "pr edit 7 --add-label chore"]);
}

#[test]
fn keeps_both_managed_labels_when_there_are_two() {
    if jq_missing() {
        return;
    }
    let view = view_with(r#"{"name":"bug"},{"name":"ci"}"#);
    let gh = Gh {
        view_stdout: &view,
        ..NO_LABELS
    };
    let result = run(&checkout_step(), "docs: explain", &gh);
    assert_calls(&result, &[VIEW, "pr edit 7 --add-label documentation"]);
}

#[test]
fn changes_nothing_when_the_label_is_already_there() {
    if jq_missing() {
        return;
    }
    let view = view_with(r#"{"name":"bug"}"#);
    let gh = Gh {
        view_stdout: &view,
        ..NO_LABELS
    };
    let result = run(&checkout_step(), "fix: x", &gh);
    assert_calls(&result, &[VIEW]);
}

#[test]
fn treats_an_unreadable_label_payload_as_no_labels() {
    if jq_missing() {
        return;
    }
    let gh = Gh {
        view_stdout: "not json",
        ..NO_LABELS
    };
    let result = run(&checkout_step(), "ci: tune", &gh);
    assert_calls(&result, &[VIEW, "pr edit 7 --add-label ci"]);
}

#[test]
fn still_adds_the_label_when_gh_pr_view_fails() {
    if jq_missing() {
        return;
    }
    let gh = Gh {
        view_stdout: "",
        view_status: 1,
        ..NO_LABELS
    };
    let result = run(&checkout_step(), "test: more", &gh);
    assert_calls(&result, &[VIEW, "pr edit 7 --add-label chore"]);
    assert!(
        result.stdout.contains("::notice::Could not read"),
        "{}",
        result.stdout
    );
}

#[test]
fn exits_zero_with_a_notice_when_gh_pr_edit_fails() {
    if jq_missing() {
        return;
    }
    let gh = Gh {
        edit_status: 1,
        ..NO_LABELS
    };
    let result = run(&checkout_step(), "fix: y", &gh);
    assert_calls(&result, &[VIEW, "pr edit 7 --add-label bug"]);
    assert!(
        result.stdout.contains("::notice::Could not update labels"),
        "{}",
        result.stdout
    );
}

#[test]
fn calls_no_gh_for_an_unmapped_title() {
    if jq_missing() {
        return;
    }
    for title in ["wip: something", "Update README"] {
        let result = run(&checkout_step(), title, &NO_LABELS);
        assert_calls(&result, &[]);
    }
}

/// The guard cases above must catch a broken guard: run them against copies of the step
/// with each guard broken and check the outcome changes.
#[test]
fn breaking_either_remove_guard_changes_the_outcome() {
    if jq_missing() {
        return;
    }
    let text = must(
        std::fs::read_to_string(workflow_path()),
        "read pr-label.yml",
    );
    let two = view_with(r#"{"name":"bug"},{"name":"ci"}"#);
    let deps = view_with(r#"{"name":"dependencies"}"#);
    let cases: [(&str, &str, &str, &str, &str); 2] = [
        (
            "length == 1 and",
            "length >= 1 and",
            &two,
            "docs: explain",
            "pr edit 7 --add-label documentation",
        ),
        (
            r#" and .[0] != "dependencies""#,
            "",
            &deps,
            "chore: bump",
            "pr edit 7 --add-label chore",
        ),
    ];
    for (guard, broken, view, title, intact_edit) in cases {
        assert!(
            text.contains(guard),
            "pr-label.yml no longer holds `{guard}`"
        );
        let step = read_step(&text.replacen(guard, broken, 1));
        let result = run(
            &step,
            title,
            &Gh {
                view_stdout: view,
                ..NO_LABELS
            },
        );
        assert_eq!(result.status, Some(0), "{}", result.stdout);
        assert_ne!(
            result.calls,
            [VIEW, intact_edit],
            "breaking `{guard}` went unnoticed"
        );
    }
}
