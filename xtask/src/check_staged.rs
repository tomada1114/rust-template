//! `cargo xtask check-staged`, the staged guard: refuse a commit that would put a secret
//! into history, judged from the git index alone. The pre-commit hook runs it
//! (`lefthook.yml`).
//!
//! Two phases per staged path: the path (`xtask-guard`'s `blocked_path_reason`), then —
//! only if the path passes — the staged blob (`xtask-guard`'s `CredentialRules`), read by
//! blob id from the index through one `git cat-file --batch` for the whole run, so a
//! partially staged file is judged as it will be committed. Every finding is collected
//! before failing once. Output never contains file content: a finding names the path and
//! the rule, never the matched text.
//!
//! Deletions are never inspected (a deletion cannot add a secret, and refusing it would
//! block the commit that removes one). Spawned git keeps `GIT_INDEX_FILE`, which
//! `git commit -- <path>` uses for its temporary index, and drops every other `GIT_*`.
//!
//! Git work tree: required; outside one it refuses.
//!
//! Errors: `ERR_STAGED_NOT_A_REPO`, `ERR_STAGED_READ_FAILED`, `ERR_STAGED_BLOCKED_PATH`,
//! `ERR_STAGED_CREDENTIAL_SHAPED` (the first finding's code when there are several).

use xtask_guard::{CredentialRules, blocked_path_reason};

use crate::context::{Context, RunOptions, RunResult};
use crate::fail::{ScriptError, TaskResult};
use crate::git_env::staged_guard_env;

const GITLINK_MODE: &str = "160000";

/// One staged path, from `git diff --cached --raw`.
struct StagedEntry {
    mode: String,
    blob: String,
    path: String,
}

/// Parse `git diff --cached --raw -z`: a `:<modes> <ids> <status>` field, then the path.
fn parse_raw(output: &[u8]) -> Vec<StagedEntry> {
    let fields: Vec<&[u8]> = output.split(|byte| *byte == 0).collect();
    fields
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let meta = String::from_utf8_lossy(pair[0]);
            let words: Vec<&str> = meta.split(' ').collect();
            StagedEntry {
                mode: words.get(1).copied().unwrap_or_default().to_owned(),
                blob: words.get(3).copied().unwrap_or_default().to_owned(),
                path: String::from_utf8_lossy(pair[1]).into_owned(),
            }
        })
        .collect()
}

fn read_failed(summary: String, expected: &str, actual: String) -> ScriptError {
    ScriptError::new(
        "ERR_STAGED_READ_FAILED",
        summary,
        expected,
        actual,
        "check `git status` and the index, then retry the commit",
    )
}

/// Read every blob through one `git cat-file --batch`, whose output is a
/// `<id> blob <size>\n<content>\n` frame per requested id (or `<id> missing\n`). Each
/// blob is decoded as UTF-8, invalid sequences replaced. Any frame that is not the blob
/// asked for fails closed.
/// Runs git with optional standard input.
type Git<'a> = &'a dyn Fn(Option<Vec<u8>>, &[&str]) -> RunResult;

fn read_blobs(git: Git<'_>, entries: &[&StagedEntry]) -> Result<Vec<String>, ScriptError> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let expected = "`git cat-file --batch` to print every staged blob";
    let mut input = String::new();
    for entry in entries {
        input.push_str(&entry.blob);
        input.push('\n');
    }
    let batch = git(Some(input.into_bytes()), &["cat-file", "--batch"]);
    if !batch.success() {
        return Err(read_failed(
            "could not read the staged content".to_owned(),
            expected,
            batch.stderr_text().trim().to_owned(),
        ));
    }
    let out = &batch.stdout;
    let mut offset = 0;
    let mut contents = Vec::with_capacity(entries.len());
    for entry in entries {
        let rest = out.get(offset..).unwrap_or_default();
        let header_end = rest.iter().position(|byte| *byte == b'\n');
        let header_bytes = header_end.map_or(rest, |end| &rest[..end]);
        let header = String::from_utf8_lossy(header_bytes);
        let fields: Vec<&str> = header.split(' ').collect();
        let size = fields
            .get(2)
            .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|text| text.parse::<usize>().ok());
        let frame = header_end.zip(size).and_then(|(end, size)| {
            let start = offset + end + 1;
            let body = out.get(start..start + size)?;
            (out.get(start + size) == Some(&b'\n')).then_some((body, start + size + 1))
        });
        match frame {
            Some((body, next))
                if fields.first() == Some(&entry.blob.as_str())
                    && fields.get(1) == Some(&"blob") =>
            {
                contents.push(String::from_utf8_lossy(body).into_owned());
                offset = next;
            }
            _ => {
                let shown: String = header.chars().take(200).collect();
                return Err(read_failed(
                    format!("could not read the staged content of {}", entry.path),
                    expected,
                    format!(
                        "`git cat-file --batch` answered `{shown}` for {}",
                        entry.blob
                    ),
                ));
            }
        }
    }
    Ok(contents)
}

