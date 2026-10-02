//! No `clippy.toml` sets `allow-invalid`. The key tells clippy to accept a
//! `disallowed-*` path it cannot resolve without a word, so `cargo xtask clippy-guard`
//! never sees the warning it turns into `ERR_CLIPPY_BAN_UNRESOLVED` and the ban silently
//! does nothing. Any value is refused, `false` included: it is the default, and a key that
//! only needs flipping to `true` is one edit from a no-op ban.
//!
//! Read: every `clippy.toml` and `.clippy.toml` under the root (clippy reads either, from a
//! crate's directory or one above it), skipping `.git`, `node_modules`, `target`, and any
//! directory holding its own `.git` (another checkout or worktree, such as
//! `.claude/worktrees/`). The key is found at any depth, spelled with a hyphen or an
//! underscore.
//!
//! An entry that genuinely needs the key (a ban on an item that exists on one target only)
//! is a human's decision, recorded in [`EXCEPTIONS`] with its reason; an exception whose
//! entry no longer carries the key fails as stale.
//!
//! Errors: `ERR_CHECK_CLIPPY_UNREADABLE` (a clippy.toml does not parse),
//! `ERR_CHECK_CLIPPY_ALLOW_INVALID` (a clippy.toml sets allow-invalid outside
//! [`EXCEPTIONS`]), `ERR_CHECK_CLIPPY_EXCEPTION_STALE` (an exception names an entry that
//! no longer sets it).

use std::collections::BTreeSet;
use std::path::Path;

use super::{Input, finding, first_line, list_dir, read_file};
use crate::fail::FailureDetails;

const THIS: &str = "xtask/src/check_harness/clippy_allow_invalid.rs";
const CONFIG_FILES: [&str; 2] = ["clippy.toml", ".clippy.toml"];
const SKIPPED_DIRS: [&str; 3] = [".git", "node_modules", "target"];

/// Entries allowed to carry `allow-invalid`, keyed `<clippy.toml path> <ban path>` (e.g.
/// `crates/<crate>/clippy.toml std::os::linux::fs::MetadataExt::st_dev`), each with its
/// reason. Adding one is weakening a gate (AGENTS.md › Security and human approval): it
/// needs a human's sign-off.
const EXCEPTIONS: [(&str, &str); 0] = [];

/// Every clippy configuration file under `root`, as sorted `/`-separated relative paths.
fn config_files(root: &Path, dir: &str) -> Vec<String> {
    let mut found = Vec::new();
    for (name, kind) in list_dir(root, dir) {
        let path = if dir.is_empty() {
            name.clone()
        } else {
            format!("{dir}/{name}")
        };
        if kind.is_file() && CONFIG_FILES.contains(&name.as_str()) {
            found.push(path);
        } else if kind.is_dir()
            && !SKIPPED_DIRS.contains(&name.as_str())
            && !root.join(&path).join(".git").exists()
        {
            found.extend(config_files(root, &path));
        }
    }
    found.sort();
    found
}

/// Where the key sits: its TOML location and, inside a ban entry, the entry's `path`.
struct Hit {
    location: String,
    ban: Option<String>,
}

fn find_key(value: &toml::Value, location: &str, hits: &mut Vec<Hit>) {
    let join = |key: &str| {
        if location.is_empty() {
            key.to_owned()
        } else {
            format!("{location}.{key}")
        }
    };
    match value {
        toml::Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                find_key(item, &format!("{location}[{index}]"), hits);
            }
        }
        toml::Value::Table(table) => {
            for (key, inner) in table {
                if key.replace('_', "-") == "allow-invalid" {
                    hits.push(Hit {
                        location: join(key),
                        ban: table
                            .get("path")
                            .and_then(toml::Value::as_str)
                            .map(str::to_owned),
                    });
                } else {
                    find_key(inner, &join(key), hits);
                }
            }
        }
        toml::Value::String(_)
        | toml::Value::Integer(_)
        | toml::Value::Float(_)
        | toml::Value::Boolean(_)
        | toml::Value::Datetime(_) => {}
    }
}

