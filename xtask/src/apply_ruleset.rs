//! `cargo xtask apply-ruleset` (`just ruleset`): creates or updates every ruleset this
//! repository commits under `.github/rulesets/` — `main.json` (branch protection for the
//! default branch) and `release-tags.json` (who may create, move, or delete a release tag)
//! — each from the JSON body `POST /repos/{owner}/{repo}/rulesets` (and
//! `PUT .../rulesets/{id}`) accept.
//!
//! ```text
//! cargo xtask apply-ruleset
//! ```
//!
//! A human-run, admin-only step: applying a ruleset needs repository admin rights, so it
//! never runs from CI or a hook, and running it against the live repository needs sign-off
//! like any other remote write. "Use this template" does not copy rulesets, so every
//! repository made from the template runs this once.
//!
//! Idempotent and additive: each file is applied by its own `name` and `target` — a
//! repository-scoped ruleset with both is updated in place with PUT, otherwise one is
//! created with POST. It never deletes a ruleset, including one no file names. Every file
//! is validated before the first `gh` call, so a malformed one applies nothing. `gh` comes
//! from the caller's PATH and must already be authenticated. Rulesets on a private
//! repository need a paid plan; that refusal is `ERR_RULESET_PLAN_UNSUPPORTED` rather than
//! a raw 403. A deployment environment is not a ruleset and stays a manual step.
//!
//! Git work tree: not checked; `gh repo view` resolves the repository from the checkout's
//! remote, and its refusal where there is none is `ERR_RULESET_FORBIDDEN`.
//!
//! Errors: `ERR_RULESET_FILE_MISSING`, `ERR_RULESET_FILE_INVALID`, `ERR_RULESET_GH_MISSING`,
//! `ERR_RULESET_PLAN_UNSUPPORTED`, `ERR_RULESET_FORBIDDEN`.

use std::path::{Path, PathBuf};

use crate::check_harness::has_extension;
use crate::context::{Context, RunOptions};
use crate::fail::{ScriptError, TaskResult};

const RULESET_DIR: &str = ".github/rulesets";

struct Ruleset {
    file: PathBuf,
    name: String,
    target: String,
}

/// The `*.json` entries of the rulesets directory, sorted by name.
fn list_ruleset_files(dir: &Path) -> Result<Vec<String>, ScriptError> {
    let listing = std::fs::read_dir(dir).ok();
    let exists = listing.is_some();
    let mut files: Vec<String> = listing
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| has_extension(name, &["json"]))
        .collect();
    files.sort();
    if files.is_empty() {
        return Err(ScriptError::new(
            "ERR_RULESET_FILE_MISSING",
            format!("{RULESET_DIR} holds no ruleset definition"),
            format!("at least one committed *.json ruleset under {RULESET_DIR}"),
            if exists {
                format!("no *.json file in {}", dir.display())
            } else {
                format!("no directory at {}", dir.display())
            },
            format!("restore {RULESET_DIR} from version control"),
        ));
    }
    Ok(files)
}

