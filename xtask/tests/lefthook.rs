//! `lefthook.yml`'s pre-commit hook, run by the real lefthook through a real
//! `git commit` in a throwaway repository: the commit that concludes a conflicted merge,
//! or one made at a conflicted rebase stop, carries a resolution no hook has seen, so the
//! staged guard and the skills mirror must still run for it.
//!
//! The throwaway repository gets the checkout's `lefthook.yml` (read, never written) and
//! a `cargo` first on PATH that runs this build's `xtask` for `cargo xtask …`, with the
//! throwaway repository as its root, as `cargo run` there would — and only when the job
//! set `CARGO_TARGET_DIR=target/xtask`, so a hook never waits on a workspace build's lock.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

/// The checkout this test was built from (read only: its lefthook.yml and mise.toml).
fn checkout() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// The value, or a panic that names what failed: a panic is how a test fails.
fn must<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> T {
    result.unwrap_or_else(|error| panic!("{what}: {error}"))
}

// Assembled at runtime: this file must never hold a credential-shaped literal.
fn github_token() -> String {
    ["gh", "p_", &"Z".repeat(36)].concat()
}

const SKILL: &str = "demo/SKILL.md";

/// The target directory every `cargo xtask` hook command builds into, away from the
/// workspace's `target/`, whose lock a concurrent build holds.
const HOOK_TARGET_DIR: &str = "CARGO_TARGET_DIR=target/xtask";

/// A directory holding a `cargo` that runs this build's `xtask` and nothing else, and
/// refuses a `cargo xtask` run without the hooks' own target directory.
fn cargo_shim(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    must(std::fs::create_dir_all(&bin), "mkdir");
    let cargo = bin.join("cargo");
    let script = format!(
        "#!/bin/sh\nif [ \"$1\" = xtask ] && [ \"$CARGO_TARGET_DIR\" = target/xtask ]; then\n  shift\n  CARGO_MANIFEST_DIR=\"$PWD/xtask\" exec '{}' \"$@\"\nfi\necho \"unexpected: CARGO_TARGET_DIR=$CARGO_TARGET_DIR cargo $*\" >&2\nexit 1\n",
        env!("CARGO_BIN_EXE_xtask")
    );
    must(std::fs::write(&cargo, script), "write the shim");
    let mut permissions = must(std::fs::metadata(&cargo), "stat").permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
    must(std::fs::set_permissions(&cargo, permissions), "chmod");
    bin
}

/// The directory holding the pinned lefthook. A mise shim picks its version from the
/// working directory's mise.toml, which a throwaway repository lacks, so the hook there
/// needs the real binary on PATH: ask mise from the checkout, or else trust PATH.
fn lefthook_dir() -> Option<PathBuf> {
    let output = Command::new("mise")
        .args(["which", "lefthook"])
        .current_dir(checkout())
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (output.status.success() && !path.is_empty())
        .then(|| Path::new(&path).parent().map(Path::to_path_buf))
        .flatten()
}

/// One throwaway repository, its hook environment, and the shim beside it.
struct Repo {
    _shim: TempDir,
    dir: TempDir,
    env: BTreeMap<String, String>,
}

impl Repo {
    fn path(&self) -> &Path {
        self.dir.path()
    }

    /// Run `command` in the repository: its status and everything it printed.
    fn run(&self, command: &str, args: &[&str]) -> (bool, String) {
        let output = Command::new(command)
            .args(args)
            .current_dir(self.path())
            .env_clear()
            .envs(&self.env)
            .output()
            .unwrap_or_else(|error| panic!("start {command}: {error}"));
        (
            output.status.success(),
            format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
        )
    }

    fn git(&self, args: &[&str]) {
        let (ok, output) = self.run("git", args);
        assert!(ok, "git {}: {output}", args.join(" "));
    }

    fn write(&self, path: &str, content: &str) {
        let target = self.path().join(path);
        if let Some(parent) = target.parent() {
            must(std::fs::create_dir_all(parent), "mkdir");
        }
        must(std::fs::write(target, content), "write");
    }

    /// Write `files`, stage them, and commit (no hook is installed yet).
    fn commit(&self, message: &str, files: &[(String, String)]) {
        for (path, content) in files {
            self.write(path, content);
        }
        let mut args = vec!["add", "--"];
        args.extend(files.iter().map(|(path, _)| path.as_str()));
        self.git(&args);
        self.git(&["commit", "-q", "-m", message]);
    }