/// The check's violations under `root`, given the exception list.
fn scan(root: &Path, exceptions: &[(&str, &str)]) -> Vec<FailureDetails> {
    let mut violations = Vec::new();
    let mut used = BTreeSet::new();
    for file in config_files(root, "") {
        let text = read_file(root, &file).unwrap_or_default();
        let table = match text.parse::<toml::Table>() {
            Ok(table) => table,
            Err(error) => {
                violations.push(finding(
                    "ERR_CHECK_CLIPPY_UNREADABLE",
                    format!("{file} does not parse"),
                    format!("{file} to parse, so its keys can be checked for allow-invalid"),
                    first_line(&error.to_string()),
                    format!("fix {file}"),
                ));
                continue;
            }
        };
        let mut hits = Vec::new();
        find_key(&toml::Value::Table(table), "", &mut hits);
        for hit in hits {
            let key = hit.ban.as_ref().map(|ban| format!("{file} {ban}"));
            if let Some(key) = key.filter(|key| exceptions.iter().any(|(name, _)| name == key)) {
                used.insert(key);
                continue;
            }
            violations.push(finding(
                "ERR_CHECK_CLIPPY_ALLOW_INVALID",
                format!(
                    "{file} sets {}{}",
                    hit.location,
                    hit.ban
                        .as_ref()
                        .map(|ban| format!(" on the ban of {ban}"))
                        .unwrap_or_default()
                ),
                "no allow-invalid key in any clippy.toml: it hides the unresolved-path warning `cargo xtask clippy-guard` fails on, so the ban can silently do nothing",
                format!("{file}: {}", hit.location),
                format!("remove the key and correct the ban's path so `just lint` resolves it; an entry that genuinely needs the key goes in {THIS}'s EXCEPTIONS with a human's sign-off (AGENTS.md › Security and human approval)"),
            ));
        }
    }
    let mut keys: Vec<&str> = exceptions.iter().map(|(key, _)| *key).collect();
    keys.sort_unstable();
    for key in keys.into_iter().filter(|key| !used.contains(*key)) {
        violations.push(finding(
            "ERR_CHECK_CLIPPY_EXCEPTION_STALE",
            format!("the exception for {key} no longer applies"),
            format!("every EXCEPTIONS entry in {THIS} to name a ban that sets allow-invalid"),
            format!("no clippy.toml entry matches {key}"),
            format!("remove the entry from {THIS}'s EXCEPTIONS"),
        ));
    }
    violations
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    scan(input.root, &EXCEPTIONS)
}

#[cfg(test)]
mod tests {
    use super::{EXCEPTIONS, config_files, run, scan};
    use crate::check_harness::test_support::{codes, run_at, summaries};
    use crate::test_support::{temp_dir, write};

    const CORE: &str = "crates/core/clippy.toml";
    const ROOT_CONFIG: &str = "allow-unwrap-in-tests = true\nallow-expect-in-tests = true\n";

    fn core_config(extra: &str) -> String {
        format!(
            "allow-unwrap-in-tests = true\ndisallowed-methods = [\n  {{ path = \"std::time::SystemTime::now\", reason = \"inject time\" }},\n  {{ path = \"std::env::var\", reason = \"arguments\"{extra} }},\n]\n"
        )
    }

    fn fixture(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = temp_dir();
        for (path, content) in files {
            write(dir.path(), path, content);
        }
        dir
    }

    #[test]
    fn passes_without_the_key_or_any_clippy_toml() {
        let dir = fixture(&[("clippy.toml", ROOT_CONFIG), (CORE, &core_config(""))]);
        assert_eq!(run_at(dir.path(), run), []);
        let dir = fixture(&[("README.md", "# app\n")]);
        assert_eq!(run_at(dir.path(), run), []);
    }

