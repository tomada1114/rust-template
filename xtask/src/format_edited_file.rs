//! `cargo xtask format-edited-file`: formats the one file a Claude Code
//! Edit/Write/MultiEdit just touched. Meant to be registered as a `PostToolUse` hook in a
//! personal settings file (`~/.claude/settings.json` or the gitignored
//! `.claude/settings.local.json`; see `AGENTS.md`), which pipes its JSON payload in.
//!
//! ```text
//! <hook JSON on stdin> | cargo xtask format-edited-file [--root DIR]
//! ```
//!
//! Reads `tool_input.file_path` and formats that one file; nothing else in the tree is
//! touched. A `.rs` file goes through rustfmt on standard input, with `--config-path`
//! naming the nearest `rustfmt.toml` between the file and the root (the one rustfmt would
//! find from the file), and the result is written back: given a path, rustfmt would also
//! rewrite every out-of-line `mod` child the file declares. Every extension the
//! pre-commit hook's Prettier job checks ([`PRETTIER_EXTENSIONS`]) goes through
//! `prettier --write`, from the root, so `.prettierignore` applies. It does nothing, and
//! exits 0, when the payload names no file, the file is of another type, no longer
//! exists, or lies outside the root once symlinks are resolved. The formatters are called
//! by bare name; the caller provides PATH (`mise exec --`).
//!
//! Exit codes: 0 formatted or nothing to do; 2 on failure, because Claude Code feeds a
//! `PostToolUse` hook's stderr back to the agent only on exit 2.
//!
//! Git work tree: not required.
//!
//! Errors (exit 2): `ERR_FORMAT_USAGE` (bad arguments, no stdin), `ERR_FORMAT_FAILED`
//! (the formatter exited non-zero on the edited file).

use std::path::{Component, Path, PathBuf};

use crate::context::{Context, RunOptions};
use crate::fail::{ScriptError, TaskResult};

const USAGE: &str = "cargo xtask format-edited-file [--root DIR] < hook-payload.json";
const HOOK_FAILURE: u8 = 2;

/// The extensions `lefthook.yml`'s prettier job checks; this hook formats the same set.
/// No check compares the two, so a change to one changes the other in the same commit.
pub(crate) const PRETTIER_EXTENSIONS: &[&str] = &[
    ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".css", ".html", ".yml", ".yaml",
];

const RUSTFMT_CONFIGS: [&str; 2] = ["rustfmt.toml", ".rustfmt.toml"];

/// How one file is formatted: a `stdin` formatter reads the file on standard input and
/// prints the result, which this hook writes back; the others rewrite the file in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Formatter {
    pub(crate) command: &'static str,
    pub(crate) args: Vec<String>,
    pub(crate) stdin: bool,
}

fn usage_error(summary: &str, actual: &str) -> ScriptError {
    ScriptError::new(
        "ERR_FORMAT_USAGE",
        summary,
        USAGE,
        actual,
        format!("run {USAGE}"),
    )
    .with_exit_code(HOOK_FAILURE)
}

/// The rustfmt config rustfmt itself would pick for `path`: the nearest one in its
/// directory or a parent, looking no higher than `root`.
fn rustfmt_config(path: &Path, root: &Path) -> Option<PathBuf> {
    let mut dir = path.parent()?;
    loop {
        if let Some(found) = RUSTFMT_CONFIGS
            .iter()
            .map(|name| dir.join(name))
            .find(|candidate| candidate.exists())
        {
            return Some(found);
        }
        if dir == root {
            return None;
        }
        dir = dir.parent()?;
    }
}

/// The extension with its dot (`.rs`), or empty when there is none.
fn extension_of(path: &Path) -> String {
    path.extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default()
}

