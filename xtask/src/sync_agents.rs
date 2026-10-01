//! `cargo xtask sync-agents`: mirrors `.agents/skills/` into `.claude/skills/`, byte for
//! byte and executable bit for executable bit (the two things git records about a file).
//!
//! ```text
//! cargo xtask sync-agents                    make the mirror equal the source (`just agents-sync`)
//! cargo xtask sync-agents --check            report drift, write nothing (`just agents-check`)
//! cargo xtask sync-agents --check --staged   report drift in the git index (the pre-commit hook)
//! ```
//!
//! Skills are authored once, under `.agents/skills/` — the path Codex CLI reads. Claude
//! Code reads only `.claude/skills/`, so the same tree has to exist there too. It is a
//! real, committed copy, never a symlink: a link does not survive a fresh clone on every
//! platform, and Codex follows a linked directory into its subdirectories and registers a
//! nested `references/SKILL.md` as a skill of its own. Both modes ignore `.DS_Store`,
//! which Finder drops into any directory it has shown, and Python bytecode
//! (`__pycache__/`, `*.pyc`), which a skill's bundled tests write when run directly; both
//! are gitignored. They never write outside `.claude/skills/`.
//!
//! `--staged` judges what the commit will contain rather than the working tree: it
//! compares the blob id and mode the index records under each tree, so staging an edited
//! source without its synced mirror (or the reverse) is drift even when both working
//! copies match. An intent-to-add entry (`git add -N`) is skipped: the commit will not
//! contain it. It keeps `GIT_INDEX_FILE`, which `git commit -- <path>` points at a
//! temporary index, and drops every other `GIT_*` variable.
//!
//! Git work tree: `--staged` refuses outside one (`ERR_AGENTS_NOT_A_REPO`); the
//! working-tree modes need no git.
//!
//! Errors: `ERR_AGENTS_USAGE`, `ERR_AGENTS_SOURCE_MISSING`, `ERR_AGENTS_SYMLINK`,
//! `ERR_AGENTS_MIRROR_NOT_DIRECTORY`, `ERR_AGENTS_NOT_A_REPO`,
//! `ERR_AGENTS_INDEX_UNREADABLE`, `ERR_AGENTS_SOURCE_NOT_STAGED`, `ERR_AGENTS_DRIFT`.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, Metadata};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use crate::context::{Context, RunOptions};
use crate::fail::{ScriptError, TaskResult};
use crate::git_env::staged_guard_env;

/// Authoring copy: what a human or an agent edits.
const SOURCE: &str = ".agents/skills";
/// Generated copy: committed, never hand-edited.
const MIRROR: &str = ".claude/skills";
const SYMLINK_MODE: &str = "120000";

/// Whether a file or directory name is local debris neither tree carries.
fn ignored(name: &str) -> bool {
    name == ".DS_Store"
        || name == "__pycache__"
        || name
            .rsplit_once('.')
            .is_some_and(|(_, extension)| extension == "pyc")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Missing,
    Extra,
    Differs,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Extra => "extra",
            Self::Differs => "differs",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Difference {
    kind: Kind,
    relative: String,
}

fn io_error(what: &str, path: &Path, error: &io::Error) -> ScriptError {
    ScriptError::unexpected(&format!("{what} {}", path.display()), error)
}

/// `lstat` that answers `None` for a path that does not exist.
fn stat(path: &Path) -> Result<Option<Metadata>, ScriptError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error("reading", path, &error)),
    }
}

fn symlink_error(label: &str, entry: &str) -> ScriptError {
    ScriptError::new(
        "ERR_AGENTS_SYMLINK",
        format!("{label} is a symlink"),
        format!(
            "real files and directories only under {SOURCE}/ and {MIRROR}/, so both copies work from a fresh clone"
        ),
        format!("a symlink at {entry}"),
        format!(
            "replace it with a real file or directory (author under {SOURCE}/), then run `just agents-sync`"
        ),
    )
}