    fn merge_concluded(&self) -> bool {
        !self.path().join(".git/MERGE_HEAD").exists()
    }
}

/// The process environment without `GIT_*` or `LEFTHOOK*` (either would change the run)
/// or a `CARGO_TARGET_DIR` the test runner set (the hook must set its own), with no global
/// or system git config (a user's `core.hooksPath` or `merge.ff=only` would), and the
/// shim and lefthook first on PATH.
fn hook_env(shim: &Path) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .filter(|(name, _)| {
            !name.starts_with("GIT_") && !name.starts_with("LEFTHOOK") && name != "CARGO_TARGET_DIR"
        })
        .collect();
    let mut path = vec![shim.display().to_string()];
    path.extend(lefthook_dir().map(|dir| dir.display().to_string()));
    path.extend(env.get("PATH").cloned());
    env.insert("PATH".to_owned(), path.join(":"));
    env.insert("NO_COLOR".to_owned(), "1".to_owned());
    env.insert("GIT_CONFIG_GLOBAL".to_owned(), "/dev/null".to_owned());
    env.insert("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned());
    env
}

/// A repository with the checkout's lefthook.yml, where `main` and `side` both changed
/// `files` from a common base, with lefthook's hooks installed and `main` checked out.
fn diverged_repo(files: fn(&str) -> Vec<(String, String)>) -> Repo {
    let shim = must(tempfile::tempdir(), "temp dir");
    let env = hook_env(&cargo_shim(shim.path()));
    let repo = Repo {
        _shim: shim,
        dir: must(tempfile::tempdir(), "temp dir"),
        env,
    };
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "test@example.com"]);
    repo.git(&["config", "user.name", "Test"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    must(
        std::fs::copy(
            checkout().join("lefthook.yml"),
            repo.path().join("lefthook.yml"),
        ),
        "copy lefthook.yml",
    );
    repo.git(&["add", "lefthook.yml"]);
    repo.commit("base", &files("base"));
    repo.git(&["switch", "-q", "-c", "side"]);
    repo.commit("side", &files("side"));
    repo.git(&["switch", "-q", "main"]);
    repo.commit("main", &files("main"));
    let (installed, output) = repo.run("lefthook", &["install"]);
    assert!(
        installed,
        "lefthook install failed (run the tests under mise, e.g. `mise exec -- just test-xtask`): {output}"
    );
    repo
}

/// `side` merged into `main`, every file conflicting; the merge is left open.
fn conflicted_merge(files: fn(&str) -> Vec<(String, String)>) -> Repo {
    let repo = diverged_repo(files);
    let (merged, _) = repo.run("git", &["merge", "side"]);
    assert!(!merged);
    assert!(!repo.merge_concluded());
    repo
}

fn notes(side: &str) -> Vec<(String, String)> {
    vec![("notes.txt".to_owned(), format!("{side}\n"))]
}

fn skill(side: &str) -> Vec<(String, String)> {
    vec![
        (format!(".agents/skills/{SKILL}"), format!("{side}\n")),
        (format!(".claude/skills/{SKILL}"), format!("{side}\n")),
    ]
}

fn notes_and_skill(side: &str) -> Vec<(String, String)> {
    let mut files = notes(side);
    files.extend(skill(side));
    files
}

#[test]
fn a_merge_resolution_with_a_credential_shaped_line_is_refused() {
    let repo = conflicted_merge(notes);
    repo.write(
        "notes.txt",
        &format!("resolved\ntoken = {}\n", github_token()),
    );
    repo.git(&["add", "notes.txt"]);

    let (ok, output) = repo.run("git", &["commit", "--no-edit"]);
    assert!(!ok, "{output}");
    assert!(
        output.contains("ERR_STAGED_CREDENTIAL_SHAPED: notes.txt"),
        "{output}"
    );
    assert!(!output.contains(&github_token()));
    assert!(!repo.merge_concluded());
}

#[test]
fn a_resolved_skill_conflict_staged_without_its_synced_mirror_is_refused() {
    let repo = conflicted_merge(skill);
    repo.write(&format!(".agents/skills/{SKILL}"), "resolved\n");
    repo.write(&format!(".claude/skills/{SKILL}"), "main\n");
    repo.git(&["add", ".agents", ".claude"]);

    let (ok, output) = repo.run("git", &["commit", "--no-edit"]);
    assert!(!ok, "{output}");
    assert!(output.contains("ERR_AGENTS_DRIFT"), "{output}");
    assert!(
        output.contains(&format!(".claude/skills/{SKILL}")),
        "{output}"
    );
    assert!(!repo.merge_concluded());
}

#[test]
fn a_clean_merge_resolution_concludes_skipping_only_the_style_jobs() {
    let repo = conflicted_merge(notes_and_skill);
    for path in [
        "notes.txt".to_owned(),
        format!(".agents/skills/{SKILL}"),
        format!(".claude/skills/{SKILL}"),
    ] {
        repo.write(&path, "resolved\n");
    }
    repo.git(&["add", "--all"]);

    let (ok, output) = repo.run("git", &["commit", "--no-edit"]);
    assert!(ok, "{output}");
    assert!(output.contains("staged guard"), "{output}");
    for job in ["rustfmt", "typos"] {
        assert!(
            output.contains(&format!("{job} (skip) by condition")),
            "{job}: {output}"
        );
    }
    assert!(repo.merge_concluded());
}

#[test]
fn a_rebase_stop_resolution_with_a_credential_shaped_line_is_refused() {
    let repo = diverged_repo(notes);
    let (rebased, _) = repo.run("git", &["rebase", "side"]);
    assert!(!rebased);
    assert!(repo.path().join(".git/rebase-merge").exists());
    repo.write(
        "notes.txt",
        &format!("resolved\ntoken = {}\n", github_token()),
    );
    repo.git(&["add", "notes.txt"]);

    let (ok, output) = repo.run("git", &["commit", "-m", "main, resolved"]);
    assert!(!ok, "{output}");
    assert!(
        output.contains("ERR_STAGED_CREDENTIAL_SHAPED: notes.txt"),
        "{output}"
    );
    assert!(!output.contains(&github_token()));
}

#[test]
fn every_documented_xtask_hook_builds_in_its_own_target_directory() {
    let lefthook = must(
        std::fs::read_to_string(checkout().join("lefthook.yml")),
        "read lefthook.yml",
    );
    let jobs: Vec<&str> = lefthook
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("run:") && line.contains("cargo xtask"))
        .collect();
    assert_eq!(jobs.len(), 2, "{jobs:?}");
    for job in jobs {
        assert!(
            job.starts_with(&format!("run: {HOOK_TARGET_DIR} cargo xtask ")),
            "{job}"
        );
    }

    let agents = must(
        std::fs::read_to_string(checkout().join("AGENTS.md")),
        "read AGENTS.md",
    );
    let format_hook: Vec<&str> = agents
        .lines()
        .filter(|line| line.contains("cd \"$CLAUDE_PROJECT_DIR\""))
        .collect();
    assert_eq!(format_hook.len(), 1, "{format_hook:?}");
    assert!(
        format_hook[0].contains(&format!(
            "cd \"$CLAUDE_PROJECT_DIR\" && {HOOK_TARGET_DIR} mise exec -- cargo xtask format-edited-file`"
        )),
        "{}",
        format_hook[0]
    );
}

/// A `skip:` or `only:` on the hook, or on the staged guard or the skills mirror, would
/// let a merge or rebase-stop commit through unjudged; the tests above prove the merge
/// case through a real commit, and this pins every case at the config.
#[test]
fn never_skips_the_staged_guard_or_the_skills_mirror() {
    let text = must(
        std::fs::read_to_string(checkout().join("lefthook.yml")),
        "read lefthook.yml",
    );
    let docs = must(
        yaml_rust2::YamlLoader::load_from_str(&text),
        "parse lefthook.yml",
    );
    let hook = &docs[0]["pre-commit"];
    for key in ["skip", "only"] {
        assert!(hook[key].is_badvalue(), "pre-commit has `{key}`");
    }
    let jobs = hook["jobs"].as_vec().expect("pre-commit has a jobs list");
    for name in ["staged guard", "skills mirror"] {
        let job = jobs
            .iter()
            .find(|job| job["name"].as_str() == Some(name))
            .unwrap_or_else(|| panic!("lefthook.yml has no \"{name}\" job"));
        for key in ["skip", "only"] {
            assert!(job[key].is_badvalue(), "{name} has `{key}`");
        }
    }
}
