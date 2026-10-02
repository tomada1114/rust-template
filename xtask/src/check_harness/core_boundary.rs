//! The core boundary holds, and its three lists agree:
//!
//! 1. `myapp-core`'s dependency closure over normal and build edges (no dev-dependency,
//!    across every target, from `cargo metadata`'s resolved graph) contains none of
//!    [`FORBIDDEN_IN_CORE`]. A build edge counts because a `[build-dependencies]` crate
//!    compiles and runs on every build of core, so `objc2` there ties
//!    core to the platform as surely as a normal edge. The walk stops at the first
//!    forbidden crate on a path, so each violation names the crate to remove and how core
//!    reaches it, marking a build edge `-(build)->`.
//! 2. `myapp-test-support` is never a normal, optional, or build-dependency of a workspace
//!    crate: test-only code never ships.
//! 3. The crates AGENTS.md's boundary sentence names ("… normal and build dependency
//!    closure reaches `a`, `b`, or `c`.") equal [`FORBIDDEN_IN_CORE`], and `deny.toml`'s
//!    `[bans] deny` wrapper entries are the boundary's: `myapp-platform` → `myapp` (the
//!    binary) only.
//!
//! The graph comes from `cargo metadata --format-version 1 --locked --offline` run in the
//! root. It needs cargo and the registry cache (`cargo fetch --locked`) but no build and
//! no macOS, so it works on a Linux runner. When it fails the check reports a violation;
//! it never skips.
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` (AGENTS.md or deny.toml absent),
//! `ERR_CHECK_CORE_BOUNDARY_METADATA` (cargo metadata failed or is not the expected
//! shape), `ERR_CHECK_CORE_BOUNDARY_CLOSURE`, `ERR_CHECK_TEST_SUPPORT_NOT_DEV`,
//! `ERR_CHECK_CORE_BOUNDARY_UNPARSED` (a list could not be read),
//! `ERR_CHECK_CORE_BOUNDARY_DIVERGED` (AGENTS.md's list differs),
//! `ERR_CHECK_CORE_BOUNDARY_WRAPPERS` (a deny.toml wrapper entry differs from the
//! boundary).

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use serde_json::Value;

use super::{Input, finding, first_line, pattern, read_file};
use crate::context::RunOptions;
use crate::fail::FailureDetails;

/// What core's normal and build dependency closure must never contain; `x*` is a prefix.
const FORBIDDEN_IN_CORE: [&str; 4] = [
    "objc2*",
    "core-foundation*",
    "security-framework*",
    "myapp-platform",
];

const CORE: &str = "myapp-core";
const TEST_SUPPORT: &str = "myapp-test-support";
/// The boundary's direct-edge rule: the only crates that may depend on each of these
/// directly.
const WRAPPERS: [(&str, &[&str]); 1] = [("myapp-platform", &["myapp"])];
const METADATA_ARGS: [&str; 5] = ["metadata", "--format-version", "1", "--locked", "--offline"];
const THIS: &str = "xtask/src/check_harness/core_boundary.rs";

struct CargoDependency {
    name: String,
    /// `None` for a normal dependency, else `dev` or `build`.
    kind: Option<String>,
    optional: bool,
}

struct CargoPackage {
    id: String,
    name: String,
    dependencies: Vec<CargoDependency>,
}

struct ResolvedDep {
    pkg: String,
    kinds: Vec<Option<String>>,
}

/// The parts of `cargo metadata --format-version 1` the check reads.
struct CargoMetadata {
    packages: Vec<CargoPackage>,
    workspace_members: Vec<String>,
    /// `None` under `--no-deps`: id → its resolved dependencies.
    nodes: Option<Vec<(String, Vec<ResolvedDep>)>>,
}

fn metadata_command() -> String {
    format!("cargo {}", METADATA_ARGS.join(" "))
}

fn metadata_violation(actual: impl Into<String>) -> FailureDetails {
    finding(
        "ERR_CHECK_CORE_BOUNDARY_METADATA",
        "cargo metadata could not give myapp-core's dependency graph",
        format!(
            "`{}` to print the workspace's resolved graph, with myapp-core a member",
            metadata_command()
        ),
        actual,
        "run `cargo fetch --locked` (the check reads the registry cache offline), then the command above to see cargo's error",
    )
}

/// A dependency kind: `null` is a normal edge (`Ok(None)`); anything but a string or null
/// is no kind (`Err`).
fn kind_of(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(Value::String(kind)) => Ok(Some(kind.clone())),
        _ => Err(()),
    }
}

fn to_dependency(value: &Value) -> Option<CargoDependency> {
    Some(CargoDependency {
        name: value.get("name")?.as_str()?.to_owned(),
        kind: kind_of(value.get("kind")).ok()?,
        optional: value.get("optional") == Some(&Value::Bool(true)),
    })
}

fn to_package(value: &Value) -> Option<CargoPackage> {
    Some(CargoPackage {
        id: value.get("id")?.as_str()?.to_owned(),
        name: value.get("name")?.as_str()?.to_owned(),
        dependencies: value
            .get("dependencies")?
            .as_array()?
            .iter()
            .map(to_dependency)
            .collect::<Option<_>>()?,
    })
}

fn to_node(value: &Value) -> Option<(String, Vec<ResolvedDep>)> {
    let id = value.get("id")?.as_str()?.to_owned();
    let deps = value
        .get("deps")?
        .as_array()?
        .iter()
        .map(|dep| {
            Some(ResolvedDep {
                pkg: dep.get("pkg")?.as_str()?.to_owned(),
                kinds: dep
                    .get("dep_kinds")?
                    .as_array()?
                    .iter()
                    .map(|kind| kind_of(kind.get("kind")))
                    .collect::<Result<_, ()>>()
                    .ok()?,
            })
        })
        .collect::<Option<_>>()?;
    Some((id, deps))
}

/// Read `cargo metadata`'s JSON; `source` names where it came from in a violation.
fn parse_cargo_metadata(text: &str, source: &str) -> Result<CargoMetadata, FailureDetails> {
    let json: Value = serde_json::from_str(text)
        .map_err(|_| metadata_violation(format!("{source} printed text that is not JSON")))?;
    let shape = || {
        metadata_violation(format!(
            "{source} is not `cargo metadata --format-version 1` output"
        ))
    };
    let packages = json
        .get("packages")
        .and_then(Value::as_array)
        .ok_or_else(shape)?
        .iter()
        .map(to_package)
        .collect::<Option<Vec<_>>>();
    let members = json
        .get("workspace_members")
        .and_then(Value::as_array)
        .and_then(|members| {
            members
                .iter()
                .map(|member| member.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        });
    let (Some(packages), Some(workspace_members)) = (packages, members) else {
        return Err(shape());
    };
    let nodes = match json.get("resolve") {
        Some(resolve @ Value::Object(_)) => Some(
            resolve
                .get("nodes")
                .and_then(Value::as_array)
                .ok_or_else(shape)?
                .iter()
                .map(to_node)
                .collect::<Option<Vec<_>>>()
                .ok_or_else(shape)?,
        ),
        _ => None,
    };
    Ok(CargoMetadata {
        packages,
        workspace_members,
        nodes,
    })
}

/// Run `cargo metadata` in the root; a failure is a violation, never a skip.
fn load_cargo_metadata(input: &Input<'_>) -> Result<CargoMetadata, FailureDetails> {
    let options = RunOptions {
        cwd: Some(input.root.to_path_buf()),
        ..RunOptions::default()
    };
    let result = (input.run)("cargo", &METADATA_ARGS, &options);
    if !result.success() {
        let stderr = result.stderr_text();
        let detail = first_line(stderr.trim());
        let status = result.status.map_or_else(
            || "none (did not start)".to_owned(),
            |status| status.to_string(),
        );
        let detail = if detail.is_empty() {
            "no error output"
        } else {
            detail
        };
        return Err(metadata_violation(format!("exit {status}: {detail}")));
    }
    parse_cargo_metadata(&result.stdout_text(), &metadata_command())
}

/// Whether `name` matches a list entry: exact, or a prefix for `x*`.
fn matches_forbidden(name: &str, pattern: &str) -> bool {
    pattern
        .strip_suffix('*')
        .map_or(name == pattern, |prefix| name.starts_with(prefix))
}

fn closure_violations(metadata: &CargoMetadata) -> Vec<FailureDetails> {
    let by_id: HashMap<&str, &CargoPackage> = metadata
        .packages
        .iter()
        .map(|package| (package.id.as_str(), package))
        .collect();
    let Some(core) = metadata.workspace_members.iter().find(|id| {
        by_id
            .get(id.as_str())
            .is_some_and(|package| package.name == CORE)
    }) else {
        return vec![metadata_violation(format!(
            "no workspace member named {CORE}"
        ))];
    };
    let Some(nodes) = &metadata.nodes else {
        return vec![metadata_violation(
            "no resolved dependency graph (was --no-deps passed?)",
        )];
    };
    let nodes: HashMap<&str, &[ResolvedDep]> = nodes
        .iter()
        .map(|(id, deps)| (id.as_str(), deps.as_slice()))
        .collect();
    let name_of = |id: &str| {
        by_id
            .get(id)
            .map_or_else(|| id.to_owned(), |package| package.name.clone())
    };
    let mut parent: HashMap<&str, &str> = HashMap::new();
    let mut seen: HashSet<&str> = HashSet::from([core.as_str()]);
    let mut via_build: HashSet<&str> = HashSet::new();
    let mut queue = VecDeque::from([core.as_str()]);
    let mut violations = Vec::new();
    while let Some(id) = queue.pop_front() {
        for dep in nodes.get(id).copied().unwrap_or_default() {
            let normal = dep.kinds.contains(&None);
            let build = dep
                .kinds
                .iter()
                .any(|kind| kind.as_deref() == Some("build"));
            if seen.contains(dep.pkg.as_str()) || (!normal && !build) {
                continue;
            }
            seen.insert(&dep.pkg);
            parent.insert(&dep.pkg, id);
            if !normal {
                via_build.insert(&dep.pkg);
            }
            let name = name_of(&dep.pkg);
            let Some(pattern) = FORBIDDEN_IN_CORE
                .iter()
                .find(|pattern| matches_forbidden(&name, pattern))
            else {
                queue.push_back(&dep.pkg);
                continue;
            };
            let mut path = name.clone();
            let mut at = dep.pkg.as_str();
            while let Some(from) = parent.get(at) {
                let arrow = if via_build.contains(at) {
                    "-(build)->"
                } else {
                    "->"
                };
                path = format!("{} {arrow} {path}", name_of(from));
                at = from;
            }
            let forbidden: Vec<String> =
                FORBIDDEN_IN_CORE.iter().map(|p| format!("`{p}`")).collect();
            violations.push(finding(
                "ERR_CHECK_CORE_BOUNDARY_CLOSURE",
                format!("{CORE}'s dependency closure reaches {name} (forbidden as `{pattern}`)"),
                format!("no {} among {CORE}'s normal or build dependencies, direct or transitive", forbidden.join(", ")),
                format!("dependency path: {path}"),
                format!("remove the edge that brings {name} into core (crates/{CORE}/Cargo.toml's [dependencies] or [build-dependencies], or a dependency's features); OS code belongs in myapp-platform behind a port"),
            ));
        }
    }
    violations
}

fn test_support_violations(metadata: &CargoMetadata) -> Vec<FailureDetails> {
    metadata
        .packages
        .iter()
        .filter(|package| metadata.workspace_members.contains(&package.id))
        .flat_map(|package| {
            package
                .dependencies
                .iter()
                .filter(|dep| dep.name == TEST_SUPPORT && dep.kind.as_deref() != Some("dev"))
                .map(|dep| {
                    let edge = format!(
                        "{}{} dependency",
                        if dep.optional { "an optional " } else { "a " },
                        dep.kind.as_deref().unwrap_or("normal")
                    );
                    finding(
                        "ERR_CHECK_TEST_SUPPORT_NOT_DEV",
                        format!("{} takes {TEST_SUPPORT} as {edge}", package.name),
                        format!("{TEST_SUPPORT} only under [dev-dependencies] (test-only code never ships)"),
                        format!("{}'s Cargo.toml declares {TEST_SUPPORT} as {edge}", package.name),
                        format!("move {TEST_SUPPORT} to {}'s [dev-dependencies]; a fake the shipped code needs is a real adapter in myapp-platform instead", package.name),
                    )
                })
        })
        .collect()
}

fn input_missing(path: &str, why: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_INPUT_MISSING",
        format!("{path} does not exist"),
        format!("{path} at the root ({why})"),
        "no such file",
        format!("restore {path} from version control"),
    )
}

fn unparsed(summary: &str, expected: &str, actual: impl Into<String>) -> FailureDetails {
    finding(
        "ERR_CHECK_CORE_BOUNDARY_UNPARSED",
        summary,
        expected,
        actual,
        format!(
            "restore the list in the shape Expected names, or update {THIS}'s parser in the same change"
        ),
    )
}

fn backticked(names: &[&str]) -> String {
    names
        .iter()
        .map(|name| format!("`{name}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// AGENTS.md's forbidden list: the backticked names in "… closure reaches `a`, … `z`."