/// The formatter for a file under `root`, or `None` when this hook leaves it alone.
pub(crate) fn formatter_for(path: &Path, root: &Path) -> Option<Formatter> {
    let extension = extension_of(path);
    if extension == ".rs" {
        let args = rustfmt_config(path, root).map_or_else(Vec::new, |config| {
            vec!["--config-path".to_owned(), config.display().to_string()]
        });
        return Some(Formatter {
            command: "rustfmt",
            args,
            stdin: true,
        });
    }
    PRETTIER_EXTENSIONS
        .contains(&extension.as_str())
        .then(|| Formatter {
            command: "pnpm",
            args: vec![
                "exec".to_owned(),
                "prettier".to_owned(),
                "--write".to_owned(),
                path.display().to_string(),
            ],
            stdin: false,
        })
}

fn parse_root(argv: &[String], fallback: &Path) -> Result<PathBuf, ScriptError> {
    let mut root = fallback.to_path_buf();
    let mut remaining = argv.iter();
    while let Some(arg) = remaining.next() {
        if arg != "--root" {
            return Err(usage_error("unknown argument", arg));
        }
        let value = remaining
            .next()
            .ok_or_else(|| usage_error("--root needs a directory", "--root with no value"))?;
        root = PathBuf::from(value);
    }
    if !root.is_dir() {
        return Err(usage_error(
            "--root is not a directory",
            &root.display().to_string(),
        ));
    }
    root.canonicalize()
        .map_err(|error| ScriptError::unexpected("resolving --root", &error))
}

/// The edited file's path from the hook's payload, when it names one.
fn edited_path(payload: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(payload).ok()?;
    let path = parsed.get("tool_input")?.get("file_path")?.as_str()?;
    (!path.is_empty()).then(|| path.to_owned())
}