/// One refused path.
struct Finding {
    code: &'static str,
    line: String,
}

pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    let rules = CredentialRules::new()
        .map_err(|error| ScriptError::unexpected("compiling the credential rules", &error))?;
    let env = staged_guard_env(&context.env);
    let git_with = |input: Option<Vec<u8>>, args: &[&str]| {
        context.run(
            "git",
            args,
            &RunOptions {
                cwd: Some(context.root.clone()),
                env: Some(env.clone()),
                input,
            },
        )
    };
    let git = |args: &[&str]| git_with(None, args);

    if git(&["rev-parse", "--is-inside-work-tree"])
        .stdout_text()
        .trim()
        != "true"
    {
        return Err(ScriptError::new(
            "ERR_STAGED_NOT_A_REPO",
            "not inside a git work tree",
            "to run from inside the repository whose index is being committed",
            format!(
                "`git rev-parse --is-inside-work-tree` did not print true in {}",
                context.root.display()
            ),
            "cd into the repository and re-run `cargo xtask check-staged`",
        ));
    }

    // --no-renames reports a rename as a deletion plus an addition, so the new path is
    // always the only path in an entry.
    let listed = git(&[
        "diff",
        "--cached",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        "--diff-filter=ACMRT",
    ]);
    if !listed.success() {
        return Err(read_failed(
            "could not list the staged changes".to_owned(),
            "`git diff --cached --raw` to exit 0",
            listed.stderr_text().trim().to_owned(),
        ));
    }

    let entries = parse_raw(&listed.stdout);
    // A submodule's entry names a commit elsewhere: there is no blob here to read.
    let to_read: Vec<&StagedEntry> = entries
        .iter()
        .filter(|entry| blocked_path_reason(&entry.path).is_none() && entry.mode != GITLINK_MODE)
        .collect();
    let mut contents = read_blobs(&git_with, &to_read)?.into_iter();

    let mut findings = Vec::new();
    for entry in &entries {
        if let Some(reason) = blocked_path_reason(&entry.path) {
            findings.push(Finding {
                code: "ERR_STAGED_BLOCKED_PATH",
                line: format!("{} — {reason}", entry.path),
            });
            continue;
        }
        if entry.mode == GITLINK_MODE {
            continue;
        }
        // `to_read` is `entries` in the same order with these two kinds left out, so the
        // next content is this entry's.
        let Some(text) = contents.next() else {
            continue;
        };
        if let Some(category) = rules.category(&text) {
            findings.push(Finding {
                code: "ERR_STAGED_CREDENTIAL_SHAPED",
                line: format!("{} — content matches the {category} pattern", entry.path),
            });
        }
    }

    let Some(first) = findings.first() else {
        return Ok(());
    };
    // `git restore --staged` resets a path to HEAD, which during a merge also throws away
    // the other side's change to it.
    let merging = git(&["rev-parse", "-q", "--verify", "MERGE_HEAD"]).success();
    Err(ScriptError::new(
        first.code,
        format!(
            "{} staged path(s) refused (the matched text is never printed)",
            findings.len()
        ),
        "no staged path matching xtask/guard/src/paths.rs and no staged content matching xtask/guard/src/credentials.rs",
        findings
            .iter()
            .map(|finding| format!("{}: {}", finding.code, finding.line))
            .collect::<Vec<_>>()
            .join("\n"),
        if merging {
            "a merge is in progress, so never `git restore --staged` (it would drop the other side's change): remove the secret from each file and `git add` it again, or `git rm --cached <path>` a secret-shaped path; keep the value in the keychain or a CI secret and reference it"
        } else {
            "unstage each file with `git restore --staged <path>`; keep the value in the keychain or a CI secret and reference it; if the file must be committed, remove the secret first"
        },
    ))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::Path;

    use super::main;
    use crate::context::{RunOptions, RunResult, run_command};
    use crate::test_support::{
        Fake, Outcome, committed_repo, git, git_with, hook_env, temp_dir, write,
    };

    // Assembled at runtime: this file must never hold a credential-shaped literal.
    fn aws_key_id() -> String {
        ["AK", "IA", "ABCDEFGHIJKLMNOP"].concat()
    }

    fn guard(root: &Path) -> Outcome {
        Fake::at(root).env(hook_env()).task(main)
    }

    fn zeros() -> String {
        "0".repeat(40)
    }

    /// A fake git that answers `rev-parse` with true, `diff` with `listing`, and
    /// `cat-file` with `batch`.
    fn fake_git<'a>(
        listing: &'a str,
        batch: &'a dyn Fn(&RunOptions) -> RunResult,
    ) -> impl Fn(&str, &[&str], &RunOptions) -> RunResult + 'a {
        move |_command, args, options| match args.first().copied() {
            Some("rev-parse") => RunResult::exited(0, "true\n", ""),
            Some("diff") => RunResult::exited(0, listing, ""),
            _ => batch(options),
        }
    }

    #[test]
    fn passes_a_clean_staged_change() {
        let repo = committed_repo();
        write(repo.path(), "notes.txt", "nothing secret\n");
        git(repo.path(), &["add", "notes.txt"]);
        guard(repo.path()).assert_ok();
    }

    #[test]
    fn refuses_a_secret_shaped_path_by_name_without_reading_it() {
        let repo = committed_repo();
        write(repo.path(), ".env", "harmless\n");
        git(repo.path(), &["add", ".env"]);
        let error = guard(repo.path()).failure();
        assert_eq!(error.code(), "ERR_STAGED_BLOCKED_PATH");
        assert!(error.details.actual.contains(".env — an environment file"));
    }

    #[test]
    fn refuses_credential_shaped_content_and_never_prints_it() {
        let repo = committed_repo();
        write(
            repo.path(),
            "config.txt",
            format!("key = {}\n", aws_key_id()),
        );
        git(repo.path(), &["add", "config.txt"]);
        let error = guard(repo.path()).failure();
        assert_eq!(error.code(), "ERR_STAGED_CREDENTIAL_SHAPED");
        assert!(
            error
                .details
                .actual
                .contains("config.txt — content matches the aws-access-key-id pattern")
        );
        assert!(!error.to_string().contains(&aws_key_id()));
    }

    #[test]
    fn advises_restaging_never_restoring_to_head_while_a_merge_is_in_progress() {
        let repo = committed_repo();
        let root = repo.path();
        git(root, &["switch", "-q", "-c", "side"]);
        write(root, "README.md", "side\n");
        git(root, &["commit", "-q", "--no-verify", "-am", "side"]);
        git(root, &["switch", "-q", "-"]);
        write(root, "README.md", "main\n");
        git(root, &["commit", "-q", "--no-verify", "-am", "main"]);
        let merge = run_command(
            "git",
            &["merge", "side"],
            &RunOptions {
                cwd: Some(root.to_path_buf()),
                env: Some(hook_env()),
                input: None,
            },
        );
        assert!(!merge.success());
        write(root, "README.md", format!("resolved\n{}\n", aws_key_id()));
        git(root, &["add", "README.md"]);

        let error = guard(root).failure();
        assert_eq!(error.code(), "ERR_STAGED_CREDENTIAL_SHAPED");
        assert!(error.details.next.contains("`git add` it again"));
        assert!(!error.details.next.contains("`git restore --staged <path>`"));
    }

    #[test]
    fn advises_unstaging_outside_a_merge() {
        let repo = committed_repo();
        write(repo.path(), "a.txt", format!("{}\n", aws_key_id()));
        git(repo.path(), &["add", "a.txt"]);
        assert!(
            guard(repo.path())
                .failure()
                .details
                .next
                .contains("`git restore --staged <path>`")
        );
    }

    #[test]
    fn names_every_finding_in_one_run_in_staged_order() {
        let repo = committed_repo();
        write(repo.path(), ".env", "x\n");
        write(repo.path(), "a.txt", format!("{}\n", aws_key_id()));
        git(repo.path(), &["add", ".env", "a.txt"]);
        let error = guard(repo.path()).failure();
        assert_eq!(error.code(), "ERR_STAGED_BLOCKED_PATH");
        assert_eq!(
            error.details.actual,
            [
                "ERR_STAGED_BLOCKED_PATH: .env — an environment file (`.env` or `.env.*`) can hold real values",
                "ERR_STAGED_CREDENTIAL_SHAPED: a.txt — content matches the aws-access-key-id pattern",
            ]
            .join("\n")
        );
        assert!(
            error
                .details
                .summary
                .starts_with("2 staged path(s) refused")
        );
    }

    #[test]
    fn judges_the_staged_blob_not_the_worktree() {
        let repo = committed_repo();
        let root = repo.path();
        write(root, "a.txt", "clean\n");
        git(root, &["add", "a.txt"]);
        write(root, "a.txt", format!("{}\n", aws_key_id())); // unstaged edit
        guard(root).assert_ok();

        write(root, "b.txt", format!("{}\n", aws_key_id()));
        git(root, &["add", "b.txt"]);
        write(root, "b.txt", "clean now\n"); // the index still holds the secret
        assert_eq!(guard(root).code(), "ERR_STAGED_CREDENTIAL_SHAPED");
    }

    #[test]
    fn judges_a_large_staged_blob_whole() {
        let repo = committed_repo();
        let root = repo.path();
        let large = format!("{}\n", "a".repeat(1023)).repeat(2 * 1024); // 2 MiB
        write(root, "large.txt", &large);
        git(root, &["add", "large.txt"]);
        guard(root).assert_ok();

        // The secret sits past the first MiB, so a truncated read would miss it.
        write(root, "large-leak.txt", format!("{large}{}\n", aws_key_id()));
        git(root, &["add", "large-leak.txt"]);
        let error = guard(root).failure();
        assert_eq!(error.code(), "ERR_STAGED_CREDENTIAL_SHAPED");
        assert!(error.details.actual.contains("large-leak.txt"));
        assert!(!error.details.actual.contains("large.txt —"));
    }

    #[test]
    fn lets_a_commit_delete_a_file_that_held_a_secret() {
        let repo = committed_repo();
        let root = repo.path();
        write(root, "leak.txt", format!("{}\n", aws_key_id()));
        git(root, &["add", "leak.txt"]);
        git(root, &["commit", "-q", "--no-verify", "-m", "leak"]);
        git(root, &["rm", "-q", "leak.txt"]);
        guard(root).assert_ok();
    }

    #[test]
    fn refuses_a_rename_onto_a_blocked_name() {
        let repo = committed_repo();
        git(repo.path(), &["mv", "README.md", "secrets.json"]);
        assert!(
            guard(repo.path())
                .failure()
                .details
                .actual
                .contains("secrets.json")
        );
    }

    #[test]
    fn reads_the_index_git_index_file_names_as_in_git_commit_with_paths() {
        let repo = committed_repo();
        let root = repo.path();
        let index = root.join(".git").join("alt-index");
        write(root, "a.txt", format!("{}\n", aws_key_id()));
        let mut with_index = hook_env();
        with_index.insert("GIT_INDEX_FILE".to_owned(), index.display().to_string());
        git_with(root, &["read-tree", "HEAD"], &with_index);
        git_with(root, &["add", "a.txt"], &with_index);
        guard(root).assert_ok();
        assert_eq!(
            Fake::at(root).env(with_index).task(main).code(),
            "ERR_STAGED_CREDENTIAL_SHAPED"
        );
    }

    #[test]
    fn ignores_an_inherited_git_dir() {
        let repo = committed_repo();
        write(repo.path(), "a.txt", format!("{}\n", aws_key_id()));
        git(repo.path(), &["add", "a.txt"]);
        let mut env = hook_env();
        env.insert("GIT_DIR".to_owned(), "/nowhere".to_owned());
        assert_eq!(
            Fake::at(repo.path()).env(env).task(main).code(),
            "ERR_STAGED_CREDENTIAL_SHAPED"
        );
    }

    #[test]
    fn refuses_to_run_outside_a_git_work_tree() {
        let dir = temp_dir();
        assert_eq!(guard(dir.path()).code(), "ERR_STAGED_NOT_A_REPO");
    }

    #[test]
    fn fails_closed_when_the_staged_list_cannot_be_read() {
        let run = |_: &str, args: &[&str], _: &RunOptions| {
            if args.first() == Some(&"rev-parse") {
                RunResult::exited(0, "true\n", "")
            } else {
                RunResult::exited(128, "", "boom")
            }
        };
        let error = Fake::at(Path::new("/nowhere"))
            .run(&run)
            .task(main)
            .failure();
        assert_eq!(error.code(), "ERR_STAGED_READ_FAILED");
        assert_eq!(error.details.actual, "boom");
    }

    #[test]
    fn fails_closed_when_a_staged_blob_cannot_be_read() {
        let listing = format!(":000000 100644 {} {} A\0a.txt\0", zeros(), "a".repeat(40));
        let batch = |_: &RunOptions| RunResult::exited(128, "", "bad object");
        let run = fake_git(&listing, &batch);
        let error = Fake::at(Path::new("/nowhere"))
            .run(&run)
            .task(main)
            .failure();
        assert_eq!(error.code(), "ERR_STAGED_READ_FAILED");
        assert_eq!(error.details.actual, "bad object");
    }

    #[test]
    fn reads_every_staged_blob_through_one_git_cat_file_batch() {
        let repo = committed_repo();
        let root = repo.path();
        for i in 0..5 {
            write(root, &format!("f{i}.txt"), format!("clean {i}\n"));
        }
        write(root, "multi.txt", "na\u{ef}ve \u{2603}\n");
        write(root, "f9.txt", format!("{}\n", aws_key_id()));
        git(root, &["add", "."]);
        let cat_files = RefCell::new(Vec::new());
        let run = |command: &str, args: &[&str], options: &RunOptions| {
            if args.first() == Some(&"cat-file") {
                cat_files
                    .borrow_mut()
                    .push(args.iter().map(ToString::to_string).collect::<Vec<_>>());
            }
            run_command(command, args, options)
        };
        let error = Fake::at(root)
            .env(hook_env())
            .run(&run)
            .task(main)
            .failure();
        assert_eq!(cat_files.into_inner(), vec![vec!["cat-file", "--batch"]]);
        assert_eq!(
            error.details.actual,
            "ERR_STAGED_CREDENTIAL_SHAPED: f9.txt — content matches the aws-access-key-id pattern"
        );
    }

    #[test]
    fn fails_closed_when_batch_reports_a_staged_blob_missing() {
        let present = "a".repeat(40);
        let missing = "c".repeat(40);
        let listing = format!(
            ":000000 100644 {z} {present} A\0a.txt\0:000000 100644 {z} {missing} A\0b.txt\0",
            z = zeros()
        );
        let answer = format!("{present} blob 3\nok\n\n{missing} missing\n");
        let batch = |_: &RunOptions| RunResult::exited(0, &answer, "");
        let run = fake_git(&listing, &batch);
        let error = Fake::at(Path::new("/nowhere"))
            .run(&run)
            .task(main)
            .failure();
        assert_eq!(error.code(), "ERR_STAGED_READ_FAILED");
        assert!(error.details.summary.contains("b.txt"));
        assert!(error.details.actual.contains(&format!("{missing} missing")));
    }

    #[test]
    fn fails_closed_on_a_truncated_or_mismatched_batch_frame() {
        let blob = "a".repeat(40);
        let listing = format!(":000000 100644 {} {blob} A\0a.txt\0", zeros());
        for answer in [
            format!("{blob} blob 10\nshort"),
            format!("{blob} blob 3\nokX"),
            format!("{blob} blob x\nok\n"),
            format!("{blob} tree 3\nok\n"),
            format!("{} blob 3\nok\n", "b".repeat(40)),
            format!("{blob} blob 3"),
        ] {
            let batch = |_: &RunOptions| RunResult::exited(0, &answer, "");
            let run = fake_git(&listing, &batch);
            assert_eq!(
                Fake::at(Path::new("/nowhere")).run(&run).task(main).code(),
                "ERR_STAGED_READ_FAILED",
                "{answer:?}"
            );
        }
    }

    #[test]
    fn skips_a_gitlink_inside_a_batch_and_reads_only_the_blobs() {
        let blob = "a".repeat(40);
        let commit = "b".repeat(40);
        let listing = format!(
            ":000000 160000 {z} {commit} A\0vendor/lib\0:000000 100644 {z} {blob} A\0a.txt\0",
            z = zeros()
        );
        let inputs = RefCell::new(Vec::new());
        let answer = format!("{blob} blob 3\nok\n\n");
        {
            let batch = |options: &RunOptions| {
                inputs.borrow_mut().push(options.input.clone());
                RunResult::exited(0, &answer, "")
            };
            let run = fake_git(&listing, &batch);
            Fake::at(Path::new("/nowhere"))
                .run(&run)
                .task(main)
                .assert_ok();
        }
        assert_eq!(
            inputs.into_inner(),
            vec![Some(format!("{blob}\n").into_bytes())]
        );
    }

    #[test]
    fn skips_a_submodule_entry_which_has_no_blob_to_scan() {
        let listing = format!(
            ":000000 160000 {} {} A\0vendor/lib\0",
            zeros(),
            "b".repeat(40)
        );
        let calls = RefCell::new(Vec::new());
        let run = |_: &str, args: &[&str], _: &RunOptions| {
            calls
                .borrow_mut()
                .push(args.first().copied().unwrap_or_default().to_owned());
            if args.first() == Some(&"rev-parse") {
                RunResult::exited(0, "true\n", "")
            } else {
                RunResult::exited(0, &listing, "")
            }
        };
        Fake::at(Path::new("/nowhere"))
            .run(&run)
            .task(main)
            .assert_ok();
        assert_eq!(calls.into_inner(), vec!["rev-parse", "diff"]);
    }
}
