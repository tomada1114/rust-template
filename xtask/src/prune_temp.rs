//! `cargo xtask prune-temp`: removes temporary directories that are known to be safe to
//! delete, so an agent never needs a raw `rm -rf`:
//!
//! - every `verify-bootstrap-*` directory directly under the OS temp directory (what
//!   `cargo xtask verify-bootstrap` leaves behind when a run is interrupted);
//! - each Claude Code session's `scratchpad` for this checkout,
//!   `<claude-base>/<slug>/<session>/scratchpad`, where `<slug>` is the checkout's
//!   absolute path with every non-alphanumeric character replaced by `-` — only when
//!   nothing under that session directory changed in the last 24 hours, so a live session
//!   is untouched.
//!
//! ```text
//! cargo xtask prune-temp [--dry-run] [--temp-dir DIR] [--claude-base DIR] [--now MS]
//! ```
//!
//! `--temp-dir` defaults to `TMPDIR` (else the OS temp directory), `--claude-base` to
//! `/private/tmp/claude-<uid>` (the uid from `id -u`), and `--now` (epoch milliseconds)
//! to the current time. Symlinks are never followed: a matching entry that does not
//! resolve inside its expected parent is refused. Prints each path removed (or that would
//! be, with `--dry-run`), or `nothing to prune`.
//!
//! Git work tree: not required.
//!
//! Errors: `ERR_PRUNE_USAGE`, `ERR_PRUNE_ESCAPES_PARENT`, `ERR_PRUNE_REMOVE_FAILED`.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::context::{Context, RunOptions};
use crate::fail::{ScriptError, TaskResult};

/// The prefix `cargo xtask verify-bootstrap` gives its temporary directories.
const BOOTSTRAP_PREFIX: &str = "verify-bootstrap-";
/// How long a session directory must sit untouched before its scratchpad is pruned.
const SESSION_IDLE_MS: u32 = 24 * 60 * 60 * 1000;

const USAGE: &str =
    "cargo xtask prune-temp [--dry-run] [--temp-dir DIR] [--claude-base DIR] [--now MS]";

#[derive(Debug, Default)]
struct Options {
    dry_run: bool,
    temp_dir: Option<String>,
    claude_base: Option<String>,
    now: Option<f64>,
}

fn usage(actual: String) -> ScriptError {
    ScriptError::new(
        "ERR_PRUNE_USAGE",
        "unrecognised arguments",
        USAGE,
        actual,
        "rerun with the arguments above, e.g. `just prune-temp --dry-run`",
    )
}

fn parse_args(argv: &[String]) -> Result<Options, ScriptError> {
    let mut options = Options::default();
    let mut remaining = argv.iter();
    while let Some(arg) = remaining.next() {
        if arg == "--dry-run" {
            options.dry_run = true;
            continue;
        }
        let value = remaining.next();
        let (Some(value), "--temp-dir" | "--claude-base" | "--now") = (value, arg.as_str()) else {
            return Err(usage(argv.join(" ")));
        };
        match arg.as_str() {
            "--temp-dir" => options.temp_dir = Some(value.clone()),
            "--claude-base" => options.claude_base = Some(value.clone()),
            _ => {
                let now = value
                    .parse::<f64>()
                    .ok()
                    .filter(|now| now.is_finite())
                    .ok_or_else(|| usage(format!("--now {value} is not epoch milliseconds")))?;
                options.now = Some(now);
            }
        }
    }
    Ok(options)
}

/// Claude Code's directory name for a checkout: every non-alphanumeric character becomes
/// `-`.
fn claude_slug(checkout: &str) -> String {
    checkout
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// `path` made absolute against the current directory and normalized without touching
/// the file system (`.` and `..` resolved, a trailing `/` dropped).
fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut resolved = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => {}
            other => resolved.push(other),
        }
    }
    resolved
}