fn agents_violations(input: &Input<'_>) -> Vec<FailureDetails> {
    let Some(text) = read_file(input.root, "AGENTS.md") else {
        return vec![input_missing(
            "AGENTS.md",
            "its boundary sentence lists core's forbidden crates",
        )];
    };
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let (sentence, name) = match (
        pattern(r"normal and build dependency\s+closure\s+reaches\s+([^.]*)\."),
        pattern(r"`([^`]+)`"),
    ) {
        (Ok(sentence), Ok(name)) => (sentence, name),
        (Err(invalid), _) | (_, Err(invalid)) => return vec![invalid],
    };
    let list = sentence
        .captures(&flat)
        .and_then(|captures| captures.get(1))
        .map_or("", |list| list.as_str());
    let listed: Vec<&str> = name
        .captures_iter(list)
        .filter_map(|captures| captures.get(1).map(|name| name.as_str()))
        .collect();
    if listed.is_empty() {
        return vec![unparsed(
            "AGENTS.md's forbidden-crate list could not be read",
            "a sentence in AGENTS.md › Architecture: \"… normal and build dependency closure reaches `objc2*`, … or `myapp-platform`.\"",
            "no such sentence, or one naming no backticked crate",
        )];
    }
    let diverged = |name: &str, place: &str| {
        finding(
            "ERR_CHECK_CORE_BOUNDARY_DIVERGED",
            format!("`{name}` is {place}"),
            format!("AGENTS.md › Architecture's closure list to equal FORBIDDEN_IN_CORE in {THIS}"),
            format!(
                "AGENTS.md: {}; the check: {}",
                backticked(&listed),
                backticked(&FORBIDDEN_IN_CORE)
            ),
            "change both lists in the same commit (adding strengthens the gate; removing one weakens it and needs a human's sign-off, AGENTS.md › Security and human approval)",
        )
    };
    let mut unique: Vec<&str> = Vec::new();
    for name in &listed {
        if !unique.contains(name) {
            unique.push(name);
        }
    }
    let mut violations: Vec<FailureDetails> = unique
        .iter()
        .filter(|name| !FORBIDDEN_IN_CORE.contains(name))
        .map(|name| {
            diverged(
                name,
                "in AGENTS.md's boundary list but not forbidden by the closure check",
            )
        })
        .collect();
    violations.extend(
        FORBIDDEN_IN_CORE
            .iter()
            .filter(|name| !listed.contains(name))
            .map(|name| {
                diverged(
                    name,
                    "forbidden by the closure check but missing from AGENTS.md's boundary list",
                )
            }),
    );
    violations
}

