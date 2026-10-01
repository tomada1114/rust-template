//! `cargo xtask clippy-guard cargo clippy …`: runs a `cargo clippy` command and fails
//! when clippy's configuration names something clippy cannot resolve. A `path` in a
//! `clippy.toml` (core's bans are in its crate's) that is misspelled, renamed or moved in
//! a Rust release, or missing on the build's target makes clippy print only a
//! configuration warning ("… does not refer to a reachable function"). That warning is
//! not a lint, so `-D warnings` leaves the exit status 0 and the ban silently does
//! nothing. `just lint` and CI's clippy steps run clippy through this task so that
//! warning fails them. Cargo replays a fresh crate's cached diagnostics and re-checks a
//! crate whose `clippy.toml` changed, so a warm build reports the warning too.
//!
//! The command is spelled out, not implied, so the lockfile check in
//! `scripts/checks/workflow-hygiene.ts` still sees `cargo clippy … --locked`. Clippy's
//! output is captured, then printed to stdout once it exits; when stdout is a terminal and
//! `CARGO_TERM_COLOR` is unset, cargo is asked for colour anyway. A diagnostic counts as a
//! configuration one when its primary location is a `clippy.toml` or `.clippy.toml`, or
//! when its message says a path does not refer to a reachable item. Any other
//! configuration diagnostic (a deprecated or unknown key, which clippy also reports only
//! as a warning when deprecated) fails too, under its own code.
//!
//! Git work tree: not required; cargo runs in the repository root.
//!
//! Errors:
//! - `ERR_CLIPPY_USAGE`: the arguments are not a `cargo clippy` command
//! - `ERR_CLIPPY_BAN_UNRESOLVED`: a `path` in a clippy.toml does not refer to a reachable
//!   item
//! - `ERR_CLIPPY_CONFIG_INVALID`: any other diagnostic located in a clippy.toml (a
//!   deprecated or unknown key)
//! - `ERR_CLIPPY_FAILED`: clippy exited non-zero (its findings are printed above)

use std::path::Path;

use crate::context::{Context, Env, RunOptions};
use crate::fail::{ScriptError, TaskResult};

const CONFIG_FILES: [&str; 2] = ["clippy.toml", ".clippy.toml"];
// clippy 1.98.1's wording; a `-->` line in a clippy.toml catches a rewording too.
const UNRESOLVED: &str = "does not refer to a reachable";

/// What kind of configuration problem a diagnostic is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// A path names nothing clippy reaches.
    Unresolved,
    /// Any other problem in a clippy.toml.
    Invalid,
}

/// One diagnostic clippy reported about its configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfigDiagnostic {
    pub(crate) kind: Kind,
    pub(crate) message: String,
    /// `file:line:column`, as the diagnostic's `-->` line gives it; `None` without one.
    pub(crate) location: Option<String>,
}

/// `text` without terminal control sequences: CSI (`ESC [` … final byte, or the C1
/// `U+009B`), OSC (`ESC ]` … BEL or `ESC \`), and any other two-character escape.
pub(crate) fn strip_control_sequences(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{9b}' => skip_csi(&mut chars),
            '\u{1b}' => match chars.next() {
                Some('[') => skip_csi(&mut chars),
                Some(']') => skip_osc(&mut chars),
                _ => {}
            },
            other => out.push(other),
        }
    }
    out
}

type Chars<'a> = std::iter::Peekable<std::str::Chars<'a>>;

/// A CSI sequence's parameter and intermediate bytes, then its one final byte.
fn skip_csi(chars: &mut Chars<'_>) {
    while chars
        .next_if(|next| ('\u{20}'..='\u{3f}').contains(next))
        .is_some()
    {}
    chars.next_if(|next| ('\u{40}'..='\u{7e}').contains(next));
}

/// An OSC sequence, up to and including its BEL or `ESC \\` terminator.
fn skip_osc(chars: &mut Chars<'_>) {
    while let Some(next) = chars.next() {
        if next == '\u{7}' || (next == '\u{1b}' && chars.next_if_eq(&'\\').is_some()) {
            return;
        }
    }
}

/// The message of a `warning: …` / `error[E…]: …` header line.
fn header_message(line: &str) -> Option<&str> {
    let rest = line
        .strip_prefix("warning")
        .or_else(|| line.strip_prefix("error"))?;
    let rest = match rest.strip_prefix('[') {
        Some(code) => {
            let end = code.find(']').filter(|end| *end > 0)?;
            &code[end + 1..]
        }
        None => rest,
    };
    rest.strip_prefix(": ")
        .filter(|message| !message.is_empty())
}

