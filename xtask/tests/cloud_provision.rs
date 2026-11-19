//! `.claude/cloud/provision.sh`, run under bash from a copy in a throwaway repository with
//! stub `mise`, `rustup`, `cargo`, `lefthook`, `apt-get`, and the helpers they need
//! (`id`, `dpkg`, `timeout`, `setsid`) first on PATH. Each stub records its call and
//! exits 0, or 1 when the test names it in `FAIL_STUBS`. The script installs packages
//! and toolchains on a real cloud VM, so nothing else executes it before a session does.

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

/// The value, or a panic that names what failed: a panic is how a test fails.
fn must<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> T {
    result.unwrap_or_else(|error| panic!("{what}: {error}"))
}

fn cloud_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../.claude/cloud")
}

const STUBS: &[&str] = &[
    "mise", "rustup", "cargo", "lefthook", "apt-get", "just", "id", "dpkg", "timeout", "setsid",
];

/// A stub's body after the shared logging and failure lines.
fn stub_tail(name: &str) -> &'static str {
    match name {
        // Root, so the apt branch runs whoever runs the test.
        "id" => "echo 0\n",
        // Every package counts as missing.
        "dpkg" => "exit 1\n",
        // Runs the wrapped command, so `warm`'s cargo builds reach the cargo stub.
        "timeout" => "shift\nexec \"$@\"\n",
        _ => "exit 0\n",
    }
}

fn write_stub(bin: &Path, name: &str) {
    let body = format!(
        "#!/bin/sh\nprintf '%s %s CARGO_TARGET_DIR=%s\\n' '{name}' \"$*\" \"${{CARGO_TARGET_DIR:-}}\" >> \"$STUB_LOG\"\ncase \" $FAIL_STUBS \" in *' {name} '*) exit 1 ;; esac\n{tail}",
        tail = stub_tail(name),
    );
    let path = bin.join(name);
    must(std::fs::write(&path, body), "write a stub");
    let mut permissions = must(std::fs::metadata(&path), "stat").permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
    must(std::fs::set_permissions(&path, permissions), "chmod");
}

/// A throwaway repository holding a copy of the checkout's cloud files.
struct Repo {
    dir: TempDir,
}

impl Repo {
    fn new() -> Self {
        let dir = must(TempDir::new(), "tempdir");
        let cloud = dir.path().join("repo/.claude/cloud");
        must(std::fs::create_dir_all(&cloud), "mkdir .claude/cloud");
        for file in ["provision.sh", "apt-packages.txt"] {
            must(
                std::fs::copy(cloud_dir().join(file), cloud.join(file)),
                "copy a cloud file",
            );
        }
        let bin = dir.path().join("bin");
        must(std::fs::create_dir_all(&bin), "mkdir bin");
        for name in STUBS {
            write_stub(&bin, name);
        }
        must(
            std::fs::create_dir_all(dir.path().join("home")),
            "mkdir home",
        );
        Self { dir }
    }

    fn root(&self) -> PathBuf {
        self.dir.path().join("repo")
    }

    fn write(&self, relative: &str, text: &str) {
        must(std::fs::write(self.root().join(relative), text), "write");
    }

    fn env_file(&self) -> PathBuf {
        self.dir.path().join("claude-env")
    }