    #[test]
    fn fails_on_a_ban_entry_with_the_key_naming_the_file_and_the_ban() {
        let dir = fixture(&[
            ("clippy.toml", ROOT_CONFIG),
            (CORE, &core_config(", allow-invalid = true")),
        ]);
        let violations = run_at(dir.path(), run);
        assert_eq!(codes(&violations), ["ERR_CHECK_CLIPPY_ALLOW_INVALID"]);
        assert_eq!(
            violations[0].summary,
            "crates/core/clippy.toml sets disallowed-methods[1].allow-invalid on the ban of std::env::var"
        );
        assert_eq!(
            violations[0].actual,
            "crates/core/clippy.toml: disallowed-methods[1].allow-invalid"
        );
        for extra in [", allow-invalid = false", ", allow_invalid = true"] {
            let dir = fixture(&[(CORE, &core_config(extra))]);
            assert_eq!(
                codes(&run_at(dir.path(), run)),
                ["ERR_CHECK_CLIPPY_ALLOW_INVALID"]
            );
        }
    }

    #[test]
    fn finds_the_key_in_a_dot_file_at_the_top_level_and_in_a_nested_table() {
        let dir = fixture(&[
            (".clippy.toml", "allow-invalid = true\n"),
            (
                "tools/clippy.toml",
                "[extra.deeper]\nallow-invalid = true\n",
            ),
            (
                "crates/cli/clippy.toml",
                "disallowed-types = [{ path = 1, allow-invalid = true }]\n",
            ),
        ]);
        assert_eq!(
            summaries(&run_at(dir.path(), run)),
            [
                ".clippy.toml sets allow-invalid",
                "crates/cli/clippy.toml sets disallowed-types[0].allow-invalid",
                "tools/clippy.toml sets extra.deeper.allow-invalid",
            ]
        );
    }

    #[test]
    fn fails_on_a_directory_it_cannot_list() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture(&[("clippy.toml", ROOT_CONFIG), (CORE, &core_config(""))]);
        let locked = dir.path().join("crates/core");
        let set = |mode| {
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(mode))
                .expect("chmod");
        };
        set(0o000);
        // Root lists a mode-000 directory, so the case holds only for an ordinary user.
        let listable = std::fs::read_dir(&locked).is_ok();
        let found = run_at(dir.path(), run);
        set(0o755);
        if !listable {
            assert_eq!(codes(&found), ["ERR_CHECK_INPUT_UNREADABLE"]);
            assert!(found[0].actual.contains("crates/core"), "{found:?}");
        }
    }

    #[test]
    fn skips_vcs_dependency_build_and_nested_checkout_directories() {
        let bad = "allow-invalid = true\n";
        let dir = fixture(&[
            ("clippy.toml", ROOT_CONFIG),
            (".git/clippy.toml", bad),
            ("node_modules/some-crate/clippy.toml", bad),
            ("target/package/clippy.toml", bad),
            (".claude/worktrees/issue-1/.git", "gitdir: /elsewhere\n"),
            (".claude/worktrees/issue-1/clippy.toml", bad),
        ]);
        assert_eq!(config_files(dir.path(), ""), ["clippy.toml"]);
        assert_eq!(run_at(dir.path(), run), []);
    }

    #[test]
    fn fails_on_a_clippy_toml_that_does_not_parse() {
        let dir = fixture(&[(CORE, "disallowed-methods = [\n")]);
        assert_eq!(
            codes(&run_at(dir.path(), run)),
            ["ERR_CHECK_CLIPPY_UNREADABLE"]
        );
    }

    #[test]
    fn lets_an_exception_through_and_reports_a_stale_one() {
        let exception = [("crates/core/clippy.toml std::env::var", "one target only")];
        let dir = fixture(&[(CORE, &core_config(", allow-invalid = true"))]);
        assert_eq!(scan(dir.path(), &exception), []);
        let dir = fixture(&[(CORE, &core_config(""))]);
        let stale = scan(dir.path(), &exception);
        assert_eq!(codes(&stale), ["ERR_CHECK_CLIPPY_EXCEPTION_STALE"]);
        assert_eq!(
            stale[0].summary,
            "the exception for crates/core/clippy.toml std::env::var no longer applies"
        );
        let dir = fixture(&[("clippy.toml", "allow-invalid = true\n")]);
        assert_eq!(
            codes(&scan(dir.path(), &exception[..0])),
            ["ERR_CHECK_CLIPPY_ALLOW_INVALID"]
        );
        assert!(EXCEPTIONS.is_empty());
    }
}