/// A non-empty string field of a JSON object.
fn string_field(parsed: &serde_json::Value, key: &str) -> Option<String> {
    parsed
        .as_object()?
        .get(key)?
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn read_ruleset(root: &Path, entry: &str) -> Result<Ruleset, ScriptError> {
    let relative = format!("{RULESET_DIR}/{entry}");
    let file = root.join(&relative);
    let parsed = std::fs::read_to_string(&file)
        .map_err(|error| error.to_string())
        .and_then(|text| {
            serde_json::from_str::<serde_json::Value>(&text).map_err(|error| error.to_string())
        });
    let fields = match &parsed {
        Err(error) => Err(format!("it is not JSON ({error})")),
        Ok(value) => match (string_field(value, "name"), string_field(value, "target")) {
            (None, _) => Err("it has no non-empty string \"name\"".to_owned()),
            (Some(_), None) => Err("it has no non-empty string \"target\"".to_owned()),
            (Some(name), Some(target)) => Ok((name, target)),
        },
    };
    match fields {
        Ok((name, target)) => Ok(Ruleset { file, name, target }),
        Err(problem) => Err(ScriptError::new(
            "ERR_RULESET_FILE_INVALID",
            format!("{relative} is not a usable ruleset definition"),
            "a JSON object with a string \"name\" and \"target\"",
            problem,
            format!("fix {relative}, or restore it from version control"),
        )),
    }
}

/// Run one `gh` call, turning a failure into the matching `ERR_RULESET_` code; its
/// standard output on success.
fn gh(context: &Context<'_>, action: &str, args: &[&str]) -> Result<String, ScriptError> {
    let result = context.run(
        "gh",
        args,
        &RunOptions {
            cwd: Some(context.root.clone()),
            env: Some(context.env.clone()),
            input: None,
        },
    );
    if !result.started {
        return Err(ScriptError::new(
            "ERR_RULESET_GH_MISSING",
            "'gh' could not be started",
            "the GitHub CLI ('gh') on the caller's PATH, authenticated against this repository",
            result.stderr_text().trim(),
            "install the GitHub CLI and run `gh auth login`",
        ));
    }
    if result.success() {
        return Ok(result.stdout_text());
    }
    let message = result.stderr_text().trim().to_owned();
    if message.to_lowercase().contains("upgrade") {
        return Err(ScriptError::new(
            "ERR_RULESET_PLAN_UNSUPPORTED",
            format!(
                "{action} was refused: rulesets need a paid GitHub plan on a private repository"
            ),
            "GitHub Free supports rulesets on public repositories only",
            message,
            "make the repository public, or use a paid GitHub plan",
        ));
    }
    let actual = match (message.is_empty(), result.status) {
        (false, _) => message,
        (true, Some(status)) => format!("exit status {status}"),
        (true, None) => "gh was stopped by a signal before it exited".to_owned(),
    };
    Err(ScriptError::new(
        "ERR_RULESET_FORBIDDEN",
        format!("{action} was refused"),
        "the GitHub API to accept the request from a repository admin",
        actual,
        "run `gh auth status` and confirm this account is an admin of the repository",
    ))
}

/// A string as `JSON.stringify` quotes it, which is also a jq string literal.
fn quoted(text: &str) -> String {
    serde_json::Value::String(text.to_owned()).to_string()
}

fn apply_one(context: &Context<'_>, repo: &str, ruleset: &Ruleset) -> TaskResult {
    let Ruleset { file, name, target } = ruleset;
    let file = file.to_string_lossy();
    // includes_parents=false: organization rulesets have ids the repository-scoped PUT
    // cannot address. --paginate: a match past the first page is still found.
    let filter = format!(
        ".[] | select(.name == {} and .target == {} and .source_type == \"Repository\") | .id",
        quoted(name),
        quoted(target)
    );
    let listing = gh(
        context,
        &format!("listing rulesets (`gh api repos/{repo}/rulesets`)"),
        &[
            "api",
            "--paginate",
            &format!("repos/{repo}/rulesets?includes_parents=false"),
            "--jq",
            &filter,
        ],
    )?;
    let existing = listing.lines().map(str::trim).find(|line| !line.is_empty());

    let Some(id) = existing else {
        gh(
            context,
            &format!("creating the ruleset {name} (`gh api repos/{repo}/rulesets`)"),
            &[
                "api",
                &format!("repos/{repo}/rulesets"),
                "--method",
                "POST",
                "--input",
                &file,
            ],
        )?;
        context.log(&format!("apply-ruleset: created ruleset {name} in {repo}"));
        return Ok(());
    };
    gh(
        context,
        &format!("updating the ruleset {name} (`gh api repos/{repo}/rulesets/{id}`)"),
        &[
            "api",
            &format!("repos/{repo}/rulesets/{id}"),
            "--method",
            "PUT",
            "--input",
            &file,
        ],
    )?;
    context.log(&format!(
        "apply-ruleset: updated ruleset {name} (id {id}) in {repo}"
    ));
    Ok(())
}

pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    let rulesets = list_ruleset_files(&context.root.join(RULESET_DIR))?
        .iter()
        .map(|entry| read_ruleset(&context.root, entry))
        .collect::<Result<Vec<_>, _>>()?;

    let repo = gh(
        context,
        "resolving the repository (`gh repo view`)",
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

    for ruleset in &rulesets {
        apply_one(context, &repo, ruleset)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::path::Path;

    use tempfile::TempDir;

    use super::main;
    use crate::context::{RunOptions, RunResult};
    use crate::test_support::{Fake, Outcome, env_of, temp_dir, write};

    const VALID: &str = r#"{"name":"main","target":"branch","enforcement":"active"}"#;
    const TAGS: &str = r#"{"name":"release-tags","target":"tag","enforcement":"active"}"#;
    const LIST_MAIN: &str = r#".[] | select(.name == "main" and .target == "branch" and .source_type == "Repository") | .id"#;
    const LIST_TAGS: &str = r#".[] | select(.name == "release-tags" and .target == "tag" and .source_type == "Repository") | .id"#;

    fn ok(stdout: &str) -> RunResult {
        RunResult::exited(0, stdout, "")
    }

    fn refused(stderr: &str) -> RunResult {
        RunResult::exited(1, "", stderr)
    }

    /// A root whose rulesets directory holds `main.json` (when given) and `extra`.
    fn root(ruleset: Option<&str>, extra: &[(&str, &str)]) -> TempDir {
        let dir = temp_dir();
        if let Some(ruleset) = ruleset {
            write(dir.path(), ".github/rulesets/main.json", ruleset);
        }
        for (file, body) in extra {
            write(dir.path(), &format!(".github/rulesets/{file}"), body);
        }
        dir
    }

    fn input(dir: &Path, file: &str) -> String {
        dir.join(".github/rulesets")
            .join(file)
            .to_string_lossy()
            .into_owned()
    }

    struct Applied {
        outcome: Outcome,
        calls: Vec<(String, Vec<String>, RunOptions)>,
    }

    impl Applied {
        fn args(&self) -> Vec<Vec<String>> {
            self.calls.iter().map(|(_, args, _)| args.clone()).collect()
        }
    }

    /// Run the task at `dir`, answering `gh` calls in order from `answers`; a call past
    /// the last answer fails the test.
    fn apply(dir: &Path, answers: Vec<RunResult>) -> Applied {
        let answers = RefCell::new(VecDeque::from(answers));
        let calls = RefCell::new(Vec::new());
        let run = |command: &str, args: &[&str], options: &RunOptions| {
            calls.borrow_mut().push((
                command.to_owned(),
                args.iter().map(ToString::to_string).collect(),
                options.clone(),
            ));
            let answer = answers.borrow_mut().pop_front();
            let Some(answer) = answer else {
                panic!("unexpected call: {command} {}", args.join(" "));
            };
            answer
        };
        let outcome = Fake::at(dir)
            .env(env_of(&[("GH_TOKEN", "fake")]))
            .run(&run)
            .task(main);
        Applied {
            outcome,
            calls: calls.into_inner(),
        }
    }

    #[test]
    fn creates_the_main_ruleset_when_none_with_its_name_and_target_exists() {
        let dir = root(Some(VALID), &[]);
        let applied = apply(dir.path(), vec![ok("owner/repo\n"), ok(""), ok("{}")]);
        applied.outcome.assert_ok();
        assert!(
            applied
                .calls
                .iter()
                .all(|(command, _, options)| command == "gh"
                    && options.cwd.as_deref() == Some(dir.path())
                    && options.env == Some(env_of(&[("GH_TOKEN", "fake")])))
        );
        assert_eq!(
            applied.args(),
            [
                vec![
                    "repo".to_owned(),
                    "view".to_owned(),
                    "--json".to_owned(),
                    "nameWithOwner".to_owned(),
                    "--jq".to_owned(),
                    ".nameWithOwner".to_owned()
                ],
                vec![
                    "api".to_owned(),
                    "--paginate".to_owned(),
                    "repos/owner/repo/rulesets?includes_parents=false".to_owned(),
                    "--jq".to_owned(),
                    LIST_MAIN.to_owned()
                ],
                vec![
                    "api".to_owned(),
                    "repos/owner/repo/rulesets".to_owned(),
                    "--method".to_owned(),
                    "POST".to_owned(),
                    "--input".to_owned(),
                    input(dir.path(), "main.json")
                ],
            ]
        );
        assert_eq!(
            applied.outcome.lines,
            ["apply-ruleset: created ruleset main in owner/repo"]
        );
    }

    #[test]
    fn updates_the_first_existing_ruleset_named_main_in_place() {
        let dir = root(Some(VALID), &[]);
        let applied = apply(
            dir.path(),
            vec![ok("owner/repo\n"), ok("\n42\n77\n"), ok("{}")],
        );
        applied.outcome.assert_ok();
        assert_eq!(
            applied.args()[2],
            [
                "api".to_owned(),
                "repos/owner/repo/rulesets/42".to_owned(),
                "--method".to_owned(),
                "PUT".to_owned(),
                "--input".to_owned(),
                input(dir.path(), "main.json")
            ]
        );
        assert_eq!(
            applied.outcome.lines,
            ["apply-ruleset: updated ruleset main (id 42) in owner/repo"]
        );
    }

    #[test]
    fn fails_when_the_rulesets_directory_is_missing() {
        let dir = root(None, &[]);
        let applied = apply(dir.path(), vec![]);
        let error = applied.outcome.failure();
        assert_eq!(error.code(), "ERR_RULESET_FILE_MISSING");
        assert!(error.details.actual.starts_with("no directory at "));
        assert!(applied.calls.is_empty());
    }

    #[test]
    fn fails_when_the_rulesets_directory_holds_no_json_file() {
        let dir = root(None, &[("README.txt", "x")]);
        let applied = apply(dir.path(), vec![]);
        let error = applied.outcome.failure();
        assert_eq!(error.code(), "ERR_RULESET_FILE_MISSING");
        assert!(error.details.actual.starts_with("no *.json file in "));
        assert!(applied.calls.is_empty());
    }

    #[test]
    fn fails_when_a_ruleset_file_is_not_a_usable_definition() {
        for (case, body, actual) in [
            ("not JSON", "{ nope", "it is not JSON ("),
            (
                "nameless",
                r#"{"target":"branch"}"#,
                "it has no non-empty string \"name\"",
            ),
            (
                "an empty name",
                r#"{"name":"","target":"branch"}"#,
                "it has no non-empty string \"name\"",
            ),
            (
                "a name that is not a string",
                r#"{"name":1,"target":"branch"}"#,
                "it has no non-empty string \"name\"",
            ),
            (
                "targetless",
                r#"{"name":"main"}"#,
                "it has no non-empty string \"target\"",
            ),
            ("not an object", "[]", "it has no non-empty string \"name\""),
            ("null", "null", "it has no non-empty string \"name\""),
        ] {
            let dir = root(Some(body), &[]);
            let applied = apply(dir.path(), vec![]);
            let error = applied.outcome.failure();
            assert_eq!(error.code(), "ERR_RULESET_FILE_INVALID", "{case}");
            assert!(error.details.actual.starts_with(actual), "{case}");
            assert!(applied.calls.is_empty(), "{case}");
        }
    }

    #[test]
    fn reports_a_ruleset_path_it_cannot_read_as_not_json() {
        let dir = root(Some(VALID), &[]);
        std::fs::create_dir(dir.path().join(".github/rulesets/zz.json")).expect("a directory");
        let applied = apply(dir.path(), vec![]);
        let error = applied.outcome.failure();
        assert_eq!(error.code(), "ERR_RULESET_FILE_INVALID");
        assert!(error.details.summary.contains("zz.json"));
    }

    #[test]
    fn creates_every_ruleset_file_by_its_own_name_and_target() {
        let dir = root(
            Some(VALID),
            &[("release-tags.json", TAGS), ("notes.txt", "ignored")],
        );
        let applied = apply(
            dir.path(),
            vec![ok("owner/repo\n"), ok(""), ok("{}"), ok(""), ok("{}")],
        );
        applied.outcome.assert_ok();
        let args = applied.args();
        assert_eq!(
            args[1..],
            [
                vec![
                    "api".to_owned(),
                    "--paginate".to_owned(),
                    "repos/owner/repo/rulesets?includes_parents=false".to_owned(),
                    "--jq".to_owned(),
                    LIST_MAIN.to_owned()
                ],
                vec![
                    "api".to_owned(),
                    "repos/owner/repo/rulesets".to_owned(),
                    "--method".to_owned(),
                    "POST".to_owned(),
                    "--input".to_owned(),
                    input(dir.path(), "main.json")
                ],
                vec![
                    "api".to_owned(),
                    "--paginate".to_owned(),
                    "repos/owner/repo/rulesets?includes_parents=false".to_owned(),
                    "--jq".to_owned(),
                    LIST_TAGS.to_owned()
                ],
                vec![
                    "api".to_owned(),
                    "repos/owner/repo/rulesets".to_owned(),
                    "--method".to_owned(),
                    "POST".to_owned(),
                    "--input".to_owned(),
                    input(dir.path(), "release-tags.json")
                ],
            ]
        );
        assert_eq!(
            applied.outcome.lines,
            [
                "apply-ruleset: created ruleset main in owner/repo",
                "apply-ruleset: created ruleset release-tags in owner/repo",
            ]
        );
    }

    #[test]
    fn updates_an_existing_tag_ruleset_while_creating_a_missing_branch_ruleset() {
        let dir = root(Some(VALID), &[("release-tags.json", TAGS)]);
        let applied = apply(
            dir.path(),
            vec![ok("owner/repo\n"), ok(""), ok("{}"), ok("9\n"), ok("{}")],
        );
        applied.outcome.assert_ok();
        let args = applied.args();
        assert_eq!(
            args[4],
            [
                "api".to_owned(),
                "repos/owner/repo/rulesets/9".to_owned(),
                "--method".to_owned(),
                "PUT".to_owned(),
                "--input".to_owned(),
                input(dir.path(), "release-tags.json")
            ]
        );
        assert_eq!(
            applied.outcome.lines[1],
            "apply-ruleset: updated ruleset release-tags (id 9) in owner/repo"
        );
        assert!(!args.iter().flatten().any(|arg| arg == "DELETE"));
    }

    #[test]
    fn applies_nothing_when_any_ruleset_file_is_nameless() {
        let dir = root(Some(VALID), &[("release-tags.json", r#"{"target":"tag"}"#)]);
        let applied = apply(dir.path(), vec![]);
        let error = applied.outcome.failure();
        assert_eq!(error.code(), "ERR_RULESET_FILE_INVALID");
        assert!(error.details.summary.contains("release-tags.json"));
        assert!(applied.calls.is_empty());
    }

    #[test]
    fn fails_when_gh_cannot_be_started() {
        let dir = root(Some(VALID), &[]);
        let applied = apply(
            dir.path(),
            vec![RunResult {
                status: None,
                started: false,
                stdout: Vec::new(),
                stderr: b"gh: No such file or directory (os error 2)".to_vec(),
            }],
        );
        let error = applied.outcome.failure();
        assert_eq!(error.code(), "ERR_RULESET_GH_MISSING");
        assert!(error.details.actual.contains("No such file"));
    }

    #[test]
    fn maps_a_plan_gated_refusal_to_err_ruleset_plan_unsupported() {
        let dir = root(Some(VALID), &[]);
        let applied = apply(
            dir.path(),
            vec![
                ok("owner/repo\n"),
                refused("HTTP 403: Upgrade to GitHub Pro or make this repository public"),
            ],
        );
        assert_eq!(applied.outcome.code(), "ERR_RULESET_PLAN_UNSUPPORTED");
    }

    #[test]
    fn maps_any_other_refusal_to_err_ruleset_forbidden() {
        let dir = root(Some(VALID), &[]);
        let applied = apply(dir.path(), vec![refused("HTTP 401: Bad credentials\n")]);
        let error = applied.outcome.failure();
        assert_eq!(error.code(), "ERR_RULESET_FORBIDDEN");
        assert_eq!(error.details.actual, "HTTP 401: Bad credentials");
    }

    #[test]
    fn classifies_a_refused_write_the_same_way() {
        let dir = root(Some(VALID), &[]);
        let applied = apply(
            dir.path(),
            vec![
                ok("owner/repo\n"),
                ok("7\n"),
                refused("HTTP 404: Not Found"),
            ],
        );
        let error = applied.outcome.failure();
        assert_eq!(error.code(), "ERR_RULESET_FORBIDDEN");
        assert!(error.details.summary.contains("updating the ruleset main"));
    }

    #[test]
    fn names_the_exit_status_or_signal_when_a_refusing_gh_prints_nothing() {
        let dir = root(Some(VALID), &[]);
        let applied = apply(dir.path(), vec![RunResult::exited(2, "", "")]);
        assert_eq!(applied.outcome.failure().details.actual, "exit status 2");
        let applied = apply(
            dir.path(),
            vec![RunResult {
                status: None,
                started: true,
                stdout: Vec::new(),
                stderr: Vec::new(),
            }],
        );
        let error = applied.outcome.failure();
        assert_eq!(error.code(), "ERR_RULESET_FORBIDDEN");
        assert!(error.details.actual.contains("signal"));
    }
}