/// A real directory or a symlink (which [`confined`] then refuses); false for anything
/// else.
fn candidate(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir() || metadata.is_symlink())
}

fn unexpected(what: &str, path: &Path, error: &io::Error) -> ScriptError {
    ScriptError::unexpected(&format!("{what} {}", path.display()), error)
}

/// Refuse a path that does not resolve to exactly `<parent>/<name>` (a symlink out, say).
fn confined(parent: &Path, name: &str) -> Result<PathBuf, ScriptError> {
    let path = parent.join(name);
    let real = path
        .canonicalize()
        .map_err(|error| unexpected("resolving", &path, &error))?;
    let expected = parent
        .canonicalize()
        .map_err(|error| unexpected("resolving", parent, &error))?
        .join(name);
    let is_link = fs::symlink_metadata(&path)
        .map_err(|error| unexpected("reading", &path, &error))?
        .is_symlink();
    if real != expected || is_link {
        return Err(ScriptError::new(
            "ERR_PRUNE_ESCAPES_PARENT",
            format!(
                "{} does not resolve inside {}",
                path.display(),
                parent.display()
            ),
            format!("a real directory at {}", expected.display()),
            format!("it resolves to {}", real.display()),
            format!(
                "inspect {} by hand; prune-temp never follows a symlink out of its parent",
                path.display()
            ),
        ));
    }
    Ok(path)
}

fn millis(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_secs_f64() * 1000.0,
        Err(before) => -before.duration().as_secs_f64() * 1000.0,
    }
}

/// The newest modification time anywhere under `path`, in epoch milliseconds, never
/// following a symlink.
fn newest_mtime(path: &Path) -> Result<f64, ScriptError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| unexpected("reading", path, &error))?;
    let modified = metadata
        .modified()
        .map_err(|error| unexpected("reading", path, &error))?;
    let mut newest = millis(modified);
    if metadata.is_dir() {
        for entry in sorted_names(path)? {
            newest = newest.max(newest_mtime(&path.join(entry))?);
        }
    }
    Ok(newest)
}

/// The names in a directory, sorted.
fn sorted_names(dir: &Path) -> Result<Vec<String>, ScriptError> {
    let mut names = fs::read_dir(dir)
        .map_err(|error| unexpected("listing", dir, &error))?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .map_err(|error| unexpected("listing", dir, &error))
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    Ok(names)
}

fn bootstrap_dirs(temp_dir: &Path) -> Result<Vec<PathBuf>, ScriptError> {
    if !candidate(temp_dir) {
        return Ok(Vec::new());
    }
    sorted_names(temp_dir)?
        .into_iter()
        .filter(|name| name.starts_with(BOOTSTRAP_PREFIX) && candidate(&temp_dir.join(name)))
        .map(|name| confined(temp_dir, &name))
        .collect()
}

fn stale_scratchpads(
    claude_base: &Path,
    checkout: &Path,
    now: f64,
) -> Result<Vec<PathBuf>, ScriptError> {
    let slug = claude_slug(&checkout.display().to_string());
    if !candidate(&claude_base.join(&slug)) {
        return Ok(Vec::new());
    }
    let project = confined(claude_base, &slug)?;
    let mut found = Vec::new();
    for session in sorted_names(&project)? {
        if !candidate(&project.join(&session)) {
            continue;
        }
        let session_dir = confined(&project, &session)?;
        if !candidate(&session_dir.join("scratchpad")) {
            continue;
        }
        let scratchpad = confined(&session_dir, "scratchpad")?;
        if now - newest_mtime(&session_dir)? < f64::from(SESSION_IDLE_MS) {
            continue;
        }
        found.push(scratchpad);
    }
    Ok(found)
}

/// `/private/tmp/claude-<uid>`, with the uid `id -u` prints; `None` when it prints none.
fn default_claude_base(context: &Context<'_>) -> Option<PathBuf> {
    let result = context.run("id", &["-u"], &RunOptions::default());
    let uid = result.stdout_text().trim().to_owned();
    (result.success() && !uid.is_empty() && uid.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| PathBuf::from(format!("/private/tmp/claude-{uid}")))
}

pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    let options = parse_args(&context.argv)?;
    let temp_dir = absolute(&options.temp_dir.clone().map_or_else(
        || {
            context
                .env
                .get("TMPDIR")
                .map_or_else(std::env::temp_dir, PathBuf::from)
        },
        PathBuf::from,
    ));
    let claude_base = match &options.claude_base {
        Some(base) => Some(PathBuf::from(base)),
        None => default_claude_base(context),
    };
    let now = options.now.unwrap_or_else(|| millis(SystemTime::now()));

    let mut targets = bootstrap_dirs(&temp_dir)?;
    if let Some(base) = claude_base {
        targets.extend(stale_scratchpads(
            &absolute(&base),
            &absolute(&context.root),
            now,
        )?);
    }
    if targets.is_empty() {
        context.log("prune-temp: nothing to prune");
        return Ok(());
    }
    for target in targets {
        if !options.dry_run {
            fs::remove_dir_all(&target).map_err(|error| {
                ScriptError::new(
                    "ERR_PRUNE_REMOVE_FAILED",
                    format!("could not remove {}", target.display()),
                    format!("{} removed", target.display()),
                    error.to_string(),
                    "check the directory's permissions, then rerun `just prune-temp`",
                )
            })?;
        }
        context.log(&format!(
            "{} {}",
            if options.dry_run {
                "would remove"
            } else {
                "removed"
            },
            target.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use tempfile::TempDir;

    use super::{SESSION_IDLE_MS, absolute, claude_slug, main};
    use crate::context::{RunOptions, RunResult};
    use crate::test_support::{Fake, Outcome, env_of, temp_dir, write};

    const NOW_MS: u64 = 1_790_726_400_000; // 2026-09-30T00:00:00Z
    const CHECKOUT: &str = "/Users/someone/ghq/github.com/me/my_app.v2";

    fn at(ms: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(ms)
    }

    fn old() -> SystemTime {
        at(NOW_MS - u64::from(SESSION_IDLE_MS) - 60_000)
    }

    fn fresh() -> SystemTime {
        at(NOW_MS - 60_000)
    }

    fn touch(path: &Path, time: SystemTime) {
        File::open(path)
            .and_then(|file| file.set_modified(time))
            .expect("set the modification time");
    }

    struct Tree {
        _dir: TempDir,
        temp: PathBuf,
        base: PathBuf,
        project: PathBuf,
    }

    /// A temp dir and a Claude base holding this checkout's project directory.
    fn fixture() -> Tree {
        let dir = temp_dir();
        let temp = dir.path().join("tmp");
        let base = dir.path().join("claude-501");
        let project = base.join(claude_slug(CHECKOUT));
        fs::create_dir_all(&temp).expect("mkdir");
        fs::create_dir_all(&project).expect("mkdir");
        Tree {
            _dir: dir,
            temp,
            base,
            project,
        }
    }

    /// A session with a nested scratchpad, every mtime old; a live session also holds a
    /// transcript modified at `mtime`.
    fn session(project: &Path, id: &str, live: Option<SystemTime>) -> PathBuf {
        let dir = project.join(id);
        let file = dir.join("scratchpad/nested/file.txt");
        write(&dir, "scratchpad/nested/file.txt", "x");
        for path in [
            file.clone(),
            dir.join("scratchpad/nested"),
            dir.join("scratchpad"),
            dir.clone(),
        ] {
            touch(&path, old());
        }
        if let Some(mtime) = live {
            write(&dir, "transcript.log", "live");
            touch(&dir.join("transcript.log"), mtime);
        }
        dir.join("scratchpad")
    }

    fn prune(argv: &[&str], env: &[(&str, &str)]) -> Outcome {
        let no_id = |_: &str, _: &[&str], _: &RunOptions| RunResult::exited(1, "", "");
        Fake::at(Path::new(CHECKOUT))
            .argv(argv)
            .env(env_of(env))
            .run(&no_id)
            .task(main)
    }

    fn args(tree: &Tree, extra: &[&str]) -> Vec<String> {
        let mut args = vec![
            "--temp-dir".to_owned(),
            tree.temp.display().to_string(),
            "--claude-base".to_owned(),
            tree.base.display().to_string(),
            "--now".to_owned(),
            NOW_MS.to_string(),
        ];
        args.extend(extra.iter().map(ToString::to_string));
        args
    }

    fn prune_tree(tree: &Tree, extra: &[&str]) -> Outcome {
        let owned = args(tree, extra);
        let argv: Vec<&str> = owned.iter().map(String::as_str).collect();
        prune(&argv, &[])
    }

    #[test]
    fn replaces_every_non_alphanumeric_character_with_a_dash() {
        assert_eq!(
            claude_slug("/Users/masuyama/.claude"),
            "-Users-masuyama--claude"
        );
        assert_eq!(
            claude_slug(CHECKOUT),
            "-Users-someone-ghq-github-com-me-my-app-v2"
        );
    }

    #[test]
    fn normalizes_a_path_without_touching_the_file_system() {
        assert_eq!(absolute(Path::new("/a/./b/../c/")), PathBuf::from("/a/c"));
        assert!(absolute(Path::new("rel")).is_absolute());
    }

    #[test]
    fn removes_verify_bootstrap_dirs_and_idle_scratchpads_keeping_everything_else() {
        let tree = fixture();
        fs::create_dir(tree.temp.join("verify-bootstrap-abc")).expect("mkdir");
        fs::create_dir(tree.temp.join("verify-bootstrap-product-def")).expect("mkdir");
        fs::create_dir(tree.temp.join("other-dir")).expect("mkdir");
        write(&tree.temp, "verify-bootstrap-file", "not a dir");
        let idle = session(&tree.project, "s1", None);
        let live = session(&tree.project, "s2", Some(fresh()));
        fs::create_dir(tree.project.join("s3")).expect("mkdir");
        write(&tree.project, "stray.json", "{}");
        let other_project = tree.base.join("-Users-someone-else");
        fs::create_dir_all(other_project.join("s9/scratchpad")).expect("mkdir");

        let outcome = prune_tree(&tree, &[]);
        outcome.assert_ok();
        assert_eq!(
            outcome.lines,
            vec![
                format!(
                    "removed {}",
                    tree.temp.join("verify-bootstrap-abc").display()
                ),
                format!(
                    "removed {}",
                    tree.temp.join("verify-bootstrap-product-def").display()
                ),
                format!("removed {}", idle.display()),
            ]
        );
        assert!(!tree.temp.join("verify-bootstrap-abc").exists());
        assert!(!idle.exists());
        assert!(tree.project.join("s1").exists());
        assert!(live.exists());
        assert!(tree.temp.join("other-dir").exists());
        assert!(tree.temp.join("verify-bootstrap-file").exists());
        assert!(other_project.join("s9/scratchpad").exists());
    }

    #[test]
    fn only_prints_with_dry_run() {
        let tree = fixture();
        fs::create_dir(tree.temp.join("verify-bootstrap-abc")).expect("mkdir");
        let idle = session(&tree.project, "s1", None);
        let outcome = prune_tree(&tree, &["--dry-run"]);
        outcome.assert_ok();
        assert_eq!(
            outcome.lines,
            vec![
                format!(
                    "would remove {}",
                    tree.temp.join("verify-bootstrap-abc").display()
                ),
                format!("would remove {}", idle.display()),
            ]
        );
        assert!(tree.temp.join("verify-bootstrap-abc").exists());
        assert!(idle.exists());
    }

    #[test]
    fn says_nothing_to_prune_when_there_is_nothing_including_missing_directories() {
        let dir = temp_dir();
        let temp = dir.path().join("nope").display().to_string();
        let base = dir.path().join("nobase").display().to_string();
        let outcome = prune(
            &["--temp-dir", &temp, "--claude-base", &base, "--now", "0"],
            &[],
        );
        outcome.assert_ok();
        assert_eq!(outcome.lines, vec!["prune-temp: nothing to prune"]);
    }

    #[test]
    fn reads_the_temp_dir_from_tmpdir_when_temp_dir_is_absent() {
        let tree = fixture();
        fs::create_dir(tree.temp.join("verify-bootstrap-x")).expect("mkdir");
        let base = tree.base.display().to_string();
        let now = NOW_MS.to_string();
        let tmpdir = format!("{}/", tree.temp.display());
        let outcome = prune(
            &["--claude-base", &base, "--now", &now, "--dry-run"],
            &[("TMPDIR", &tmpdir)],
        );
        assert_eq!(
            outcome.lines,
            vec![format!(
                "would remove {}",
                tree.temp.join("verify-bootstrap-x").display()
            )]
        );
    }

    #[test]
    fn asks_id_for_the_uid_when_no_claude_base_is_given() {
        let tree = fixture();
        let temp = tree.temp.display().to_string();
        let calls = std::cell::RefCell::new(Vec::new());
        let id = |command: &str, args: &[&str], _: &RunOptions| {
            calls
                .borrow_mut()
                .push(format!("{command} {}", args.join(" ")));
            RunResult::exited(0, "4242\n", "")
        };
        Fake::at(Path::new(CHECKOUT))
            .argv(&["--temp-dir", &temp, "--now", "0"])
            .run(&id)
            .task(main)
            .assert_ok();
        assert_eq!(calls.into_inner(), vec!["id -u"]);
        // Without an answer from `id`, there is no Claude base to look in.
        prune(&["--temp-dir", &temp], &[]).assert_ok();
    }

    #[test]
    fn refuses_a_matching_symlink_that_points_out_of_the_temp_dir() {
        let tree = fixture();
        let outside = temp_dir();
        symlink(outside.path(), tree.temp.join("verify-bootstrap-evil")).expect("symlink");
        assert_eq!(prune_tree(&tree, &[]).code(), "ERR_PRUNE_ESCAPES_PARENT");
        assert!(outside.path().exists());
    }

    #[test]
    fn refuses_a_scratchpad_that_is_a_symlink_out_of_its_session() {
        let tree = fixture();
        let outside = temp_dir();
        fs::create_dir(tree.project.join("s1")).expect("mkdir");
        symlink(outside.path(), tree.project.join("s1/scratchpad")).expect("symlink");
        touch(&tree.project.join("s1"), old());
        assert_eq!(prune_tree(&tree, &[]).code(), "ERR_PRUNE_ESCAPES_PARENT");
        assert!(outside.path().exists());
    }

    #[test]
    fn reports_a_removal_that_fails() {
        let tree = fixture();
        let locked = tree.temp.join("verify-bootstrap-locked");
        write(&locked, "inner/f", "x");
        let inner = locked.join("inner");
        fs::set_permissions(&inner, fs::Permissions::from_mode(0o500)).expect("chmod");
        let code = prune_tree(&tree, &[]).code();
        fs::set_permissions(&inner, fs::Permissions::from_mode(0o700)).expect("chmod back");
        assert_eq!(code, "ERR_PRUNE_REMOVE_FAILED");
    }

    #[test]
    fn rejects_bad_arguments() {
        for argv in [
            &["--bogus"][..],
            &["--now"][..],
            &["--now", "soon"][..],
            &["--now", "inf"][..],
            &["--temp-dir"][..],
        ] {
            assert_eq!(prune(argv, &[]).code(), "ERR_PRUNE_USAGE", "{argv:?}");
        }
    }
}