    /// Runs `bash .claude/cloud/provision.sh <mode>` with only the given variables set
    /// beyond PATH, HOME, TMPDIR, and the stubs' own.
    fn run(&self, mode: &str, env: &[(&str, &str)], failing: &str) -> Run {
        let log = self.dir.path().join("stub.log");
        let script = self.root().join(".claude/cloud/provision.sh");
        let mut command = Command::new("bash");
        command
            .arg(&script)
            .arg(mode)
            .current_dir(self.root())
            .env_clear()
            .env(
                "PATH",
                format!(
                    "{}:/usr/bin:/bin:/usr/sbin:/sbin",
                    self.dir.path().join("bin").display()
                ),
            )
            .env("HOME", self.dir.path().join("home"))
            .env("TMPDIR", self.dir.path())
            .env("STUB_LOG", &log)
            .env("FAIL_STUBS", failing);
        for (key, value) in env {
            command.env(key, value);
        }
        let output = must(command.output(), "run provision.sh");
        Run {
            calls: std::fs::read_to_string(&log)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect(),
            status: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    /// A cloud session whose xtask binary is already built, so no warm build detaches.
    fn run_cloud_session(&self, failing: &str) -> Run {
        let xtask = self.root().join("target/xtask/debug");
        must(std::fs::create_dir_all(&xtask), "mkdir target/xtask/debug");
        let binary = xtask.join("xtask");
        must(std::fs::write(&binary, "#!/bin/sh\n"), "write a fake xtask");
        let mut permissions = must(std::fs::metadata(&binary), "stat").permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
        must(std::fs::set_permissions(&binary, permissions), "chmod");
        let env_file = self.env_file().display().to_string();
        self.run(
            "session",
            &[
                ("CLAUDE_CODE_REMOTE", "true"),
                ("CLAUDE_ENV_FILE", &env_file),
            ],
            failing,
        )
    }
}

/// Every stub call the script made (`<name> <args> CARGO_TARGET_DIR=<value>`).
struct Run {
    calls: Vec<String>,
    status: Option<i32>,
    stderr: String,
}

impl Run {
    fn called(&self, prefix: &str) -> bool {
        self.calls.iter().any(|call| call.starts_with(prefix))
    }
}

const PATH_LINE: &str = r#"export PATH="$HOME/.local/share/mise/shims:$HOME/.cargo/bin:$PATH""#;

/// Named after the file, so `cargo nextest run -p xtask cloud_provision` selects them.
mod cloud_provision {
    use super::{PATH_LINE, Repo, cloud_dir, must};

    #[test]
    fn session_mode_does_nothing_outside_a_cloud_session() {
        let repo = Repo::new();
        let run = repo.run("session", &[], "");
        assert_eq!(run.status, Some(0), "stderr: {}", run.stderr);
        assert_eq!(run.calls, Vec::<String>::new(), "no stub may run locally");
    }

    #[test]
    fn session_mode_trusts_installs_and_hooks_in_a_cloud_session() {
        let repo = Repo::new();
        let run = repo.run_cloud_session("");
        assert_eq!(run.status, Some(0), "stderr: {}", run.stderr);
        for expected in ["mise trust mise.toml", "mise install", "lefthook install"] {
            assert!(run.called(expected), "no `{expected}` in {:?}", run.calls);
        }
        let env_file = must(
            std::fs::read_to_string(repo.env_file()),
            "read CLAUDE_ENV_FILE",
        );
        assert_eq!(env_file.lines().collect::<Vec<_>>(), vec![PATH_LINE]);
    }

    #[test]
    fn a_locked_install_is_used_when_mise_lock_exists() {
        let repo = Repo::new();
        repo.write("mise.lock", "# a lockfile\n");
        let run = repo.run_cloud_session("");
        assert!(
            run.called("mise install --locked"),
            "calls: {:?}",
            run.calls
        );
    }

    #[test]
    fn an_unlocked_install_is_used_without_mise_lock() {
        let repo = Repo::new();
        let run = repo.run_cloud_session("");
        assert!(run.called("mise install "), "calls: {:?}", run.calls);
        assert!(
            !run.called("mise install --locked"),
            "calls: {:?}",
            run.calls
        );
    }

    #[test]
    fn a_failing_step_still_exits_zero() {
        let repo = Repo::new();
        let run = repo.run_cloud_session("mise rustup cargo lefthook apt-get");
        assert_eq!(run.status, Some(0), "stderr: {}", run.stderr);
        assert!(
            run.stderr.contains("WARN(provision)"),
            "stderr: {}",
            run.stderr
        );
        assert!(
            !repo.root().join("target/.cloud-provision.sha256").exists(),
            "a failed run must not write the stamp, or the next session skips the retry"
        );
    }

    #[test]
    fn setup_mode_does_not_require_claude_code_remote() {
        let repo = Repo::new();
        let run = repo.run("setup", &[], "");
        assert_eq!(run.status, Some(0), "stderr: {}", run.stderr);
        for expected in [
            "apt-get install",
            "mise trust",
            "rustup toolchain install",
            "cargo fetch --locked",
            "lefthook install",
        ] {
            assert!(run.called(expected), "no `{expected}` in {:?}", run.calls);
        }
    }

    #[test]
    fn apt_packages_cover_the_openssl_headers() {
        let text = must(
            std::fs::read_to_string(cloud_dir().join("apt-packages.txt")),
            "read apt-packages.txt",
        );
        let packages: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect();
        for expected in ["pkg-config", "libssl-dev"] {
            assert!(
                packages.contains(&expected),
                "{expected} missing from {packages:?}"
            );
        }
    }

    #[test]
    fn setup_mode_builds_xtask_into_its_own_target_dir_first() {
        let repo = Repo::new();
        let run = repo.run("setup", &[], "");
        let builds: Vec<&String> = run
            .calls
            .iter()
            .filter(|call| call.starts_with("cargo build"))
            .collect();
        let first = builds
            .first()
            .unwrap_or_else(|| panic!("no cargo build in {:?}", run.calls));
        assert!(first.contains("-p xtask"), "first build: {first}");
        assert!(
            first.ends_with("CARGO_TARGET_DIR=target/xtask"),
            "first build: {first}"
        );
        let second = builds
            .get(1)
            .unwrap_or_else(|| panic!("no workspace build in {:?}", run.calls));
        assert!(
            second.contains("--workspace --all-targets --all-features"),
            "second build: {second}"
        );
        assert!(
            second.ends_with("CARGO_TARGET_DIR="),
            "second build: {second}"
        );
    }
}