/// `path` resolved against `base` and normalized without touching the file system, as
/// Node's `path.resolve` does.
fn resolve(base: &Path, path: &Path) -> PathBuf {
    let mut resolved = PathBuf::new();
    for component in base.join(path).components() {
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

/// The last five lines of a formatter's output, on one line.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim().lines().collect();
    lines[lines.len().saturating_sub(5)..].join(" ")
}

pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    let root = parse_root(&context.argv, &context.root)?;
    let read_stdin = context
        .stdin
        .ok_or_else(|| usage_error("no standard input", "stdin unavailable"))?;
    let Some(path) = edited_path(&read_stdin()?) else {
        return Ok(());
    };

    let absolute = resolve(&root, Path::new(&path));
    if !absolute.is_file() {
        return Ok(());
    }
    let real = absolute
        .canonicalize()
        .map_err(|error| ScriptError::unexpected("resolving the edited file", &error))?;
    let Ok(inside) = real.strip_prefix(&root) else {
        return Ok(());
    };
    let inside = inside.display().to_string();

    let Some(formatter) = formatter_for(&real, &root) else {
        return Ok(());
    };
    let original = if formatter.stdin {
        Some(
            std::fs::read_to_string(&real)
                .map_err(|error| ScriptError::unexpected("reading the edited file", &error))?,
        )
    } else {
        None
    };
    let args: Vec<&str> = formatter.args.iter().map(String::as_str).collect();
    let options = match &original {
        Some(text) => RunOptions {
            cwd: real.parent().map(Path::to_path_buf),
            env: None,
            input: Some(text.clone().into_bytes()),
        },
        None => RunOptions {
            cwd: Some(root.clone()),
            env: None,
            input: None,
        },
    };
    let result = context.run(formatter.command, &args, &options);
    if !result.success() {
        let next = if formatter.stdin {
            format!(
                "fix the syntax error in {inside} (that edit re-runs this hook); to check the file by hand, writing nothing: mise exec -- rustfmt --check {inside}"
            )
        } else {
            format!(
                "fix the syntax error, then run: mise exec -- pnpm exec prettier --write {inside}"
            )
        };
        return Err(ScriptError::new(
            "ERR_FORMAT_FAILED",
            format!("{} could not format the edited file", formatter.command),
            format!("{} exits 0 on {inside}", formatter.command),
            tail(&format!("{}{}", result.stderr_text(), result.stdout_text())),
            next,
        )
        .with_exit_code(HOOK_FAILURE));
    }
    // An empty result is never written back: it would erase the file rather than format it.
    if let Some(original) = original {
        let output = result.stdout_text();
        if !output.is_empty() && output != original {
            std::fs::write(&real, output)
                .map_err(|error| ScriptError::unexpected("writing the formatted file", &error))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    use tempfile::TempDir;

    use super::{Formatter, PRETTIER_EXTENSIONS, formatter_for, main};
    use crate::context::{RunOptions, RunResult};
    use crate::test_support::{Fake, Outcome, temp_dir, write};

    /// A temporary directory, by its real path (macOS's temp directory is a symlink).
    fn real_temp() -> (TempDir, PathBuf) {
        let dir = temp_dir();
        let real = dir.path().canonicalize().expect("canonical temp dir");
        (dir, real)
    }

    fn payload(file_path: &serde_json::Value) -> String {
        serde_json::json!({ "tool_name": "Edit", "tool_input": { "file_path": file_path } })
            .to_string()
    }

    fn payload_for(path: &Path) -> String {
        payload(&serde_json::Value::from(path.display().to_string()))
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Call {
        command: String,
        args: Vec<String>,
        cwd: Option<PathBuf>,
        input: Option<String>,
    }

    /// Run the hook at `root` with `stdin` and `argv`; every child answers `result`.
    fn hook(root: &Path, stdin: &str, argv: &[&str], result: &RunResult) -> (Outcome, Vec<Call>) {
        let calls = RefCell::new(Vec::new());
        let run = |command: &str, args: &[&str], options: &RunOptions| {
            calls.borrow_mut().push(Call {
                command: command.to_owned(),
                args: args.iter().map(ToString::to_string).collect(),
                cwd: options.cwd.clone(),
                input: options
                    .input
                    .as_ref()
                    .map(|bytes| String::from_utf8_lossy(bytes).into_owned()),
            });
            result.clone()
        };
        let outcome = Fake::at(root).argv(argv).stdin(stdin).run(&run).task(main);
        (outcome, calls.into_inner())
    }

    fn ok() -> RunResult {
        RunResult::exited(0, "", "")
    }

    fn prettier(path: &Path) -> Formatter {
        Formatter {
            command: "pnpm",
            args: vec![
                "exec".to_owned(),
                "prettier".to_owned(),
                "--write".to_owned(),
                path.display().to_string(),
            ],
            stdin: false,
        }
    }

    #[test]
    fn pipes_rust_through_rustfmt_naming_no_path_it_could_follow_into_mod_children() {
        let (_dir, root) = real_temp();
        assert_eq!(
            formatter_for(&root.join("a.rs"), &root),
            Some(Formatter {
                command: "rustfmt",
                args: vec![],
                stdin: true
            })
        );
    }

    #[test]
    fn hands_rustfmt_the_nearest_config_up_to_the_root() {
        let (_dir, outer) = real_temp();
        let root = outer.join("repo");
        std::fs::create_dir_all(root.join("crates/a/src")).expect("mkdir");
        write(&outer, "rustfmt.toml", "");
        let file = root.join("crates/a/src/lib.rs");
        let args = |file: &Path| formatter_for(file, &root).map(|formatter| formatter.args);
        // A config above the root is not the project's.
        assert_eq!(args(&file), Some(vec![]));
        write(&root, "rustfmt.toml", "edition = \"2024\"\n");
        assert_eq!(
            args(&file),
            Some(vec![
                "--config-path".to_owned(),
                root.join("rustfmt.toml").display().to_string()
            ])
        );
        write(&root, "crates/a/.rustfmt.toml", "");
        assert_eq!(
            args(&file),
            Some(vec![
                "--config-path".to_owned(),
                root.join("crates/a/.rustfmt.toml").display().to_string()
            ])
        );
    }

    #[test]
    fn formats_every_prettier_extension_with_prettier_in_place() {
        let expected = [
            ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".css", ".html", ".yml",
            ".yaml",
        ];
        assert_eq!(PRETTIER_EXTENSIONS, expected);
        for extension in PRETTIER_EXTENSIONS {
            let path = PathBuf::from(format!("/r/a{extension}"));
            assert_eq!(formatter_for(&path, Path::new("/r")), Some(prettier(&path)));
        }
    }

    #[test]
    fn leaves_every_other_file_alone() {
        for path in ["/r/a.md", "/r/a.toml", "/r/rs", "/r/.ts"] {
            assert_eq!(
                formatter_for(Path::new(path), Path::new("/r")),
                None,
                "{path}"
            );
        }
    }

    #[test]
    fn feeds_rustfmt_only_the_edited_files_text_and_writes_the_result_back() {
        let (_dir, root) = real_temp();
        let file = root.join("src/lib.rs");
        write(&root, "rustfmt.toml", "edition = \"2024\"\n");
        write(&root, "src/lib.rs", "mod child;\nfn main(){}");
        let (outcome, calls) = hook(
            &root,
            &payload_for(&file),
            &[],
            &RunResult::exited(0, "mod child;\nfn main() {}\n", ""),
        );
        outcome.assert_ok();
        // The only path rustfmt is given is its config: with the file's path it would also
        // format every out-of-line `mod` child, here `src/child.rs`.
        assert_eq!(
            calls,
            vec![Call {
                command: "rustfmt".to_owned(),
                args: vec![
                    "--config-path".to_owned(),
                    root.join("rustfmt.toml").display().to_string()
                ],
                cwd: Some(root.join("src")),
                input: Some("mod child;\nfn main(){}".to_owned()),
            }]
        );
        assert_eq!(
            std::fs::read_to_string(&file).expect("read"),
            "mod child;\nfn main() {}\n"
        );
    }

    #[test]
    fn never_writes_back_an_empty_rustfmt_result() {
        let (_dir, root) = real_temp();
        write(&root, "lib.rs", "fn main(){}");
        let (outcome, _) = hook(&root, &payload_for(&root.join("lib.rs")), &[], &ok());
        outcome.assert_ok();
        assert_eq!(
            std::fs::read_to_string(root.join("lib.rs")).expect("read"),
            "fn main(){}"
        );
    }

    #[test]
    fn formats_an_edited_file_given_relative_to_the_root_with_prettier() {
        for name in ["ci.yml", "a.tsx"] {
            let (_dir, root) = real_temp();
            write(&root, name, "a:   1\n");
            let (outcome, calls) =
                hook(&root, &payload(&serde_json::Value::from(name)), &[], &ok());
            outcome.assert_ok();
            let expected = prettier(&root.join(name));
            assert_eq!(
                calls,
                vec![Call {
                    command: expected.command.to_owned(),
                    args: expected.args,
                    cwd: Some(root.clone()),
                    input: None,
                }]
            );
        }
    }

    #[test]
    fn takes_the_root_from_the_root_flag() {
        let (_dir, root) = real_temp();
        write(&root, "a.ts", "");
        let root_text = root.display().to_string();
        let (outcome, calls) = hook(
            Path::new("/elsewhere"),
            &payload_for(&root.join("a.ts")),
            &["--root", &root_text],
            &ok(),
        );
        outcome.assert_ok();
        assert_eq!(calls.first().and_then(|call| call.cwd.clone()), Some(root));
    }

    #[test]
    fn does_nothing_for_a_payload_without_a_usable_path() {
        let (_dir, root) = real_temp();
        for stdin in [
            "not json".to_owned(),
            serde_json::json!({ "tool_name": "Bash" }).to_string(),
            payload(&serde_json::Value::from(42)),
            payload(&serde_json::Value::from("")),
        ] {
            let (outcome, calls) = hook(&root, &stdin, &[], &ok());
            outcome.assert_ok();
            assert!(calls.is_empty(), "{stdin}");
        }
    }

    #[test]
    fn does_nothing_for_a_file_of_another_type_a_missing_file_or_a_directory() {
        let (_dir, root) = real_temp();
        write(&root, "notes.md", "");
        std::fs::create_dir(root.join("dir.ts")).expect("mkdir");
        for name in ["notes.md", "gone.rs", "dir.ts"] {
            let (outcome, calls) = hook(&root, &payload_for(&root.join(name)), &[], &ok());
            outcome.assert_ok();
            assert!(calls.is_empty(), "{name}");
        }
    }

    #[test]
    fn does_nothing_for_a_file_outside_the_root_even_through_a_symlink() {
        let (_dir, root) = real_temp();
        let (_other, outside) = real_temp();
        write(&outside, "a.rs", "");
        std::os::unix::fs::symlink(outside.join("a.rs"), root.join("link.rs")).expect("symlink");
        for path in [
            outside.join("a.rs"),
            root.join("link.rs"),
            root.join("../x.rs"),
        ] {
            let (outcome, calls) = hook(&root, &payload_for(&path), &[], &ok());
            outcome.assert_ok();
            assert!(calls.is_empty(), "{}", path.display());
        }
    }

    #[test]
    fn fails_with_exit_code_2_when_rustfmt_fails() {
        let (_dir, root) = real_temp();
        write(&root, "bad.rs", "fn (");
        let (outcome, _) = hook(
            &root,
            &payload_for(&root.join("bad.rs")),
            &[],
            &RunResult::exited(1, "", "error: expected identifier\n --> bad.rs:1:4"),
        );
        let error = outcome.failure();
        assert_eq!(error.code(), "ERR_FORMAT_FAILED");
        assert_eq!(error.exit_code, 2);
        assert!(error.details.actual.contains("expected identifier"));
        assert_eq!(
            error.details.next,
            "fix the syntax error in bad.rs (that edit re-runs this hook); to check the file by hand, writing nothing: mise exec -- rustfmt --check bad.rs"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("bad.rs")).expect("read"),
            "fn ("
        );
    }

    #[test]
    fn names_the_single_file_prettier_command_when_prettier_fails() {
        let (_dir, root) = real_temp();
        write(&root, "bad.ts", "export {");
        let (outcome, _) = hook(
            &root,
            &payload_for(&root.join("bad.ts")),
            &[],
            &RunResult::exited(2, "", "SyntaxError: '}' expected."),
        );
        assert_eq!(
            outcome.failure().details.next,
            "fix the syntax error, then run: mise exec -- pnpm exec prettier --write bad.ts"
        );
    }

    #[test]
    fn keeps_the_last_five_lines_of_a_formatters_output() {
        let (_dir, root) = real_temp();
        write(&root, "bad.rs", "fn (");
        let (outcome, _) = hook(
            &root,
            &payload_for(&root.join("bad.rs")),
            &[],
            &RunResult::exited(1, "7\n", "1\n2\n3\n4\n5\n6\n"),
        );
        assert_eq!(outcome.failure().details.actual, "3 4 5 6 7");
    }

    #[test]
    fn fails_with_err_format_usage_and_exit_code_2_for_bad_arguments() {
        let (_dir, root) = real_temp();
        for (argv, actual) in [
            (&["--fast"][..], "--fast"),
            (&["--root"][..], "--root with no value"),
            (
                &["--root", "/definitely/not/here"][..],
                "/definitely/not/here",
            ),
        ] {
            let (outcome, _) = hook(
                &root,
                &payload(&serde_json::Value::from("a.rs")),
                argv,
                &ok(),
            );
            let error = outcome.failure();
            assert_eq!(error.code(), "ERR_FORMAT_USAGE");
            assert_eq!(error.exit_code, 2);
            assert_eq!(error.details.actual, actual);
        }
    }

    #[test]
    fn fails_with_err_format_usage_when_no_standard_input_is_available() {
        let (_dir, root) = real_temp();
        let error = Fake::at(&root).task(main).failure();
        assert_eq!(error.code(), "ERR_FORMAT_USAGE");
        assert_eq!(error.exit_code, 2);
    }
}