/// deny.toml's `[bans] deny` entries, as crate name → wrappers (`None`: none), or why it
/// cannot be read.
fn deny_entries(text: &str) -> Result<BTreeMap<String, Option<Vec<String>>>, String> {
    let table = text.parse::<toml::Table>().map_err(|error| {
        format!(
            "deny.toml is not valid TOML: {}",
            first_line(&error.to_string())
        )
    })?;
    let Some(toml::Value::Array(deny)) = table.get("bans").and_then(|bans| bans.get("deny")) else {
        return Err("deny.toml has no [bans] deny array".to_owned());
    };
    let mut entries = BTreeMap::new();
    for entry in deny {
        let spec = match entry {
            toml::Value::String(spec) => Some(spec.as_str()),
            toml::Value::Table(table) => table
                .get("crate")
                .or_else(|| table.get("name"))
                .and_then(toml::Value::as_str),
            _ => None,
        };
        let Some(spec) = spec else {
            continue;
        };
        let name = spec.split(['@', ':']).next().unwrap_or(spec).to_owned();
        let wrappers = entry
            .get("wrappers")
            .and_then(toml::Value::as_array)
            .and_then(|wrappers| {
                wrappers
                    .iter()
                    .map(|wrapper| wrapper.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            });
        entries.insert(name, wrappers);
    }
    Ok(entries)
}

fn quoted(names: &[String]) -> String {
    names
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

fn wrapper_violations(input: &Input<'_>) -> Vec<FailureDetails> {
    let Some(text) = read_file(input.root, "deny.toml") else {
        return vec![input_missing(
            "deny.toml",
            "its [bans] wrappers are core's direct-edge rule",
        )];
    };
    let entries = match deny_entries(&text) {
        Ok(entries) => entries,
        Err(problem) => {
            return vec![unparsed(
                "deny.toml's [bans] deny list could not be read",
                "a [bans] table with a `deny = [ { crate = \"…\", wrappers = [\"…\"] }, … ]` array",
                problem,
            )];
        }
    };
    let mut violations = Vec::new();
    for (krate, wrappers) in WRAPPERS {
        let mut want: Vec<String> = wrappers
            .iter()
            .map(|wrapper| (*wrapper).to_owned())
            .collect();
        want.sort();
        let found = entries.get(krate);
        let have = found.and_then(Option::as_ref).map(|have| {
            let mut have = have.clone();
            have.sort();
            have
        });
        if have.as_ref() == Some(&want) {
            continue;
        }
        let actual = match found {
            None => format!("no entry for {krate}"),
            Some(None) => "wrappers = [] (no wrappers: the crate is banned outright)".to_owned(),
            Some(Some(_)) => format!("wrappers = [{}]", quoted(&have.unwrap_or_default())),
        };
        violations.push(finding(
            "ERR_CHECK_CORE_BOUNDARY_WRAPPERS",
            format!("deny.toml's [bans] entry for {krate} does not match the core boundary"),
            format!("{{ crate = \"{krate}\", wrappers = [{}] }} in [bans] deny", quoted(&want)),
            actual,
            format!("set the entry to Expected; letting another crate depend on {krate} directly weakens the boundary and needs a human's sign-off (AGENTS.md › Security and human approval)"),
        ));
    }
    violations
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let mut violations = match load_cargo_metadata(input) {
        Ok(metadata) => {
            let mut found = closure_violations(&metadata);
            found.extend(test_support_violations(&metadata));
            found
        }
        Err(violation) => vec![violation],
    };
    violations.extend(agents_violations(input));
    violations.extend(wrapper_violations(input));
    violations
}

#[cfg(test)]
mod tests {
    //! core-boundary against a fixture tree: `xtask/tests/fixtures/core-boundary/pass` holds
    //! a minimal `cargo metadata` document (`metadata.json`) and deny.toml's wrapper
    //! entries, and each test root adds AGENTS.md's boundary sentence (below; written at
    //! run time so no agent ever loads a fixture AGENTS.md as instructions). All three
    //! agree. Each failing case copies it to a temp root and breaks one thing; a fake
    //! `cargo` prints the root's `metadata.json`.

    use std::cell::RefCell;
    use std::path::Path;

    use serde_json::{Value, json};

    use super::{FORBIDDEN_IN_CORE, METADATA_ARGS, parse_cargo_metadata, run};
    use crate::check_harness::Input;
    use crate::check_harness::test_support::codes;
    use crate::context::{Env, RunOptions, RunResult};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const PASS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/core-boundary/pass"
    );
    const REG: &str = "registry+https://github.com/rust-lang/crates.io-index";
    const AGENTS_MD: &str = "## Architecture\n\n- The core boundary is enforced three times, so removing one layer leaves the others:\n  core's `Cargo.toml` lists no OS or platform crate; `deny.toml`'s `[bans]`\n  `wrappers` let only `myapp` depend on `myapp-platform`; and a harness check fails when core's\n  normal and build dependency closure reaches `objc2*`, `core-foundation*`,\n  `security-framework*`, or `myapp-platform`. Those lists change together.";

    fn copy_pass() -> tempfile::TempDir {
        let dir = temp_dir();
        for name in ["deny.toml", "metadata.json"] {
            let text = std::fs::read_to_string(Path::new(PASS).join(name)).expect("fixture");
            write(dir.path(), name, text);
        }
        write(dir.path(), "AGENTS.md", AGENTS_MD);
        dir
    }

    /// A `cargo` that prints the root's metadata.json.
    fn fixture_cargo(command: &str, args: &[&str], options: &RunOptions) -> RunResult {
        assert_eq!((command, args), ("cargo", &METADATA_ARGS[..]));
        let cwd = options.cwd.as_ref().expect("cwd");
        let json = std::fs::read_to_string(cwd.join("metadata.json")).expect("metadata.json");
        RunResult::exited(0, &json, "")
    }

    fn check_with(
        root: &Path,
        run_cargo: &dyn Fn(&str, &[&str], &RunOptions) -> RunResult,
    ) -> Vec<FailureDetails> {
        let env = Env::new();
        run(&Input {
            root,
            run: run_cargo,
            env: &env,
        })
    }

    fn check(root: &Path) -> Vec<FailureDetails> {
        check_with(root, &fixture_cargo)
    }

    fn text(violations: &[FailureDetails]) -> String {
        violations
            .iter()
            .map(|found| {
                [
                    found.summary.as_str(),
                    &found.expected,
                    &found.actual,
                    &found.next,
                ]
                .join("\n")
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn edit_metadata(root: &Path, edit: impl FnOnce(&mut Value)) {
        let path = root.join("metadata.json");
        let mut metadata: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        edit(&mut metadata);
        std::fs::write(path, metadata.to_string()).expect("write");
    }

    fn id_of(metadata: &Value, name: &str) -> String {
        metadata["packages"]
            .as_array()
            .expect("packages")
            .iter()
            .find(|package| package["name"] == name)
            .and_then(|package| package["id"].as_str())
            .expect("package")
            .to_owned()
    }

    /// Add a registry package (when new) and an edge `from -> to` of `kind`.
    fn add_edge(metadata: &mut Value, from: &str, to: &str, kind: Option<&str>, optional: bool) {
        let known = metadata["packages"]
            .as_array()
            .expect("packages")
            .iter()
            .any(|package| package["name"] == to);
        if !known {
            let id = format!("{REG}#{to}@1.0.0");
            metadata["packages"]
                .as_array_mut()
                .expect("packages")
                .push(json!({"name": to, "id": id, "dependencies": []}));
            if let Some(nodes) = metadata["resolve"]["nodes"].as_array_mut() {
                nodes.push(json!({"id": id, "deps": []}));
            }
        }
        let from_id = id_of(metadata, from);
        let to_id = id_of(metadata, to);
        for package in metadata["packages"].as_array_mut().expect("packages") {
            if package["id"] == from_id.as_str() {
                package["dependencies"]
                    .as_array_mut()
                    .expect("dependencies")
                    .push(json!({"name": to, "kind": kind, "optional": optional}));
            }
        }
        if optional {
            return;
        }
        if let Some(nodes) = metadata["resolve"]["nodes"].as_array_mut() {
            for node in nodes {
                if node["id"] == from_id.as_str() {
                    node["deps"]
                        .as_array_mut()
                        .expect("deps")
                        .push(json!({"pkg": to_id, "dep_kinds": [{"kind": kind}]}));
                }
            }
        }
    }

    fn edit_file(root: &Path, path: &str, from: &str, to: &str) {
        let full = root.join(path);
        let before = std::fs::read_to_string(&full).expect("read");
        assert!(before.contains(from), "{path} has no {from}");
        std::fs::write(full, before.replacen(from, to, 1)).expect("write");
    }

    #[test]
    fn passes_on_the_fixture_where_every_list_agrees() {
        assert_eq!(check(copy_pass().path()), []);
        // Both sides sorted: the bootstrap renames the platform crate, which moves its
        // place in a hand-sorted list.
        let mut actual = FORBIDDEN_IN_CORE.to_vec();
        actual.sort_unstable();
        let mut expected = vec![
            "core-foundation*",
            "myapp-platform",
            "objc2*",
            "security-framework*",
        ];
        expected.sort_unstable();
        assert_eq!(actual, expected);
    }

    #[test]
    fn allows_dependencies_outside_the_os_boundary() {
        for (from, kind) in [
            ("myapp-core", None),
            ("serde", None),
            ("myapp-core", Some("build")),
        ] {
            let dir = copy_pass();
            edit_metadata(dir.path(), |m| add_edge(m, from, "renderer", kind, false));
            assert_eq!(check(dir.path()), []);
        }
    }

    #[test]
    fn fails_when_the_closure_reaches_a_forbidden_crate() {
        for krate in [
            "objc2-foundation",
            "core-foundation-sys",
            "security-framework",
            "myapp-platform",
        ] {
            let dir = copy_pass();
            edit_metadata(dir.path(), |m| {
                add_edge(m, "myapp-core", "bridge", None, false);
                add_edge(m, "bridge", krate, None, false);
            });
            let found = check(dir.path());
            assert_eq!(
                codes(&found),
                ["ERR_CHECK_CORE_BOUNDARY_CLOSURE"],
                "{krate}"
            );
            assert!(text(&found).contains(&format!("myapp-core -> bridge -> {krate}")));
        }
        let dir = copy_pass();
        edit_metadata(dir.path(), |m| {
            add_edge(m, "myapp-core", "objc2", None, false);
            add_edge(m, "myapp-core", "security-framework", None, false);
        });
        let found = check(dir.path());
        assert_eq!(codes(&found), ["ERR_CHECK_CORE_BOUNDARY_CLOSURE"; 2]);
        assert!(text(&found).contains("myapp-core -> security-framework"));
    }

    #[test]
    fn follows_normal_and_build_edges_but_no_dev_edge() {
        for (from, to) in [("myapp-core", "objc2"), ("serde", "objc2")] {
            let dir = copy_pass();
            edit_metadata(dir.path(), |m| add_edge(m, from, to, Some("dev"), false));
            assert_eq!(check(dir.path()), []);
        }
        for krate in ["objc2", "security-framework", "myapp-platform"] {
            let dir = copy_pass();
            edit_metadata(dir.path(), |m| {
                add_edge(m, "myapp-core", krate, Some("build"), false);
            });
            let found = check(dir.path());
            assert_eq!(codes(&found), ["ERR_CHECK_CORE_BOUNDARY_CLOSURE"]);
            assert!(text(&found).contains(&format!("myapp-core -(build)-> {krate}")));
        }
        let dir = copy_pass();
        edit_metadata(dir.path(), |m| {
            add_edge(m, "serde", "helper", Some("build"), false);
            add_edge(m, "helper", "core-foundation-sys", None, false);
        });
        let found = check(dir.path());
        assert_eq!(codes(&found), ["ERR_CHECK_CORE_BOUNDARY_CLOSURE"]);
        assert!(
            text(&found).contains("myapp-core -> serde -(build)-> helper -> core-foundation-sys")
        );
    }

    #[test]
    fn fails_when_the_metadata_has_no_core_or_no_graph() {
        let dir = copy_pass();
        edit_metadata(dir.path(), |m| {
            m["workspace_members"]
                .as_array_mut()
                .expect("members")
                .retain(|id| !id.as_str().unwrap_or_default().contains("myapp-core"));
        });
        assert!(codes(&check(dir.path())).contains(&"ERR_CHECK_CORE_BOUNDARY_METADATA".to_owned()));
        let dir = copy_pass();
        edit_metadata(dir.path(), |m| m["resolve"] = Value::Null);
        assert!(codes(&check(dir.path())).contains(&"ERR_CHECK_CORE_BOUNDARY_METADATA".to_owned()));
    }

    #[test]
    fn fails_when_test_support_is_not_a_dev_dependency() {
        for (kind, optional) in [(None, false), (None, true), (Some("build"), false)] {
            let dir = copy_pass();
            edit_metadata(dir.path(), |m| {
                add_edge(m, "myapp-platform", "myapp-test-support", kind, optional);
            });
            let found = check(dir.path());
            assert_eq!(codes(&found), ["ERR_CHECK_TEST_SUPPORT_NOT_DEV"]);
            assert!(text(&found).contains("myapp-platform"));
        }
    }

    #[test]
    fn fails_when_agents_md_and_the_check_disagree() {
        let dir = copy_pass();
        edit_file(dir.path(), "AGENTS.md", "`objc2*`, ", "`objc2*`, `libc`, ");
        let found = check(dir.path());
        assert_eq!(codes(&found), ["ERR_CHECK_CORE_BOUNDARY_DIVERGED"]);
        assert!(text(&found).contains("`libc`"));
        let dir = copy_pass();
        edit_file(dir.path(), "AGENTS.md", "`objc2*`, ", "");
        let found = check(dir.path());
        assert_eq!(codes(&found), ["ERR_CHECK_CORE_BOUNDARY_DIVERGED"]);
        assert!(text(&found).contains("`objc2*`"));
        let dir = copy_pass();
        edit_file(
            dir.path(),
            "AGENTS.md",
            "dependency closure",
            "dependency set",
        );
        assert_eq!(
            codes(&check(dir.path())),
            ["ERR_CHECK_CORE_BOUNDARY_UNPARSED"]
        );
        let dir = copy_pass();
        std::fs::remove_file(dir.path().join("AGENTS.md")).expect("remove");
        assert_eq!(codes(&check(dir.path())), ["ERR_CHECK_INPUT_MISSING"]);
    }

    #[test]
    fn fails_when_deny_toml_wrappers_differ_from_the_boundary() {
        let dir = copy_pass();
        edit_file(
            dir.path(),
            "deny.toml",
            "[\"myapp\"]",
            "[\"myapp\", \"myapp-core\"]",
        );
        let found = check(dir.path());
        assert_eq!(codes(&found), ["ERR_CHECK_CORE_BOUNDARY_WRAPPERS"]);
        assert!(text(&found).contains("myapp-core"));
        let dir = copy_pass();
        edit_file(dir.path(), "deny.toml", "[\"myapp\"]", "[\"myapp-core\"]");
        assert_eq!(
            codes(&check(dir.path())),
            ["ERR_CHECK_CORE_BOUNDARY_WRAPPERS"]
        );
        let dir = copy_pass();
        edit_file(
            dir.path(),
            "deny.toml",
            "{ crate = \"myapp-platform\", wrappers = [\"myapp\"] },",
            "\"myapp-platform\",",
        );
        let banned = check(dir.path());
        assert_eq!(codes(&banned), ["ERR_CHECK_CORE_BOUNDARY_WRAPPERS"]);
        assert!(text(&banned).contains("banned outright"));
        edit_file(dir.path(), "deny.toml", "\"myapp-platform\",", "");
        let missing = check(dir.path());
        assert_eq!(codes(&missing), ["ERR_CHECK_CORE_BOUNDARY_WRAPPERS"]);
        assert!(text(&missing).contains("no entry for myapp-platform"));
        for content in ["bans = = 1\n", "[bans]\nwildcards = 'deny'\n"] {
            write(dir.path(), "deny.toml", content);
            assert_eq!(
                codes(&check(dir.path())),
                ["ERR_CHECK_CORE_BOUNDARY_UNPARSED"]
            );
        }
        std::fs::remove_file(dir.path().join("deny.toml")).expect("remove");
        assert_eq!(codes(&check(dir.path())), ["ERR_CHECK_INPUT_MISSING"]);
    }

    #[test]
    fn rejects_metadata_of_the_wrong_shape() {
        for json in [
            "{",
            "[]",
            r#"{"workspace_members":[],"resolve":{"nodes":[]}}"#,
            r#"{"packages":[{"id":"x","dependencies":[]}],"workspace_members":[],"resolve":null}"#,
            r#"{"packages":[{"id":"x","name":"x","dependencies":[1]}],"workspace_members":[],"resolve":null}"#,
            r#"{"packages":[],"workspace_members":[],"resolve":{"nodes":[{"id":"x","deps":[{"pkg":"y"}]}]}}"#,
            r#"{"packages":[],"workspace_members":[1],"resolve":null}"#,
            r#"{"packages":[],"workspace_members":[],"resolve":{}}"#,
            r#"{"packages":[{"id":"x","name":"x","dependencies":[{"name":"y","kind":1}]}],"workspace_members":[],"resolve":null}"#,
        ] {
            let found = parse_cargo_metadata(json, "cargo metadata")
                .map(|_| ())
                .map_err(|found| found.code);
            assert_eq!(
                found,
                Err("ERR_CHECK_CORE_BOUNDARY_METADATA".to_owned()),
                "{json}"
            );
        }
    }

    #[test]
    fn runs_cargo_metadata_and_reports_its_failure_as_a_violation() {
        let calls = RefCell::new(Vec::new());
        let dir = copy_pass();
        let recording = |command: &str, args: &[&str], options: &RunOptions| {
            calls
                .borrow_mut()
                .push((command.to_owned(), args.join(" "), options.cwd.clone()));
            fixture_cargo(command, args, options)
        };
        assert_eq!(check_with(dir.path(), &recording), []);
        assert_eq!(
            calls.into_inner(),
            [(
                "cargo".to_owned(),
                "metadata --format-version 1 --locked --offline".to_owned(),
                Some(dir.path().to_path_buf())
            )]
        );
        let failing = |_: &str, _: &[&str], _: &RunOptions| {
            RunResult::exited(101, "", "error: failed to download\nmore")
        };
        let found = check_with(dir.path(), &failing);
        assert_eq!(codes(&found), ["ERR_CHECK_CORE_BOUNDARY_METADATA"]);
        assert_eq!(found[0].actual, "exit 101: error: failed to download");
        let silent = |_: &str, _: &[&str], _: &RunOptions| RunResult::exited(1, "", "");
        assert_eq!(
            check_with(dir.path(), &silent)[0].actual,
            "exit 1: no error output"
        );
        let missing = |_: &str, _: &[&str], _: &RunOptions| RunResult {
            status: None,
            started: false,
            stdout: Vec::new(),
            stderr: b"cargo: No such file or directory".to_vec(),
        };
        assert!(
            check_with(dir.path(), &missing)[0]
                .actual
                .starts_with("exit none (did not start): cargo")
        );
    }
}