/// Every regular file under `directory` (absent: none), relative, `/`-separated, sorted.
fn list_files(directory: &Path, label: &str) -> Result<Vec<String>, ScriptError> {
    fn visit(
        current: &Path,
        prefix: &str,
        label: &str,
        files: &mut Vec<String>,
    ) -> Result<(), ScriptError> {
        let entries =
            fs::read_dir(current).map_err(|error| io_error("listing", current, &error))?;
        for entry in entries {
            let entry = entry.map_err(|error| io_error("listing", current, &error))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if ignored(&name) {
                continue;
            }
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let kind = entry
                .file_type()
                .map_err(|error| io_error("reading", &entry.path(), &error))?;
            if kind.is_dir() {
                visit(&current.join(&name), &relative, label, files)?;
            } else if kind.is_file() {
                files.push(relative);
            } else {
                let shown = format!("{label}/{relative}");
                return Err(symlink_error(&shown, &shown));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    if stat(directory)?.is_some() {
        visit(directory, "", label, &mut files)?;
    }
    files.sort();
    Ok(files)
}

/// Whether git would record the file as executable (100755): the owner's execute bit.
fn executable(path: &Path) -> Result<bool, ScriptError> {
    let metadata = fs::metadata(path).map_err(|error| io_error("reading", path, &error))?;
    Ok(metadata.permissions().mode() & 0o100 != 0)
}

fn same_file(a: &Path, b: &Path) -> Result<bool, ScriptError> {
    if executable(a)? != executable(b)? {
        return Ok(false);
    }
    let read = |path: &Path| fs::read(path).map_err(|error| io_error("reading", path, &error));
    Ok(read(a)? == read(b)?)
}

fn diff_trees(source: &Path, mirror: &Path) -> Result<Vec<Difference>, ScriptError> {
    let mut mirror_files: BTreeSet<String> = list_files(mirror, MIRROR)?.into_iter().collect();
    let mut differences = Vec::new();
    for relative in list_files(source, SOURCE)? {
        if !mirror_files.remove(&relative) {
            differences.push(Difference {
                kind: Kind::Missing,
                relative,
            });
        } else if !same_file(&source.join(&relative), &mirror.join(&relative))? {
            differences.push(Difference {
                kind: Kind::Differs,
                relative,
            });
        }
    }
    differences.extend(mirror_files.into_iter().map(|relative| Difference {
        kind: Kind::Extra,
        relative,
    }));
    Ok(differences)
}

/// Remove `directory` and its parents while they are empty, stopping at `stop_at`.
fn prune_empty(directory: &Path, stop_at: &Path) -> Result<(), ScriptError> {
    let mut current = directory;
    while current != stop_at {
        let mut entries =
            fs::read_dir(current).map_err(|error| io_error("listing", current, &error))?;
        if entries.next().is_some() {
            break;
        }
        fs::remove_dir(current).map_err(|error| io_error("removing", current, &error))?;
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
    }
    Ok(())
}

fn sync_trees(source: &Path, mirror: &Path, differences: &[Difference]) -> TaskResult {
    fs::create_dir_all(mirror).map_err(|error| io_error("creating", mirror, &error))?;
    // Deletions first: a path that changed kind (file <-> directory) is one `extra` and
    // one `missing`, and copying first would hit the stale entry.
    for difference in differences.iter().filter(|d| d.kind == Kind::Extra) {
        let target = mirror.join(&difference.relative);
        fs::remove_file(&target).map_err(|error| io_error("removing", &target, &error))?;
        if let Some(parent) = target.parent() {
            prune_empty(parent, mirror)?;
        }
    }
    for difference in differences.iter().filter(|d| d.kind != Kind::Extra) {
        let target = mirror.join(&difference.relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| io_error("creating", parent, &error))?;
        }
        let from = source.join(&difference.relative);
        fs::copy(&from, &target).map_err(|error| io_error("copying", &from, &error))?;
    }
    Ok(())
}

fn source_not_directory(actual: &str) -> ScriptError {
    ScriptError::new(
        "ERR_AGENTS_SOURCE_MISSING",
        format!("{SOURCE}/ does not exist"),
        format!("skills authored under {SOURCE}/"),
        actual,
        format!("restore {SOURCE}/ from version control, then run `just agents-sync`"),
    )
}

fn mirror_not_directory() -> ScriptError {
    ScriptError::new(
        "ERR_AGENTS_MIRROR_NOT_DIRECTORY",
        format!("{MIRROR} is not a directory"),
        format!("{MIRROR}/ to be a real directory holding a copy of {SOURCE}/"),
        format!("{MIRROR} is a file"),
        format!("remove {MIRROR} (`git rm {MIRROR}`), then run `just agents-sync`"),
    )
}

fn drift_error(differences: &[Difference], place: &str) -> ScriptError {
    ScriptError::new(
        "ERR_AGENTS_DRIFT",
        format!("{MIRROR}/ is not a copy of {SOURCE}/{place}"),
        format!("{MIRROR}/ byte-identical to {SOURCE}/ (ignoring .DS_Store)"),
        differences
            .iter()
            .map(|d| format!("{}: {MIRROR}/{}", d.kind.label(), d.relative))
            .collect::<Vec<_>>()
            .join("; "),
        "run `just agents-sync` and stage both trees (`git add .agents/skills .claude/skills`)",
    )
}

/// One stage-0 index entry under a skills tree: its mode and blob id, by relative path.
type IndexTree = BTreeMap<String, (String, String)>;

/// The index entries under `SOURCE` and `MIRROR`, read with `git ls-files --stage -z`.
fn read_index(context: &Context<'_>) -> Result<(IndexTree, IndexTree), ScriptError> {
    let env = staged_guard_env(&context.env);
    let git = |args: &[&str]| {
        context.run(
            "git",
            args,
            &RunOptions {
                cwd: Some(context.root.clone()),
                env: Some(env.clone()),
                input: None,
            },
        )
    };
    if git(&["rev-parse", "--is-inside-work-tree"])
        .stdout_text()
        .trim()
        != "true"
    {
        return Err(ScriptError::new(
            "ERR_AGENTS_NOT_A_REPO",
            "--staged needs a git work tree",
            "to run from inside the repository whose index is being committed",
            format!(
                "`git rev-parse --is-inside-work-tree` did not print true in {}",
                context.root.display()
            ),
            "run `just agents-check` to compare the working trees instead",
        ));
    }
    let read = |args: &[&str]| -> Result<String, ScriptError> {
        let mut full = args.to_vec();
        full.extend(["-z", "--", SOURCE, MIRROR]);
        let result = git(&full);
        if result.success() {
            return Ok(result.stdout_text());
        }
        let stderr = result.stderr_text().trim().to_owned();
        Err(ScriptError::new(
            "ERR_AGENTS_INDEX_UNREADABLE",
            "could not list the staged skills",
            format!("`git {} -- {SOURCE} {MIRROR}` to exit 0", args.join(" ")),
            if stderr.is_empty() {
                format!(
                    "exit {}",
                    result
                        .status
                        .map_or_else(|| "null".to_owned(), |status| status.to_string())
                )
            } else {
                stderr
            },
            "check `git status` and the index, then retry the commit",
        ))
    };
    let listed = read(&["ls-files", "--stage"])?;
    // Comparing the work tree with the index, only an intent-to-add entry can be "added":
    // a file the index lacks is not listed at all. Its placeholder blob is not committed.
    // diff-files is plumbing: unlike `git diff`, it never rewrites the index it reads.
    let intent_to_add_text = read(&["diff-files", "--name-only", "--diff-filter=A"])?;
    let intent_to_add: HashSet<&str> = intent_to_add_text.split('\0').collect();
    let mut source = IndexTree::new();
    let mut mirror = IndexTree::new();
    for record in listed.split('\0') {
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        let fields: Vec<&str> = meta.split(' ').collect();
        let [mode, blob, stage] = fields.as_slice() else {
            continue;
        };
        // A conflicted path has stages 1-3 and no commit can be made until it is resolved.
        if *stage != "0" || intent_to_add.contains(path) {
            continue;
        }
        for (label, tree) in [(SOURCE, &mut source), (MIRROR, &mut mirror)] {
            if path == label {
                if *mode == SYMLINK_MODE {
                    return Err(symlink_error(label, label));
                }
                if label == SOURCE {
                    return Err(source_not_directory(&format!(
                        "{SOURCE} is staged as a file"
                    )));
                }
                return Err(mirror_not_directory());
            }
            let Some(relative) = path
                .strip_prefix(label)
                .and_then(|rest| rest.strip_prefix('/'))
            else {
                continue;
            };
            if relative.split('/').any(ignored) {
                continue;
            }
            if *mode == SYMLINK_MODE {
                return Err(symlink_error(path, path));
            }
            tree.insert(
                relative.to_owned(),
                ((*mode).to_owned(), (*blob).to_owned()),
            );
        }
    }
    Ok((source, mirror))
}

/// Drift between the staged trees, compared by mode and blob id (equal ids are equal
/// bytes), so an executable bit staged on one side only is drift too.
fn diff_index(source: &IndexTree, mirror: &IndexTree) -> Vec<Difference> {
    let mut differences = Vec::new();
    for (relative, entry) in source {
        match mirror.get(relative) {
            None => differences.push(Difference {
                kind: Kind::Missing,
                relative: relative.clone(),
            }),
            Some(copy) if copy != entry => differences.push(Difference {
                kind: Kind::Differs,
                relative: relative.clone(),
            }),
            Some(_) => {}
        }
    }
    differences.extend(
        mirror
            .keys()
            .filter(|relative| !source.contains_key(*relative))
            .map(|relative| Difference {
                kind: Kind::Extra,
                relative: relative.clone(),
            }),
    );
    differences
}

fn check_staged(context: &Context<'_>) -> TaskResult {
    let (source, mirror) = read_index(context)?;
    if source.is_empty() {
        return Err(ScriptError::new(
            "ERR_AGENTS_SOURCE_NOT_STAGED",
            format!("the index holds no skill under {SOURCE}/"),
            format!("the skills tracked under {SOURCE}/ to stay in the commit"),
            format!("nothing staged under {SOURCE}/ (the commit would drop the authored skills)"),
            format!(
                "stage the skills (`git add {SOURCE} {MIRROR}`), or `git restore --staged {SOURCE}` if the removal was unintended"
            ),
        ));
    }
    let differences = diff_index(&source, &mirror);
    if !differences.is_empty() {
        return Err(drift_error(&differences, " in the index"));
    }
    context.log(&format!("agents:check: the staged {MIRROR}/ is in sync."));
    Ok(())
}

pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    let argv = &context.argv;
    let unknown: Vec<&str> = argv
        .iter()
        .map(String::as_str)
        .filter(|argument| *argument != "--check" && *argument != "--staged")
        .collect();
    let check = argv.iter().any(|argument| argument == "--check");
    let staged = argv.iter().any(|argument| argument == "--staged");
    if !unknown.is_empty() || (staged && !check) {
        return Err(ScriptError::new(
            "ERR_AGENTS_USAGE",
            if unknown.is_empty() {
                "--staged only works with --check".to_owned()
            } else {
                format!("unknown argument(s): {}", unknown.join(" "))
            },
            "no arguments, --check, or --check --staged",
            format!("arguments: {}", argv.join(" ")),
            "run `just agents-sync` or `just agents-check`",
        ));
    }
    if staged {
        return check_staged(context);
    }
    let source = context.root.join(SOURCE);
    let mirror = context.root.join(MIRROR);

    match stat(&source)? {
        Some(metadata) if metadata.file_type().is_symlink() => {
            return Err(symlink_error(SOURCE, SOURCE));
        }
        Some(metadata) if metadata.is_dir() => {}
        Some(_) => {
            return Err(source_not_directory(&format!(
                "{SOURCE} is not a directory"
            )));
        }
        None => return Err(source_not_directory(&format!("no such path: {SOURCE}"))),
    }
    match stat(&mirror)? {
        Some(metadata) if metadata.file_type().is_symlink() => {
            return Err(symlink_error(MIRROR, MIRROR));
        }
        Some(metadata) if !metadata.is_dir() => return Err(mirror_not_directory()),
        _ => {}
    }

    let differences = diff_trees(&source, &mirror)?;
    if check {
        if !differences.is_empty() {
            return Err(drift_error(&differences, ""));
        }
        context.log(&format!("agents:check: {MIRROR}/ is in sync."));
        return Ok(());
    }
    if differences.is_empty() {
        context.log(&format!("agents:sync: {MIRROR}/ was already in sync."));
        return Ok(());
    }
    sync_trees(&source, &mirror, &differences)?;
    context.log(&format!(
        "agents:sync: updated {} path(s) in {MIRROR}/.",
        differences.len()
    ));
    for difference in &differences {
        context.log(&format!(
            "- {}: {}",
            difference.kind.label(),
            difference.relative
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::Path;

    use tempfile::TempDir;

    use super::{MIRROR, SOURCE, main};
    use crate::context::{Env, RunOptions, RunResult};
    use crate::test_support::{Fake, Outcome, git, git_with, hook_env, temp_dir, write};

    fn repo(files: &[(&str, &str)]) -> TempDir {
        let dir = temp_dir();
        fs::create_dir_all(dir.path().join(SOURCE)).expect("mkdir");
        for (path, content) in files {
            write(dir.path(), path, content);
        }
        dir
    }

    fn sync(root: &Path, argv: &[&str]) -> Outcome {
        Fake::at(root).argv(argv).task(main)
    }

    fn staged(root: &Path, env: Env) -> Outcome {
        Fake::at(root)
            .argv(&["--check", "--staged"])
            .env(env)
            .task(main)
    }

    fn read(root: &Path, path: &str) -> String {
        fs::read_to_string(root.join(path)).expect("read")
    }

    fn src(path: &str) -> String {
        format!("{SOURCE}/{path}")
    }

    fn mir(path: &str) -> String {
        format!("{MIRROR}/{path}")
    }

    fn actual(outcome: Outcome) -> String {
        outcome.failure().details.actual
    }

    fn message(outcome: Outcome) -> String {
        let error = outcome.failure();
        format!("{}: {}", error.details.code, error.details.summary)
    }

    #[test]
    fn creates_the_mirror_as_real_files_byte_for_byte() {
        let binary = [0_u8, 1, 2, 255, 10];
        let dir = repo(&[
            (&src("a/SKILL.md"), "# a\n"),
            (&src("a/references/x.md"), "x"),
        ]);
        let root = dir.path();
        write(root, &src("b/bin.dat"), binary);
        let outcome = sync(root, &[]);
        outcome.assert_ok();
        assert_eq!(read(root, &mir("a/SKILL.md")), "# a\n");
        assert_eq!(read(root, &mir("a/references/x.md")), "x");
        assert_eq!(fs::read(root.join(mir("b/bin.dat"))).expect("read"), binary);
        assert!(
            !fs::symlink_metadata(root.join(MIRROR))
                .expect("lstat")
                .file_type()
                .is_symlink()
        );
        assert!(outcome.lines.join("\n").contains("updated 3 path(s)"));
        assert!(outcome.lines.contains(&"- missing: a/SKILL.md".to_owned()));
    }

    #[test]
    fn updates_changed_files_removes_stale_ones_and_prunes_emptied_directories() {
        let dir = repo(&[
            (&src("a/SKILL.md"), "new"),
            (&mir("a/SKILL.md"), "old"),
            (&mir("gone/deep/file.md"), "stale"),
            (&mir("a/extra.md"), "stale"),
        ]);
        let root = dir.path();
        let outcome = sync(root, &[]);
        outcome.assert_ok();
        assert_eq!(read(root, &mir("a/SKILL.md")), "new");
        assert!(!root.join(mir("a/extra.md")).exists());
        assert!(!root.join(mir("gone")).exists());
        assert!(root.join(MIRROR).exists());
        assert!(outcome.lines.contains(&"- differs: a/SKILL.md".to_owned()));
        assert!(
            outcome
                .lines
                .contains(&"- extra: gone/deep/file.md".to_owned())
        );
        sync(root, &["--check"]).assert_ok();
    }

    #[test]
    fn replaces_a_path_that_changed_kind_between_file_and_directory() {
        let dir = repo(&[
            (&src("a/SKILL.md"), "dir now"),
            (&src("b"), "file now"),
            (&mir("a"), "was a file"),
            (&mir("b/inner.md"), "was a dir"),
        ]);
        let root = dir.path();
        sync(root, &[]).assert_ok();
        assert_eq!(read(root, &mir("a/SKILL.md")), "dir now");
        assert_eq!(read(root, &mir("b")), "file now");
    }

    #[test]
    fn copies_a_changed_executable_bit_even_when_the_bytes_match() {
        let dir = repo(&[(&src("run.sh"), "echo\n"), (&mir("run.sh"), "echo\n")]);
        let root = dir.path();
        fs::set_permissions(root.join(src("run.sh")), fs::Permissions::from_mode(0o755))
            .expect("chmod");
        assert_eq!(
            actual(sync(root, &["--check"])),
            format!("differs: {}", mir("run.sh"))
        );
        sync(root, &[]).assert_ok();
        let mode = fs::metadata(root.join(mir("run.sh")))
            .expect("stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
        sync(root, &["--check"]).assert_ok();
    }

    #[test]
    fn reports_an_already_synced_mirror_and_leaves_it_alone() {
        let dir = repo(&[(&src("a.md"), "a"), (&mir("a.md"), "a")]);
        let outcome = sync(dir.path(), &[]);
        outcome.assert_ok();
        assert_eq!(
            outcome.lines,
            vec![format!("agents:sync: {MIRROR}/ was already in sync.")]
        );
    }

    #[test]
    fn ignores_ds_store_and_python_bytecode_on_both_sides() {
        let dir = repo(&[
            (&src(".DS_Store"), "finder"),
            (
                &src("a/scripts/tests/__pycache__/t.cpython-311.pyc"),
                "bytecode",
            ),
            (&src("a/scripts/stray.pyc"), "bytecode"),
            (&src("a/SKILL.md"), "a"),
            (&mir("a/SKILL.md"), "a"),
            (&mir("sub/.DS_Store"), "finder"),
            (&mir("b/__pycache__/t.cpython-311.pyc"), "bytecode"),
        ]);
        let root = dir.path();
        assert_eq!(
            sync(root, &[]).lines,
            vec![format!("agents:sync: {MIRROR}/ was already in sync.")]
        );
        assert!(!root.join(mir(".DS_Store")).exists());
        assert!(!root.join(mir("a/scripts/tests/__pycache__")).exists());
        assert!(!root.join(mir("a/scripts/stray.pyc")).exists());
        sync(root, &["--check"]).assert_ok();
    }

    #[test]
    fn check_passes_when_the_mirror_equals_the_source() {
        let dir = repo(&[(&src("a/SKILL.md"), "a"), (&mir("a/SKILL.md"), "a")]);
        let outcome = sync(dir.path(), &["--check"]);
        outcome.assert_ok();
        assert_eq!(
            outcome.lines,
            vec![format!("agents:check: {MIRROR}/ is in sync.")]
        );
    }

    #[test]
    fn check_lists_every_differing_path_without_writing() {
        let dir = repo(&[
            (&src("missing.md"), "m"),
            (&src("same.md"), "s"),
            (&src("changed.md"), "new"),
            (&mir("same.md"), "s"),
            (&mir("changed.md"), "old"),
            (&mir("extra.md"), "e"),
        ]);
        let root = dir.path();
        let error = sync(root, &["--check"]).failure();
        assert_eq!(error.code(), "ERR_AGENTS_DRIFT");
        assert_eq!(
            error.details.actual,
            [
                format!("differs: {}", mir("changed.md")),
                format!("missing: {}", mir("missing.md")),
                format!("extra: {}", mir("extra.md")),
            ]
            .join("; ")
        );
        assert!(!root.join(mir("missing.md")).exists());
        assert!(root.join(mir("extra.md")).exists());
        assert_eq!(read(root, &mir("changed.md")), "old");
    }

    #[test]
    fn check_fails_when_the_mirror_does_not_exist_and_does_not_create_it() {
        let dir = repo(&[(&src("a.md"), "a")]);
        let error = sync(dir.path(), &["--check"]).failure();
        assert_eq!(error.code(), "ERR_AGENTS_DRIFT");
        assert!(
            error
                .details
                .actual
                .contains(&format!("missing: {}", mir("a.md")))
        );
        assert!(!dir.path().join(MIRROR).exists());
    }

    #[test]
    fn check_passes_for_an_empty_source_and_an_absent_mirror() {
        let dir = repo(&[]);
        sync(dir.path(), &["--check"]).assert_ok();
    }

    #[test]
    fn refuses_unknown_arguments() {
        let dir = repo(&[(&src("a.md"), "a")]);
        assert_eq!(
            message(sync(dir.path(), &["--check", "--force"])),
            "ERR_AGENTS_USAGE: unknown argument(s): --force"
        );
        assert!(!dir.path().join(MIRROR).exists());
    }

    #[test]
    fn refuses_staged_without_check() {
        let dir = repo(&[]);
        assert_eq!(
            message(sync(dir.path(), &["--staged"])),
            "ERR_AGENTS_USAGE: --staged only works with --check"
        );
    }

    #[test]
    fn refuses_a_missing_source_or_one_that_is_a_file() {
        let dir = temp_dir();
        assert_eq!(sync(dir.path(), &[]).code(), "ERR_AGENTS_SOURCE_MISSING");
        write(dir.path(), SOURCE, "not a dir");
        assert_eq!(sync(dir.path(), &[]).code(), "ERR_AGENTS_SOURCE_MISSING");
    }

    #[test]
    fn refuses_a_symlinked_source_directory() {
        let dir = temp_dir();
        let root = dir.path();
        fs::create_dir_all(root.join("real")).expect("mkdir");
        fs::create_dir_all(root.join(".agents")).expect("mkdir");
        symlink(root.join("real"), root.join(SOURCE)).expect("symlink");
        assert_eq!(
            message(sync(root, &[])),
            "ERR_AGENTS_SYMLINK: .agents/skills is a symlink"
        );
    }

    #[test]
    fn refuses_a_symlinked_mirror_directory_and_leaves_its_target_untouched() {
        let dir = repo(&[(&src("a.md"), "a")]);
        let root = dir.path();
        fs::create_dir_all(root.join("elsewhere")).expect("mkdir");
        fs::create_dir_all(root.join(".claude")).expect("mkdir");
        symlink(root.join("elsewhere"), root.join(MIRROR)).expect("symlink");
        for argv in [&[][..], &["--check"][..]] {
            assert_eq!(
                message(sync(root, argv)),
                "ERR_AGENTS_SYMLINK: .claude/skills is a symlink"
            );
        }
        assert!(!root.join("elsewhere/a.md").exists());
    }

    #[test]
    fn refuses_a_mirror_path_that_is_a_file() {
        let dir = repo(&[(&src("a.md"), "a"), (MIRROR, "file")]);
        assert_eq!(
            sync(dir.path(), &[]).code(),
            "ERR_AGENTS_MIRROR_NOT_DIRECTORY"
        );
    }

    #[test]
    fn refuses_a_symlinked_entry_in_the_source() {
        let dir = repo(&[(&src("a/SKILL.md"), "a")]);
        let root = dir.path();
        symlink(root.join(src("a/SKILL.md")), root.join(src("a/link.md"))).expect("symlink");
        assert_eq!(
            message(sync(root, &[])),
            "ERR_AGENTS_SYMLINK: .agents/skills/a/link.md is a symlink"
        );
        assert!(!root.join(MIRROR).exists());
    }

    #[test]
    fn refuses_a_symlinked_entry_in_the_mirror() {
        let dir = repo(&[(&src("a.md"), "a")]);
        let root = dir.path();
        fs::create_dir_all(root.join(MIRROR)).expect("mkdir");
        symlink(root.join(src("a.md")), root.join(mir("a.md"))).expect("symlink");
        assert_eq!(
            message(sync(root, &["--check"])),
            "ERR_AGENTS_SYMLINK: .claude/skills/a.md is a symlink"
        );
    }

    #[test]
    fn reports_an_unexpected_filesystem_error_as_such() {
        let dir = repo(&[(&src("a.md"), "a")]);
        // A NUL byte makes every file-system call fail with InvalidInput, not NotFound.
        let bad = dir.path().join("x\0y");
        assert_eq!(sync(&bad, &[]).code(), "ERR_INTERNAL_UNEXPECTED");
    }

    /// A throwaway git repository holding `files`; nothing is staged yet.
    fn git_repo(files: &[(&str, &str)]) -> TempDir {
        let dir = repo(files);
        git(dir.path(), &["init", "--quiet"]);
        dir
    }

    #[test]
    fn staged_fails_when_only_the_source_is_staged_although_the_working_trees_match() {
        let dir = git_repo(&[(&src("a/SKILL.md"), "old"), (&mir("a/SKILL.md"), "old")]);
        let root = dir.path();
        git(root, &["add", SOURCE, MIRROR]);
        write(root, &src("a/SKILL.md"), "new");
        sync(root, &[]).assert_ok();
        git(root, &["add", SOURCE]);

        sync(root, &["--check"]).assert_ok();
        let error = staged(root, hook_env()).failure();
        assert_eq!(error.code(), "ERR_AGENTS_DRIFT");
        assert!(error.details.summary.ends_with(" in the index"));
        assert_eq!(
            error.details.actual,
            format!("differs: {}", mir("a/SKILL.md"))
        );
    }

    #[test]
    fn staged_passes_once_both_trees_are_staged_and_reads_only_the_index() {
        let dir = git_repo(&[(&src("a/SKILL.md"), "a"), (&mir("a/SKILL.md"), "a")]);
        let root = dir.path();
        git(root, &["add", SOURCE, MIRROR]);
        // An unstaged working-tree edit is not part of the commit.
        write(root, &mir("a/SKILL.md"), "edited, unstaged");
        let outcome = staged(root, hook_env());
        outcome.assert_ok();
        assert_eq!(
            outcome.lines,
            vec![format!("agents:check: the staged {MIRROR}/ is in sync.")]
        );
    }

    #[test]
    fn staged_lists_missing_differing_and_extra_paths_and_ignores_debris() {
        let dir = git_repo(&[
            (&src("missing.md"), "m"),
            (&src("same.md"), "s"),
            (&src("changed.md"), "new"),
            (&src("sub/.DS_Store"), "finder"),
            (&mir("same.md"), "s"),
            (&mir("changed.md"), "old"),
            (&mir("extra.md"), "e"),
            (&mir(".DS_Store"), "finder"),
            (&src("sub/__pycache__/t.cpython-311.pyc"), "bytecode"),
            (&mir("stray.pyc"), "bytecode"),
        ]);
        let root = dir.path();
        git(root, &["add", "--force", SOURCE, MIRROR]);
        let error = staged(root, hook_env()).failure();
        assert_eq!(error.code(), "ERR_AGENTS_DRIFT");
        assert_eq!(
            error.details.actual,
            [
                format!("differs: {}", mir("changed.md")),
                format!("missing: {}", mir("missing.md")),
                format!("extra: {}", mir("extra.md")),
            ]
            .join("; ")
        );
    }

    #[test]
    fn staged_judges_the_index_git_index_file_names_and_ignores_an_inherited_git_dir() {
        let dir = git_repo(&[(&src("a.md"), "old"), (&mir("a.md"), "old")]);
        let root = dir.path();
        git(root, &["add", SOURCE, MIRROR]);
        let alternate = root.join(".git/alternate-index");
        fs::copy(root.join(".git/index"), &alternate).expect("copy the index");
        write(root, &src("a.md"), "new");
        let mut with_index = hook_env();
        with_index.insert("GIT_INDEX_FILE".to_owned(), alternate.display().to_string());
        git_with(root, &["add", SOURCE], &with_index);
        let mut env = hook_env();
        env.insert(
            "GIT_DIR".to_owned(),
            root.join("nowhere").display().to_string(),
        );
        staged(root, env.clone()).assert_ok();
        env.insert("GIT_INDEX_FILE".to_owned(), alternate.display().to_string());
        assert_eq!(staged(root, env).code(), "ERR_AGENTS_DRIFT");
    }

    #[test]
    fn staged_fails_when_an_executable_bit_is_staged_on_one_side_only() {
        let dir = git_repo(&[(&src("run.sh"), "echo\n"), (&mir("run.sh"), "echo\n")]);
        let root = dir.path();
        git(root, &["add", SOURCE, MIRROR]);
        staged(root, hook_env()).assert_ok();
        git(root, &["update-index", "--chmod=+x", &src("run.sh")]);
        assert_eq!(
            actual(staged(root, hook_env())),
            format!("differs: {}", mir("run.sh"))
        );
    }

    #[test]
    fn staged_skips_an_intent_to_add_entry_which_the_commit_will_not_contain() {
        let dir = git_repo(&[
            (&src("a.md"), "a"),
            (&mir("a.md"), "a"),
            (&src("draft.md"), "not yet"),
        ]);
        let root = dir.path();
        git(root, &["add", &src("a.md"), MIRROR]);
        git(root, &["add", "--intent-to-add", &src("draft.md")]);
        assert_eq!(
            git(root, &["ls-files", "--", &src("draft.md")]),
            format!("{}\n", src("draft.md"))
        );
        staged(root, hook_env()).assert_ok();
        // Once really staged, the missing copy is drift again.
        git(root, &["add", &src("draft.md")]);
        assert_eq!(
            actual(staged(root, hook_env())),
            format!("missing: {}", mir("draft.md"))
        );
    }

    #[test]
    fn staged_refuses_a_staged_symlink_in_either_tree() {
        let dir = git_repo(&[(&src("a.md"), "a"), (&mir("a.md"), "a")]);
        let root = dir.path();
        symlink("a.md", root.join(src("link.md"))).expect("symlink");
        git(root, &["add", SOURCE, MIRROR]);
        assert_eq!(
            message(staged(root, hook_env())),
            "ERR_AGENTS_SYMLINK: .agents/skills/link.md is a symlink"
        );
    }

    #[test]
    fn staged_refuses_a_mirror_staged_as_a_symlink_or_a_file() {
        let linked = git_repo(&[(&src("a.md"), "a")]);
        fs::create_dir_all(linked.path().join(".claude")).expect("mkdir");
        symlink("../.agents/skills", linked.path().join(MIRROR)).expect("symlink");
        git(linked.path(), &["add", SOURCE, MIRROR]);
        assert_eq!(
            message(staged(linked.path(), hook_env())),
            "ERR_AGENTS_SYMLINK: .claude/skills is a symlink"
        );

        let file = git_repo(&[(&src("a.md"), "a"), (MIRROR, "file")]);
        git(file.path(), &["add", SOURCE, MIRROR]);
        assert_eq!(
            staged(file.path(), hook_env()).code(),
            "ERR_AGENTS_MIRROR_NOT_DIRECTORY"
        );
    }

    #[test]
    fn staged_refuses_a_source_staged_as_a_file_or_nothing_staged_under_it() {
        let file = git_repo(&[]);
        fs::remove_dir_all(file.path().join(SOURCE)).expect("remove");
        write(file.path(), SOURCE, "file");
        git(file.path(), &["add", SOURCE]);
        assert_eq!(
            staged(file.path(), hook_env()).code(),
            "ERR_AGENTS_SOURCE_MISSING"
        );

        let empty = git_repo(&[(&mir("a.md"), "a")]);
        git(empty.path(), &["add", MIRROR]);
        let error = staged(empty.path(), hook_env()).failure();
        assert_eq!(error.code(), "ERR_AGENTS_SOURCE_NOT_STAGED");
        assert!(
            error
                .details
                .actual
                .contains(&format!("nothing staged under {SOURCE}/"))
        );
    }

    #[test]
    fn staged_refuses_to_run_outside_a_git_work_tree() {
        let dir = repo(&[(&src("a.md"), "a")]);
        let not_a_repo = |_: &str, _: &[&str], _: &RunOptions| {
            RunResult::exited(128, "", "not a git repository")
        };
        assert_eq!(
            Fake::at(dir.path())
                .argv(&["--check", "--staged"])
                .run(&not_a_repo)
                .task(main)
                .code(),
            "ERR_AGENTS_NOT_A_REPO"
        );
    }

    #[test]
    fn staged_fails_when_the_index_cannot_be_listed() {
        let dir = repo(&[]);
        for (stderr, expected) in [
            ("fatal: index file corrupt", "fatal: index file corrupt"),
            ("", "exit 128"),
        ] {
            let failing = |_: &str, args: &[&str], _: &RunOptions| {
                if args.first() == Some(&"rev-parse") {
                    RunResult::exited(0, "true\n", "")
                } else {
                    RunResult::exited(128, "", stderr)
                }
            };
            let error = Fake::at(dir.path())
                .argv(&["--check", "--staged"])
                .run(&failing)
                .task(main)
                .failure();
            assert_eq!(error.code(), "ERR_AGENTS_INDEX_UNREADABLE");
            assert_eq!(error.details.actual, expected);
        }
    }

    #[test]
    fn staged_skips_the_unmerged_stages_of_a_conflicted_path() {
        let blob = "0123456789abcdef0123456789abcdef01234567";
        let listing = [
            format!("100644 {blob} 0\t{}", src("a.md")),
            format!("100644 {blob} 0\t{}", mir("a.md")),
            format!("100644 {blob} 1\t{}", src("b.md")),
            format!("100644 {blob} 2\t{}", src("b.md")),
            "malformed".to_owned(),
            format!("100644 {blob}\t{}", src("c.md")),
            String::new(),
        ]
        .join("\0");
        let fake = |_: &str, args: &[&str], _: &RunOptions| match args.first().copied() {
            Some("rev-parse") => RunResult::exited(0, "true\n", ""),
            Some("ls-files") => RunResult::exited(0, &listing, ""),
            _ => RunResult::exited(0, "", ""),
        };
        let dir = repo(&[]);
        Fake::at(dir.path())
            .argv(&["--check", "--staged"])
            .run(&fake)
            .task(main)
            .assert_ok();
    }
}
