//! workflow-hygiene and just-check-matches-ci against the fixture trees under
//! `xtask/tests/fixtures/workflows/`. `pass.yml` is a manifest of files (a justfile,
//! ci.yml, and a composite action) that both checks pass; each `fail/<mode>.yml` names one
//! way a workflow or the justfile stops failing closed, as `edits` (a `from` that must
//! occur in the pass file, replaced by `to`) and whole `files`, with the codes each check
//! must report. The test writes the tree to a temp root and runs workflow-hygiene through
//! `cargo xtask check-harness --root <tree> --check workflow-hygiene`, so a fixture that
//! trips no tool in the checkout (no committed workflow, action.yml, or justfile) still
//! proves the check against real files.

use std::collections::BTreeMap;
use std::path::Path;

use super::just_check_matches_ci::tests::compare_without_exceptions;
use super::main;
use super::test_support::codes;
use super::yaml::{self, Keys, Node};
use crate::test_support::{Fake, temp_dir, write};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/workflows");

struct Fixture {
    name: String,
    files: BTreeMap<String, String>,
    hygiene: Vec<String>,
    just_ci: Vec<String>,
}

fn manifest(path: &Path) -> Node {
    let text = std::fs::read_to_string(path).expect("a fixture manifest");
    yaml::parse(&text, Keys::Unique).expect("YAML").root
}

fn string_map(node: Option<&Node>, place: &str) -> BTreeMap<String, String> {
    node.map(|node| {
        assert!(node.is_map(), "{place} is not a mapping");
        node.pairs()
            .map(|(key, text)| {
                let text = text
                    .as_str()
                    .unwrap_or_else(|| panic!("{place}.{key} is not a string"));
                (key, text.to_owned())
            })
            .collect()
    })
    .unwrap_or_default()
}

fn code_list(node: Option<&Node>, place: &str) -> Vec<String> {
    let node = node.unwrap_or_else(|| panic!("{place} is missing"));
    assert!(node.is_seq(), "{place} is not a list of codes");
    node.items()
        .iter()
        .map(|code| {
            code.as_str()
                .unwrap_or_else(|| panic!("{place} holds a non-string"))
                .to_owned()
        })
        .collect()
}

fn pass_files() -> BTreeMap<String, String> {
    string_map(
        manifest(&Path::new(FIXTURES).join("pass.yml")).get("files"),
        "pass.files",
    )
}

fn failures() -> Vec<Fixture> {
    let mut names: Vec<String> = std::fs::read_dir(Path::new(FIXTURES).join("fail"))
        .expect("the fail fixtures")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| super::has_extension(name, &["yml"]))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let data = manifest(&Path::new(FIXTURES).join("fail").join(&name));
            let mut files = pass_files();
            for edit in data.get("edits").map(Node::items).unwrap_or_default() {
                let field = |key: &str| {
                    edit.get(key).and_then(Node::as_str).unwrap_or_else(|| {
                        panic!("{name}: an edit needs string file, from, and to")
                    })
                };
                let (file, from, to) = (field("file"), field("from"), field("to"));
                let before = files.get(file).filter(|text| text.contains(from));
                let before = before.unwrap_or_else(|| panic!("{name}: {file} has no {from:?}"));
                let after = before.replacen(from, to, 1);
                files.insert(file.to_owned(), after);
            }
            files.extend(string_map(data.get("files"), &format!("{name}.files")));
            let expected = data
                .get("expect")
                .unwrap_or_else(|| panic!("{name}: no expect mapping"));
            Fixture {
                hygiene: code_list(
                    expected.get("workflow-hygiene"),
                    &format!("{name}.expect.workflow-hygiene"),
                ),
                just_ci: code_list(
                    expected.get("just-check-matches-ci"),
                    &format!("{name}.expect.just-check-matches-ci"),
                ),
                name,
                files,
            }
        })
        .collect()
}

fn tree(files: &BTreeMap<String, String>) -> tempfile::TempDir {
    let dir = temp_dir();
    for (path, content) in files {
        write(dir.path(), path, content);
    }
    dir
}

/// workflow-hygiene's codes over `root`, run through the task with `--root` from
/// elsewhere.
fn hygiene_codes(root: &Path) -> Vec<String> {
    let elsewhere = temp_dir();
    let root = root.to_string_lossy().into_owned();
    let argv = ["--root", root.as_str(), "--check", "workflow-hygiene"];
    let outcome = Fake::at(elsewhere.path()).argv(&argv).task(main);
    if outcome.result.is_ok() {
        assert_eq!(
            outcome.lines,
            ["ok    workflow-hygiene", "check-harness: 1 checks passed"]
        );
        return Vec::new();
    }
    let found: Vec<String> = outcome
        .lines
        .iter()
        .filter_map(|line| line.split_once(':').map(|(code, _)| code))
        .filter(|code| code.starts_with("ERR_CHECK_"))
        .map(str::to_owned)
        .collect();
    assert_eq!(outcome.code(), "ERR_HARNESS_FAILED");
    found
}

#[test]
fn passes_the_pass_tree_in_both_checks() {
    let dir = tree(&pass_files());
    assert_eq!(hygiene_codes(dir.path()), Vec::<String>::new());
    assert_eq!(compare_without_exceptions(dir.path()), []);
}

#[test]
fn has_a_fixture_for_every_failure_mode_and_each_is_reported() {
    let failures = failures();
    assert!(failures.len() >= 20, "only {} fixtures", failures.len());
    for fixture in failures {
        let dir = tree(&fixture.files);
        let mut hygiene = hygiene_codes(dir.path());
        hygiene.sort();
        let mut expected = fixture.hygiene.clone();
        expected.sort();
        assert_eq!(
            hygiene, expected,
            "fail/{} in workflow-hygiene",
            fixture.name
        );
        assert_eq!(
            codes(&compare_without_exceptions(dir.path())),
            fixture.just_ci,
            "fail/{} in just-check-matches-ci",
            fixture.name
        );
    }
}