/// The `file:line:column` of a `--> file:line:column` line.
fn primary_location(line: &str) -> Option<&str> {
    let location = line.trim_start().strip_prefix("--> ")?.trim_end();
    let mut parts = location.rsplitn(3, ':');
    let numeric = |part: Option<&str>| {
        part.is_some_and(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
    };
    (numeric(parts.next())
        && numeric(parts.next())
        && parts.next().is_some_and(|file| !file.is_empty()))
    .then_some(location)
}

fn kind_of(message: &str, location: Option<&str>) -> Option<Kind> {
    if message.contains(UNRESOLVED) {
        return Some(Kind::Unresolved);
    }
    let file = location?.rsplitn(3, ':').nth(2)?;
    let name = Path::new(file).file_name()?.to_str()?;
    CONFIG_FILES.contains(&name).then_some(Kind::Invalid)
}

/// The configuration diagnostics in rustc's human-readable output, each once.
pub(crate) fn config_diagnostics(output: &str) -> Vec<ConfigDiagnostic> {
    let mut found: Vec<ConfigDiagnostic> = Vec::new();
    let mut pending: Option<(String, Option<String>)> = None;
    let mut flush = |pending: Option<(String, Option<String>)>| {
        let Some((message, location)) = pending else {
            return;
        };
        let Some(kind) = kind_of(&message, location.as_deref()) else {
            return;
        };
        let diagnostic = ConfigDiagnostic {
            kind,
            message,
            location,
        };
        if !found.contains(&diagnostic) {
            found.push(diagnostic);
        }
    };
    for line in strip_control_sequences(output).split('\n') {
        if let Some(message) = header_message(line) {
            flush(pending.take());
            pending = Some((message.to_owned(), None));
            continue;
        }
        if let (Some(location), Some((_, slot @ None))) = (primary_location(line), pending.as_mut())
        {
            *slot = Some(location.to_owned());
        }
    }
    flush(pending);
    found
}

fn describe(diagnostic: &ConfigDiagnostic, root: &Path) -> String {
    let Some(location) = &diagnostic.location else {
        return diagnostic.message.clone();
    };
    let prefix = format!("{}/", root.display());
    let shown = location.strip_prefix(&prefix).unwrap_or(location);
    format!("{} ({shown})", diagnostic.message)
}

fn listed(found: &[&ConfigDiagnostic], root: &Path) -> String {
    found
        .iter()
        .map(|diagnostic| describe(diagnostic, root))
        .collect::<Vec<_>>()
        .join("; ")
}

/// The environment cargo runs with: colour on when the output ends up on a terminal and
/// the caller chose nothing, since capturing the output would otherwise turn it off.
pub(crate) fn child_env(mut env: Env, is_terminal: bool) -> Env {
    if is_terminal && !env.contains_key("CARGO_TERM_COLOR") {
        env.insert("CARGO_TERM_COLOR".to_owned(), "always".to_owned());
    }
    env
}

fn parse_command(argv: &[String]) -> Result<(&str, Vec<&str>), ScriptError> {
    let (program, rest) = argv
        .split_first()
        .map_or(("", &[][..]), |(program, rest)| (program.as_str(), rest));
    let cargo_args = rest
        .iter()
        .position(|arg| arg == "--")
        .map_or(rest, |separator| &rest[..separator]);
    if program != "cargo" || !cargo_args.iter().any(|arg| arg == "clippy") {
        return Err(ScriptError::new(
            "ERR_CLIPPY_USAGE",
            "the arguments are not a `cargo clippy` command",
            "cargo xtask clippy-guard cargo clippy <arguments…>",
            if argv.is_empty() {
                "no arguments".to_owned()
            } else {
                format!("`{}`", argv.join(" "))
            },
            "run `just lint`, or pass the whole `cargo clippy …` command after the task",
        ));
    }
    Ok((program, rest.iter().map(String::as_str).collect()))
}

pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    let (program, args) = parse_command(&context.argv)?;
    let command = format!("{program} {}", args.join(" "));
    let result = context.run(
        program,
        &args,
        &RunOptions {
            cwd: Some(context.root.clone()),
            env: Some(context.env.clone()),
            input: None,
        },
    );
    let (stdout, stderr) = (result.stdout_text(), result.stderr_text());
    // A process that never started has no output of its own: stderr holds why.
    if result.started {
        for stream in [&stdout, &stderr] {
            let text = stream.trim_end_matches('\n');
            if !text.is_empty() {
                context.log(text);
            }
        }
    }

    let found = config_diagnostics(&format!("{stdout}\n{stderr}"));
    let unresolved: Vec<&ConfigDiagnostic> = found
        .iter()
        .filter(|d| d.kind == Kind::Unresolved)
        .collect();
    let invalid: Vec<&ConfigDiagnostic> =
        found.iter().filter(|d| d.kind == Kind::Invalid).collect();
    if !unresolved.is_empty() {
        return Err(ScriptError::new(
            "ERR_CLIPPY_BAN_UNRESOLVED",
            format!(
                "clippy's configuration names what clippy cannot resolve, so {} a no-op",
                if unresolved.len() == 1 {
                    "that entry is"
                } else {
                    "those entries are"
                }
            ),
            "every `path` in a clippy.toml (core's bans in its crate's clippy.toml) to name an item clippy reaches on this target",
            listed(&unresolved, &context.root),
            "correct the path (a typo, or an item Rust renamed or moved) and rerun `just lint`; never add `allow-invalid = true`, and removing a ban is weakening a gate (AGENTS.md › Security and human approval)",
        ));
    }
    if !invalid.is_empty() {
        return Err(ScriptError::new(
            "ERR_CLIPPY_CONFIG_INVALID",
            "clippy reported a problem in a clippy.toml, so a setting there may not apply",
            "every key in a clippy.toml to be one this clippy knows and has not deprecated",
            listed(&invalid, &context.root),
            "change the clippy.toml key as the message says (a deprecated key names its replacement), keeping every ban and setting it held, then rerun `just lint`",
        ));
    }
    if !result.success() {
        let actual = if !result.started {
            format!(
                "cargo did not start: {}",
                stderr.trim().lines().next().unwrap_or_default()
            )
        } else if let Some(status) = result.status {
            format!("cargo exited {status}; its findings are printed above")
        } else {
            "cargo was stopped before it exited (a signal); its output is printed above".to_owned()
        };
        return Err(ScriptError::new(
            "ERR_CLIPPY_FAILED",
            "cargo clippy failed",
            format!("`{command}` to exit 0"),
            actual,
            "fix what clippy reports above (`just fix` applies the automatic fixes), then rerun `just lint`",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! The clippy outputs below are cargo's real stderr on the pinned toolchain (observed
    //! 2026-09-30, rustc 1.98.1), with the checkout's absolute path replaced by `ROOT` and
    //! the crates' names by `CORE` and `SUPPORT`: one run with `std::thread::park_timeout`
    //! in core's clippy.toml misspelled as `park_timeoutz`, one with a deprecated key
    //! added, and one with main's list.

    use std::cell::RefCell;
    use std::path::Path;

    use super::{
        ConfigDiagnostic, Kind, child_env, config_diagnostics, main, strip_control_sequences,
    };
    use crate::context::{Env, RunOptions, RunResult};
    use crate::fail::ScriptError;
    use crate::test_support::{Fake, Outcome, env_of};

    const ROOT: &str = "/work/repo";
    const LINT: [&str; 8] = [
        "cargo",
        "clippy",
        "--workspace",
        "--all-targets",
        "--locked",
        "--",
        "-D",
        "warnings",
    ];

    fn misspelled() -> String {
        format!(
            "    Checking app-core v0.1.0 ({ROOT}/crates/app-core)
warning: `std::thread::park_timeoutz` does not refer to a reachable function
  --> {ROOT}/crates/app-core/clippy.toml:32:3
   |
32 |   {{ path = \"std::thread::park_timeoutz\", reason = \"core never waits; the shell schedules\" }},
   |   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   |
   = help: add `allow-invalid = true` to the entry to suppress this warning

warning: `app-core` (lib) generated 1 warning
    Checking app-test-support v0.1.0 ({ROOT}/crates/app-test-support)
warning: `app-core` (test \"serialization\") generated 1 warning (1 duplicate)
warning: `app-core` (lib test) generated 1 warning (1 duplicate)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 12.18s
"
        )
    }

    fn main_list() -> String {
        format!(
            "    Checking app-core v0.1.0 ({ROOT}/crates/app-core)
    Checking app-test-support v0.1.0 ({ROOT}/crates/app-test-support)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.49s
"
        )
    }

    const LINT_FAILURE: &str = "    Checking app-core v0.1.0 (/work/repo/crates/app-core)
error: use of a disallowed method `std::thread::sleep`
  --> crates/app-core/src/lib.rs:10:5
   |
10 |     std::thread::sleep(duration);
   |     ^^^^^^^^^^^^^^^^^^
   |
   = note: core never waits; the shell schedules

error: could not compile `app-core` (lib) due to 1 previous error
";

    fn deprecated_key() -> String {
        format!(
            "warning: error reading Clippy's configuration file: deprecated field `blacklisted-names`. Please use `disallowed-names` instead
 --> {ROOT}/crates/app-core/clippy.toml:6:1
  |
6 | blacklisted-names = [\"foo\"]
  | ^^^^^^^^^^^^^^^^^

warning: `app-core` (lib) generated 1 warning
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.03s
"
        )
    }

    fn paint(text: &str) -> String {
        format!("\u{1b}[1m\u{1b}[33m{text}\u{1b}[0m")
    }

    struct Guarded {
        outcome: Outcome,
        calls: Vec<(String, Vec<String>, RunOptions)>,
    }

    impl Guarded {
        fn error(&self) -> Option<&ScriptError> {
            self.outcome.result.as_ref().err()
        }

        fn code(&self) -> Option<&str> {
            self.error().map(ScriptError::code)
        }

        fn actual(&self) -> Option<&str> {
            self.error().map(|error| error.details.actual.as_str())
        }
    }

    fn guard(argv: &[&str], result: &RunResult) -> Guarded {
        let calls = RefCell::new(Vec::new());
        let run = |command: &str, args: &[&str], options: &RunOptions| {
            calls.borrow_mut().push((
                command.to_owned(),
                args.iter().map(ToString::to_string).collect(),
                options.clone(),
            ));
            result.clone()
        };
        let outcome = Fake::at(Path::new(ROOT))
            .argv(argv)
            .env(env_of(&[("PATH", "/bin")]))
            .run(&run)
            .task(main);
        Guarded {
            outcome,
            calls: calls.into_inner(),
        }
    }

    fn stderr(status: i32, text: &str) -> RunResult {
        RunResult::exited(status, "", text)
    }

    #[test]
    fn fails_on_a_misspelled_path_even_though_clippy_exits_0() {
        let guarded = guard(&LINT, &stderr(0, &misspelled()));
        assert_eq!(guarded.code(), Some("ERR_CLIPPY_BAN_UNRESOLVED"));
        assert!(guarded.outcome.lines.join("\n").contains("park_timeoutz"));
    }

    #[test]
    fn passes_on_mains_list() {
        let guarded = guard(&LINT, &stderr(0, &main_list()));
        guarded.outcome.assert_ok();
        assert_eq!(
            guarded.outcome.lines,
            vec![main_list().trim_end().to_owned()]
        );
    }

    #[test]
    fn prints_stdout_then_stderr() {
        let guarded = guard(&LINT, &RunResult::exited(0, "out\n\n", "err\n"));
        assert_eq!(guarded.outcome.lines, vec!["out", "err"]);
    }

    #[test]
    fn runs_the_given_command_in_the_repository_root_with_the_callers_environment() {
        let guarded = guard(&LINT, &stderr(0, ""));
        let [(command, args, options)] = guarded.calls.as_slice() else {
            panic!("expected one call, got {:?}", guarded.calls);
        };
        assert_eq!(command, "cargo");
        assert_eq!(args, &LINT[1..]);
        assert_eq!(options.cwd.as_deref(), Some(Path::new(ROOT)));
        assert_eq!(options.env, Some(env_of(&[("PATH", "/bin")])));
    }

    #[test]
    fn reports_an_unresolved_path_before_clippys_own_failure() {
        let guarded = guard(
            &LINT,
            &stderr(101, &format!("{}{LINT_FAILURE}", misspelled())),
        );
        assert_eq!(guarded.code(), Some("ERR_CLIPPY_BAN_UNRESOLVED"));
    }

    #[test]
    fn fails_with_clippys_failure_when_its_configuration_is_sound() {
        let guarded = guard(&LINT, &stderr(101, LINT_FAILURE));
        assert_eq!(guarded.code(), Some("ERR_CLIPPY_FAILED"));
        assert_eq!(
            guarded.actual(),
            Some("cargo exited 101; its findings are printed above")
        );
    }

    #[test]
    fn fails_on_a_deprecated_key_which_clippy_only_warns_about_under_its_own_code() {
        let guarded = guard(&LINT, &stderr(0, &deprecated_key()));
        assert_eq!(guarded.code(), Some("ERR_CLIPPY_CONFIG_INVALID"));
        assert_eq!(
            guarded.actual(),
            Some(
                "error reading Clippy's configuration file: deprecated field `blacklisted-names`. Please use `disallowed-names` instead (crates/app-core/clippy.toml:6:1)"
            )
        );
    }

    #[test]
    fn reports_an_unresolved_path_before_an_invalid_key() {
        let guarded = guard(
            &LINT,
            &stderr(0, &format!("{}{}", deprecated_key(), misspelled())),
        );
        assert_eq!(guarded.code(), Some("ERR_CLIPPY_BAN_UNRESOLVED"));
        assert!(
            !guarded
                .actual()
                .unwrap_or_default()
                .contains("blacklisted-names")
        );
    }

    #[test]
    fn reports_a_cargo_that_never_started_once_on_one_line() {
        let never = RunResult {
            status: None,
            started: false,
            stdout: Vec::new(),
            stderr: b"cargo: No such file or directory (os error 2)".to_vec(),
        };
        let guarded = guard(&LINT, &never);
        assert_eq!(guarded.code(), Some("ERR_CLIPPY_FAILED"));
        assert_eq!(
            guarded.actual(),
            Some("cargo did not start: cargo: No such file or directory (os error 2)")
        );
        assert!(guarded.outcome.lines.is_empty());
    }

    #[test]
    fn reports_a_cargo_stopped_before_it_exited_without_repeating_its_output() {
        let stopped = RunResult {
            status: None,
            started: true,
            stdout: Vec::new(),
            stderr: LINT_FAILURE.as_bytes().to_vec(),
        };
        let guarded = guard(&LINT, &stopped);
        assert_eq!(guarded.code(), Some("ERR_CLIPPY_FAILED"));
        let actual = guarded.actual().unwrap_or_default();
        assert!(!actual.contains('\n'));
        assert!(!actual.contains("disallowed method"));
        assert_eq!(
            guarded.outcome.lines,
            vec![LINT_FAILURE.trim_end().to_owned()]
        );
    }

    #[test]
    fn refuses_what_is_not_a_cargo_clippy_command() {
        for argv in [
            &[][..],
            &["pnpm", "clippy"][..],
            &["cargo", "build", "--locked"][..],
            &["cargo", "test", "--", "clippy"][..],
        ] {
            let guarded = guard(argv, &stderr(0, ""));
            assert_eq!(guarded.code(), Some("ERR_CLIPPY_USAGE"), "{argv:?}");
            assert!(guarded.calls.is_empty());
        }
        assert_eq!(guard(&[], &stderr(0, "")).actual(), Some("no arguments"));
        assert_eq!(
            guard(&["pnpm", "clippy"], &stderr(0, "")).actual(),
            Some("`pnpm clippy`")
        );
    }

    #[test]
    fn finds_the_unresolved_path_once_at_its_clippy_toml_line() {
        assert_eq!(
            config_diagnostics(&misspelled()),
            vec![ConfigDiagnostic {
                kind: Kind::Unresolved,
                message: "`std::thread::park_timeoutz` does not refer to a reachable function"
                    .to_owned(),
                location: Some(format!("{ROOT}/crates/app-core/clippy.toml:32:3")),
            }]
        );
    }

    #[test]
    fn finds_it_in_colored_output() {
        let colored: Vec<String> = misspelled()
            .split('\n')
            .map(|line| {
                if line.starts_with("warning") {
                    paint(line)
                } else {
                    line.replace("  --> ", &paint("  --> "))
                }
            })
            .collect();
        assert_eq!(
            config_diagnostics(&colored.join("\n")),
            config_diagnostics(&misspelled())
        );
    }

    #[test]
    fn reports_a_diagnostic_repeated_across_crates_once() {
        assert_eq!(config_diagnostics(&misspelled().repeat(2)).len(), 1);
    }

    #[test]
    fn counts_any_other_diagnostic_whose_primary_location_is_a_clippy_toml_as_invalid() {
        let text =
            format!("warning: expected a function, found a struct\n  --> {ROOT}/.clippy.toml:4:3");
        assert_eq!(
            config_diagnostics(&text),
            vec![ConfigDiagnostic {
                kind: Kind::Invalid,
                message: "expected a function, found a struct".to_owned(),
                location: Some(format!("{ROOT}/.clippy.toml:4:3")),
            }]
        );
    }

    #[test]
    fn counts_an_unresolved_path_message_that_carries_no_location() {
        assert_eq!(
            config_diagnostics("warning: `std::fs::nope` does not refer to a reachable function\n"),
            vec![ConfigDiagnostic {
                kind: Kind::Unresolved,
                message: "`std::fs::nope` does not refer to a reachable function".to_owned(),
                location: None,
            }]
        );
    }

    #[test]
    fn reads_a_coded_header_and_ignores_malformed_ones() {
        let text = "error[E0001]: x does not refer to a reachable item\nwarning[]: y does not refer to a reachable item\nwarning: \nwarnings: z does not refer to a reachable item\n";
        assert_eq!(
            config_diagnostics(text),
            vec![ConfigDiagnostic {
                kind: Kind::Unresolved,
                message: "x does not refer to a reachable item".to_owned(),
                location: None,
            }]
        );
    }

    #[test]
    fn ignores_a_lint_in_source_code_and_cargos_summary_lines() {
        assert_eq!(config_diagnostics(LINT_FAILURE), vec![]);
        assert_eq!(config_diagnostics(&main_list()), vec![]);
        assert_eq!(
            config_diagnostics("warning: odd\n  --> clippy.toml:x:1\n  --> :1:1\n"),
            vec![]
        );
    }

    #[test]
    fn takes_only_the_primary_location_not_a_later_span_of_the_same_diagnostic() {
        let text = "warning: unused variable: `x`\n  --> crates/app-core/src/lib.rs:3:9\n  --> crates/app-core/clippy.toml:1:1";
        assert_eq!(config_diagnostics(text), vec![]);
    }

    #[test]
    fn strips_csi_osc_and_other_escapes() {
        let text =
            "a\u{1b}[1;31mb\u{9b}0mc\u{1b}]8;;http://x\u{7}d\u{1b}]0;t\u{1b}\\e\u{1b}Mf\u{1b}";
        assert_eq!(strip_control_sequences(text), "abcdef");
    }

    #[test]
    fn names_the_entry_relative_to_the_repository_root() {
        assert_eq!(
            guard(&LINT, &stderr(0, &misspelled())).actual(),
            Some(
                "`std::thread::park_timeoutz` does not refer to a reachable function (crates/app-core/clippy.toml:32:3)"
            )
        );
    }

    #[test]
    fn keeps_a_location_outside_the_repository_as_clippy_printed_it() {
        let text = "warning: `a::b` does not refer to a reachable type\n  --> /elsewhere/clippy.toml:2:3\n";
        assert_eq!(
            guard(&LINT, &stderr(0, text)).actual(),
            Some("`a::b` does not refer to a reachable type (/elsewhere/clippy.toml:2:3)")
        );
    }

    #[test]
    fn lists_every_unresolved_entry() {
        let second = misspelled()
            .replace("park_timeoutz", "sleepz")
            .replace(":32:3", ":31:3");
        let guarded = guard(&LINT, &stderr(0, &format!("{}{second}", misspelled())));
        assert_eq!(guarded.actual().unwrap_or_default().split("; ").count(), 2);
        assert!(
            guarded
                .error()
                .is_some_and(|error| error.details.summary.contains("those entries are"))
        );
    }

    #[test]
    fn asks_cargo_for_colour_only_when_the_output_reaches_a_terminal_and_nothing_is_chosen() {
        assert_eq!(
            child_env(env_of(&[("PATH", "/bin")]), true),
            env_of(&[("PATH", "/bin"), ("CARGO_TERM_COLOR", "always")])
        );
        assert_eq!(
            child_env(env_of(&[("CARGO_TERM_COLOR", "never")]), true),
            env_of(&[("CARGO_TERM_COLOR", "never")])
        );
        assert_eq!(
            child_env(env_of(&[("PATH", "/bin")]), false),
            env_of(&[("PATH", "/bin")])
        );
        assert_eq!(child_env(Env::new(), false), Env::new());
    }
}
