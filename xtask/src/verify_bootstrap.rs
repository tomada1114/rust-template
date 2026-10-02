//! `cargo xtask verify-bootstrap`: proves the bootstrap on a scratch copy (`just
//! verify-bootstrap`). It clones this checkout into its own temporary directory, lays the
//! work tree's uncommitted changes over the clone (so an edit is verified before it is
//! committed), runs this binary's `bootstrap` task there non-interactively with a hyphenated
//! multi-word name, and checks the generated app:
//!
//! - no template placeholder is left in any spelling (`MyApp`, `myapp`, `myapp-core`,
//!   `myapp_core`, `MYAPP`, `com.example.myapp`, the template's owner/repo);
//! - no template-only marker line, and none of the template-only material (the paths the
//!   bootstrap removes, the Template Bootstrap Smoke job and its required context, the
//!   `bootstrap` and `verify-bootstrap` tasks and recipes);
//! - no text that only holds in the template, in any file: a mention of its design
//!   record, of a decision by its number there, of README's template-only section, a
//!   sentence about the first app cut from it, or one about what the template itself
//!   ships or its own reasoning ([`TEMPLATE_TEXT`]);
//! - AGENTS.md's Product section fails the product-section harness check while its
//!   bullets are unfilled, with a `Next:` line naming a skill the app has, and passes once
//!   only its four bullets are filled in;
//! - no dangling reference in a Markdown file (a skill included): a relative link to a
//!   missing file, a path the bootstrap removed, or `just <recipe>` for a recipe the
//!   justfile does not define;
//! - the names agree: the bundle identifier, slug spellings, and version in paths.rs, the
//!   justfile, Cargo.toml, LICENSE, and CHANGELOG.md; the crate directories,
//!   their package names, the workspace members and dependencies, and Cargo.lock; every
//!   Rust crate name a valid identifier.
//!
//! ```text
//! cargo xtask verify-bootstrap [--keep]     (or `just verify-bootstrap [--keep]`)
//! ```
//!
//! CI's Template Bootstrap Smoke job runs it, so a leftover fails the pull request that
//! introduced it rather than an app's first release. `--keep` leaves the scratch copy in
//! place and prints its path. The run needs cargo's registry (the bootstrap fetches and
//! updates Cargo.lock).
//!
//! Git work tree: required; outside one it refuses (`ERR_VERIFY_BOOTSTRAP_CLONE`): there
//! is no checkout to clone.
//!
//! Errors: `ERR_VERIFY_BOOTSTRAP_USAGE`, `ERR_VERIFY_BOOTSTRAP_CLONE`, `ERR_VERIFY_BOOTSTRAP_RUN`, and a generated-tree
//! violation: `ERR_VERIFY_BOOTSTRAP_LEFTOVER`, `ERR_VERIFY_BOOTSTRAP_MARKER`,
//! `ERR_VERIFY_BOOTSTRAP_TEMPLATE_FILE`, `ERR_VERIFY_BOOTSTRAP_TEMPLATE_TEXT`,
//! `ERR_VERIFY_BOOTSTRAP_DANGLING_REFERENCE`, `ERR_VERIFY_BOOTSTRAP_PRODUCT_SECTION`,
//! `ERR_VERIFY_BOOTSTRAP_NAME_MISMATCH`.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::Value;

use crate::bootstrap::{
    Answers, CRATE_DIRS, REMOVED_PATHS, SMOKE_JOB_NAME, derive_names, find_leftovers, first_few,
    read_text, renamed_crate,
};
use crate::check_harness::just_recipes_exist::justfile_recipes;
use crate::check_harness::{Input, product_section, run_check};
use crate::context::{Context, RunOptions};
use crate::fail::{FailureDetails, ScriptError, TaskResult};
use crate::git_env::git_env;

/// A hyphenated multi-word slug, so the hyphen, underscore, and upper-case forms all
/// differ.
fn verify_answers() -> Answers {
    Answers {
        name: "Tide Pool".to_owned(),
        slug: "tide-pool".to_owned(),
        bundle_id: "com.example.tide-pool".to_owned(),
        repo: "example-owner/tide-pool".to_owned(),
        author: "Ada Lovelace".to_owned(),
        copyright: "Ada Lovelace".to_owned(),
    }
}

/// Directories a scan skips: version control, build output, and the `node_modules/` a
/// checkout made before the Node toolchain was removed still holds (`.gitignore` keeps it).
const SKIPPED_DIRS: [&str; 4] = ["node_modules", ".git", "target", "coverage"];
const FIRST_VERSION: &str = "0.1.0";
/// The prefix of every temporary directory this task makes (`just prune-temp` removes
/// the ones an interrupted run leaves behind).
const TEMP_PREFIX: &str = "verify-bootstrap-";

/// Text that holds only in the template: its design record (which the bootstrap
/// deletes), a decision cited by its number in that record, README's template-only
/// section, the app the template was first written for, and a sentence about the
/// template itself — what it ships ("the template ships the index empty") or where its
/// own reasoning lives. An app is not the template, so it keeps none of it; a passage that
/// must survive is worded for both ("the index starts empty").
pub(crate) const TEMPLATE_TEXT: [&str; 6] = [
    r"docs/template",
    r"design D[0-9]",
    r"first app cut from this template",
    r"Using This Template",
    r"(?i)\bthe template(?: repository)? ships\b",
    r"(?i)\bthe template['’]s own reasoning\b",
];

/// A pattern this file writes as a literal, compiled; one that does not compile is a bug
/// here, reported rather than panicking.
fn compile(source: &str) -> Result<Regex, ScriptError> {
    Regex::new(source).map_err(|error| ScriptError::unexpected("compiling a pattern", &error))
}

fn violation(
    code: &str,
    summary: String,
    expected: &str,
    actual: String,
    next: &str,
) -> FailureDetails {
    FailureDetails {
        code: format!("ERR_VERIFY_BOOTSTRAP_{code}"),
        summary,
        expected: expected.to_owned(),
        actual,
        next: next.to_owned(),
    }
}

const FIX_BOOTSTRAP: &str = "fix xtask/src/bootstrap.rs (sites, text_edits, REMOVED_PATHS) or the template file, then run `just verify-bootstrap` again";

/// Every regular file under `root`, as a path relative to it with forward slashes,
/// sorted; [`SKIPPED_DIRS`] and symbolic links are not entered.
fn list_files(root: &Path) -> Result<Vec<String>, ScriptError> {
    let mut files = Vec::new();
    let mut pending = vec![String::new()];
    while let Some(dir) = pending.pop() {
        let full = root.join(&dir);
        let entries = std::fs::read_dir(&full).map_err(|error| {
            ScriptError::unexpected(&format!("listing {}", full.display()), &error)
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                ScriptError::unexpected(&format!("listing {}", full.display()), &error)
            })?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if dir.is_empty() {
                name.clone()
            } else {
                format!("{dir}/{name}")
            };
            let kind = entry
                .file_type()
                .map_err(|error| ScriptError::unexpected(&format!("reading {path}"), &error))?;
            if kind.is_dir() {
                if !SKIPPED_DIRS.contains(&name.as_str()) {
                    pending.push(path);
                }
            } else if kind.is_file() {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn leftovers(root: &Path, files: &[String]) -> Vec<FailureDetails> {
    let mut by_file: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for line in find_leftovers(root, files, None) {
        let file = line.split(':').next().unwrap_or_default().to_owned();
        by_file.entry(file).or_default().push(line);
    }
    by_file
        .into_iter()
        .map(|(file, lines)| {
            violation(
                "LEFTOVER",
                format!("{file} still names the template"),
                "no template placeholder in any spelling in the generated app",
                first_few(&lines),
                &format!("add {file} and its spellings to sites in xtask/src/bootstrap.rs, then run `just verify-bootstrap` again"),
            )
        })
        .collect()
}

/// Whether a line is a `<!-- template-only -->` or `<!-- /template-only -->` marker.
fn is_marker(line: &str) -> bool {
    let Some(rest) = line.trim_start().strip_prefix("<!--") else {
        return false;
    };
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    rest.strip_prefix("template-only")
        .is_some_and(|tail| !tail.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
}

fn markers(root: &Path, files: &[String]) -> Vec<FailureDetails> {
    let found: Vec<String> = files
        .iter()
        .filter_map(|file| read_text(&root.join(file)).map(|text| (file, text)))
        .flat_map(|(file, text)| {
            text.split('\n')
                .enumerate()
                .filter(|(_, line)| is_marker(line))
                .map(|(index, _)| format!("{file}:{}", index + 1))
                .collect::<Vec<_>>()
        })
        .collect();
    if found.is_empty() {
        return Vec::new();
    }
    vec![violation(
        "MARKER",
        "a template-only marker line survived the bootstrap".to_owned(),
        "no `<!-- template-only -->` or `<!-- /template-only -->` line in the generated app",
        found.join(", "),
        "add the file to MARKER_FILES in xtask/src/bootstrap.rs, then run `just verify-bootstrap` again",
    )]
}

fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

fn template_material(root: &Path) -> Vec<FailureDetails> {
    let mut found: Vec<String> = REMOVED_PATHS
        .iter()
        .filter(|path| exists(&root.join(path)))
        .map(|path| (*path).to_owned())
        .collect();
    let ci = read_text(&root.join(".github/workflows/ci.yml")).unwrap_or_default();
    if ci
        .lines()
        .any(|line| line.starts_with("  bootstrap-smoke:"))
        || ci.contains(SMOKE_JOB_NAME)
    {
        found.push(".github/workflows/ci.yml (the bootstrap-smoke job)".to_owned());
    }
    if read_text(&root.join(".github/rulesets/main.json"))
        .is_some_and(|text| text.contains(SMOKE_JOB_NAME))
    {
        found.push(format!(
            ".github/rulesets/main.json (the \"{SMOKE_JOB_NAME}\" context)"
        ));
    }
    let main = read_text(&root.join("xtask/src/main.rs")).unwrap_or_default();
    for task in ["bootstrap", "verify_bootstrap"] {
        if main.contains(&format!("{task}::main")) || main.contains(&format!("mod {task};")) {
            found.push(format!("xtask/src/main.rs (the {task} task)"));
        }
    }
    let recipes = justfile_recipes(&read_text(&root.join("justfile")).unwrap_or_default());
    for recipe in ["bootstrap", "verify-bootstrap"] {
        if recipes.contains(recipe) {
            found.push(format!("justfile (the {recipe} recipe)"));
        }
    }
    if found.is_empty() {
        return Vec::new();
    }
    vec![violation(
        "TEMPLATE_FILE",
        "template-only material survived the bootstrap".to_owned(),
        "the bootstrap's removed paths, CI job, required context, tasks, and recipes all gone",
        found.join(", "),
        FIX_BOOTSTRAP,
    )]
}

fn template_text(root: &Path, files: &[String]) -> Result<Vec<FailureDetails>, ScriptError> {
    let patterns = TEMPLATE_TEXT
        .iter()
        .map(|source| compile(source))
        .collect::<Result<Vec<_>, _>>()?;
    let found: Vec<String> = files
        .iter()
        .filter_map(|file| read_text(&root.join(file)).map(|text| (file, text)))
        .flat_map(|(file, text)| {
            text.split('\n')
                .enumerate()
                .filter(|(_, line)| patterns.iter().any(|pattern| pattern.is_match(line)))
                .map(|(index, line)| format!("{file}:{}: {}", index + 1, line.trim()))
                .collect::<Vec<_>>()
        })
        .collect();
    if found.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![violation(
        "TEMPLATE_TEXT",
        format!(
            "{} line(s) in the generated app describe the template",
            found.len()
        ),
        "no mention of the template's design record, a decision number in it, README's template-only section, the template's first app, or what the template itself ships or its own reasoning",
        first_few(&found),
        "rewrite the passage in the template so it holds in an app too, or add a text_edits entry for it in xtask/src/bootstrap.rs, then run `just verify-bootstrap` again",
    )])
}

/// AGENTS.md with only the Product section's bullets filled in: each `- **Label** — …`
/// line keeps its label and takes a stand-in answer, and its indented continuation lines
/// go. Every other line, the section's introduction included, is left as it is.
pub(crate) fn fill_product_bullets(agents: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    let mut inside = false;
    let mut bullet = false;
    for line in agents.split('\n') {
        if line.starts_with("## ") {
            inside = line == "## Product";
            bullet = false;
        } else if inside && line.starts_with("- **") {
            let filled = line.find("** — ").map_or_else(
                || line.to_owned(),
                |end| format!("{}a stand-in answer.", &line[..end + "** — ".len()]),
            );
            kept.push(filled);
            bullet = true;
            continue;
        } else if inside && bullet && line.starts_with("  ") {
            continue;
        } else {
            bullet = false;
        }
        kept.push(line.to_owned());
    }
    kept.join("\n")
}

fn product_violation(actual: String) -> FailureDetails {
    violation(
        "PRODUCT_SECTION",
        "AGENTS.md's Product section does not behave as an app's should after the bootstrap"
            .to_owned(),
        "the product-section check to fail on the unfilled bullets, name a skill the app has, and pass once only the four bullets are filled in",
        actual,
        "fix the Product section's text_edits entry in xtask/src/bootstrap.rs, or xtask/src/check_harness/product_section.rs's Next line, then run `just verify-bootstrap` again",
    )
}

/// The product-section check: its violations under a root.
pub(crate) type ProductSectionCheck<'a> = &'a dyn Fn(&Path) -> Vec<FailureDetails>;

/// The skills a `Next:` line names as "the `<name>` skill".
fn named_skills(next: &str) -> Vec<String> {
    next.split("the `")
        .skip(1)
        .filter_map(|rest| {
            let (name, tail) = rest.split_once('`')?;
            let valid = !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            (valid && tail.starts_with(" skill")).then(|| name.to_owned())
        })
        .collect()
}

fn product_section_behaviour(
    root: &Path,
    temp_base: &Path,
    product_section: ProductSectionCheck<'_>,
) -> Result<Vec<FailureDetails>, ScriptError> {
    let (Some(agents), Some(justfile)) = (
        read_text(&root.join("AGENTS.md")),
        read_text(&root.join("justfile")),
    ) else {
        return Ok(vec![product_violation(
            "no AGENTS.md or justfile in the generated app".to_owned(),
        )]);
    };
    let unfilled = product_section(root);
    let Some(first) = unfilled.first() else {
        return Ok(vec![product_violation(
            "the check passes on the unfilled section".to_owned(),
        )]);
    };
    let mut skills: Vec<String> = unfilled
        .iter()
        .flat_map(|found| named_skills(&found.next))
        .collect();
    skills.sort();
    skills.dedup();
    let missing: Vec<&str> = skills
        .iter()
        .filter(|name| {
            !root
                .join(".agents/skills")
                .join(name)
                .join("SKILL.md")
                .is_file()
        })
        .map(String::as_str)
        .collect();
    if skills.is_empty() || !missing.is_empty() {
        let named = if skills.is_empty() {
            "no skill".to_owned()
        } else {
            format!("a skill the app lacks: {}", missing.join(", "))
        };
        return Ok(vec![product_violation(format!(
            "its Next line names {named} ({})",
            first.next
        ))]);
    }
    let filled_root = make_temp_dir(temp_base, &format!("{TEMP_PREFIX}product-"))?;
    let written = std::fs::write(filled_root.join("AGENTS.md"), fill_product_bullets(&agents))
        .and_then(|()| std::fs::write(filled_root.join("justfile"), &justfile));
    let filled = written.map(|()| product_section(&filled_root));
    let removed = std::fs::remove_dir_all(&filled_root);
    let filled =
        filled.map_err(|error| ScriptError::unexpected("writing the filled AGENTS.md", &error))?;
    removed.map_err(|error| ScriptError::unexpected("removing a temporary directory", &error))?;
    if filled.is_empty() {
        return Ok(Vec::new());
    }
    let found: Vec<String> = filled
        .iter()
        .map(|found| format!("{} ({})", found.summary, found.actual))
        .collect();
    Ok(vec![product_violation(format!(
        "with only the bullets filled in, the check still fails: {}",
        found.join(" | ")
    ))])
}

/// `just <recipe>` in inline code and at the start of fenced code lines.
fn recipe_mentions(text: &str) -> Result<Vec<String>, ScriptError> {
    let inline = compile(r"`just ([a-z][a-z0-9-]*)[^`]*`")?;
    let mut names = Vec::new();
    let mut fenced = false;
    for line in text.split('\n') {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            if let Some(rest) = line.trim_start().strip_prefix("just ") {
                let name: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
                    .collect();
                if name.starts_with(|c: char| c.is_ascii_lowercase()) {
                    names.push(name);
                }
            }
            continue;
        }
        names.extend(
            inline
                .captures_iter(line)
                .filter_map(|captures| Some(captures.get(1)?.as_str().to_owned())),
        );
    }
    Ok(names)
}

/// `path` with `.` and `..` resolved lexically and empty parts dropped; a `..` that
/// climbs above the start is kept.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

/// The relative link targets in Markdown prose (code spans and fenced blocks are
/// examples, not links).
fn link_targets(text: &str) -> Result<Vec<String>, ScriptError> {
    let fences = compile(r"(?m)^\s*```[\s\S]*?^\s*```")?;
    let spans = compile(r"`[^`\n]*`")?;
    let links = compile(r"\]\(([^)\s]+)\)")?;
    let scheme = compile(r"(?i)^[a-z][a-z0-9+.-]*:")?;
    let prose = fences.replace_all(text, "");
    let prose = spans.replace_all(&prose, "");
    Ok(links
        .captures_iter(&prose)
        .filter_map(|captures| {
            let target = captures.get(1)?.as_str().split('#').next()?.to_owned();
            (!target.is_empty() && !target.contains('<') && !scheme.is_match(&target))
                .then_some(target)
        })
        .collect())
}

fn dangling_references(root: &Path, files: &[String]) -> Result<Vec<FailureDetails>, ScriptError> {
    let defined = justfile_recipes(&read_text(&root.join("justfile")).unwrap_or_default());
    let mut found = Vec::new();
    for file in files.iter().filter(|path| {
        Path::new(path)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    }) {
        let Some(text) = read_text(&root.join(file)) else {
            continue;
        };
        let dir = file.rsplit_once('/').map_or("", |(dir, _)| dir);
        for target in link_targets(&text)? {
            let resolved = normalize(&format!("{dir}/{target}"));
            if resolved.starts_with("..") || !root.join(&resolved).exists() {
                found.push(format!("{file}: link to {target}"));
            }
        }
        for path in REMOVED_PATHS {
            if text.contains(path) {
                found.push(format!("{file}: names the removed {path}"));
            }
        }
        for name in recipe_mentions(&text)? {
            if !defined.contains(&name) {
                found.push(format!("{file}: `just {name}` (no such recipe)"));
            }
        }
    }
    if found.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![violation(
        "DANGLING_REFERENCE",
        format!(
            "{} reference(s) in the Markdown point at something the app does not have",
            found.len()
        ),
        "every relative link, named path, and `just` recipe in a skill or document to exist after the bootstrap",
        found.join(" | "),
        "remove or rewrite the passage through text_edits or REMOVED_PATHS in xtask/src/bootstrap.rs, then run `just verify-bootstrap` again",
    )])
}

fn parsed_toml(text: Option<String>) -> Option<toml::Value> {
    text?.parse::<toml::Table>().ok().map(toml::Value::Table)
}

/// The JSON form of a TOML value, so both files' fields compare the same way.
fn toml_json(value: Option<&toml::Value>) -> Value {
    value
        .and_then(|value| serde_json::to_value(value).ok())
        .unwrap_or(Value::Null)
}

fn toml_at<'a>(value: Option<&'a toml::Value>, keys: &[&str]) -> Option<&'a toml::Value> {
    keys.iter()
        .try_fold(value?, |current, key| current.get(key))
}

/// The first capture of `pattern` in `text`, as a JSON string, or null.
fn captured(text: Option<&str>, pattern: &str) -> Result<Value, ScriptError> {
    let pattern = compile(pattern)?;
    Ok(text
        .and_then(|text| pattern.captures(text))
        .and_then(|captures| captures.get(1))
        .map_or(Value::Null, |found| Value::from(found.as_str())))
}

fn name_mismatches(root: &Path, answers: &Answers) -> Result<Vec<FailureDetails>, ScriptError> {
    let names = derive_names(answers);
    let text = |path: &str| read_text(&root.join(path));
    let cargo = parsed_toml(text("Cargo.toml"));
    let lock = parsed_toml(text("Cargo.lock"));
    let crate_dirs: Vec<String> = CRATE_DIRS
        .iter()
        .map(|dir| renamed_crate(dir, &names.slug))
        .collect();
    let paths = text(&format!(
        "{}/src/paths.rs",
        renamed_crate("crates/myapp-platform", &names.slug)
    ));
    let justfile = text("justfile");
    let changelog = text("CHANGELOG.md").unwrap_or_default();
    let releases = changelog
        .lines()
        .filter(|line| line.starts_with("## ["))
        .count();

    let expectations: [(&str, Value, Value); 5] = [
        (
            "paths.rs BUNDLE_IDENTIFIER",
            captured(paths.as_deref(), r#"BUNDLE_IDENTIFIER: &str = "([^"]*)""#)?,
            Value::from(answers.bundle_id.as_str()),
        ),
        (
            "justfile bundle_id",
            captured(justfile.as_deref(), r#"(?m)^bundle_id := "([^"]*)""#)?,
            Value::from(answers.bundle_id.as_str()),
        ),
        (
            "Cargo.toml [workspace.package] version",
            toml_json(toml_at(
                cargo.as_ref(),
                &["workspace", "package", "version"],
            )),
            Value::from(FIRST_VERSION),
        ),
        (
            "LICENSE copyright line",
            captured(
                text("LICENSE").as_deref(),
                r"(?m)^Copyright \(c\) \d{4} (.*)$",
            )?,
            Value::from(answers.copyright.as_str()),
        ),
        (
            "CHANGELOG.md release headings",
            Value::from(releases),
            Value::from(1),
        ),
    ];
    let mut found: Vec<String> = expectations
        .iter()
        .filter(|(_, actual, expected)| actual != expected)
        .map(|(label, actual, expected)| format!("{label}: {actual} (expected {expected})"))
        .collect();

    // The crates: directories, package names, members, dependencies, and the lockfile agree.
    let mut present: Vec<String> = std::fs::read_dir(root.join("crates"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| format!("crates/{}", entry.file_name().to_string_lossy()))
                .collect()
        })
        .unwrap_or_default();
    present.sort();
    found.extend(
        crate_dirs
            .iter()
            .filter(|dir| !present.contains(dir))
            .map(|dir| format!("{dir}: missing")),
    );
    found.extend(
        present
            .iter()
            .filter(|dir| !crate_dirs.contains(dir))
            .map(|dir| format!("{dir}: not a renamed template crate")),
    );
    let members = toml_json(toml_at(cargo.as_ref(), &["workspace", "members"]));
    if !members
        .as_array()
        .is_some_and(|members| members.contains(&Value::from("crates/*")))
    {
        found.push(format!(
            "Cargo.toml workspace.members: {members} (expected crates/*)"
        ));
    }
    let packages: Vec<String> = toml_at(lock.as_ref(), &["package"])
        .and_then(toml::Value::as_array)
        .map(|packages| {
            packages
                .iter()
                .filter_map(|package| package.get("name")?.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    for dir in &crate_dirs {
        let name = dir.trim_start_matches("crates/");
        let manifest = parsed_toml(text(&format!("{dir}/Cargo.toml")));
        let package_name = toml_json(toml_at(manifest.as_ref(), &["package", "name"]));
        if package_name.as_str() != Some(name) {
            found.push(format!("{dir}/Cargo.toml package name: {package_name}"));
        }
        let ident = name.replace('-', "_");
        if !(ident.starts_with(|c: char| c.is_ascii_lowercase())
            && ident
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
        {
            found.push(format!("{name}: not a valid Rust crate name"));
        }
        if !packages.iter().any(|package| package == name) {
            found.push(format!("Cargo.lock: no package {name}"));
        }
    }
    if let Some(dependencies) =
        toml_at(cargo.as_ref(), &["workspace", "dependencies"]).and_then(toml::Value::as_table)
    {
        for (key, spec) in dependencies {
            let Some(path) = spec.get("path").and_then(toml::Value::as_str) else {
                continue;
            };
            if path != format!("crates/{key}") || !crate_dirs.iter().any(|dir| dir == path) {
                found.push(format!(
                    "Cargo.toml [workspace.dependencies] {key}: path {path}"
                ));
            }
        }
    }

    if found.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![violation(
        "NAME_MISMATCH",
        format!("{} name(s) in the generated app disagree", found.len()),
        &format!(
            "every site to spell {} / {} / {} the way it needs",
            answers.name, names.slug, answers.bundle_id
        ),
        found.join(" | "),
        FIX_BOOTSTRAP,
    )])
}

/// Every way the tree at `root` falls short of an app bootstrapped with `answers`, with
/// `product_section` judging AGENTS.md's Product section.
pub(crate) fn assert_generated(
    root: &Path,
    answers: &Answers,
    temp_base: &Path,
    product_section: ProductSectionCheck<'_>,
) -> Result<Vec<FailureDetails>, ScriptError> {
    let files = list_files(root)?;
    let mut found = leftovers(root, &files);
    found.extend(markers(root, &files));
    found.extend(template_material(root));
    found.extend(template_text(root, &files)?);
    found.extend(dangling_references(root, &files)?);
    found.extend(product_section_behaviour(root, temp_base, product_section)?);
    found.extend(name_mismatches(root, answers)?);
    Ok(found)
}

/// A new, empty directory under `base` named `<prefix><unique>`.
fn make_temp_dir(base: &Path, prefix: &str) -> Result<PathBuf, ScriptError> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.subsec_nanos());
    for attempt in 0_u32..1000 {
        let dir = base.join(format!(
            "{prefix}{:x}{nanos:x}{attempt}",
            std::process::id()
        ));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(ScriptError::unexpected(
                    &format!("creating {}", dir.display()),
                    &error,
                ));
            }
        }
    }
    Err(ScriptError::unexpected(
        "creating a temporary directory",
        &format!(
            "every name under {} starting {prefix} is taken",
            base.display()
        ),
    ))
}

/// The directory temporary files go in: `TMPDIR`, else the OS default.
fn temp_base(context: &Context<'_>) -> PathBuf {
    context
        .env
        .get("TMPDIR")
        .filter(|dir| !dir.is_empty())
        .map_or_else(std::env::temp_dir, PathBuf::from)
}

fn git(context: &Context<'_>, args: &[&str], cwd: &Path) -> Result<String, ScriptError> {
    let result = context.run(
        "git",
        args,
        &RunOptions {
            cwd: Some(cwd.to_path_buf()),
            env: Some(git_env(&context.env)),
            input: None,
        },
    );
    if result.success() {
        return Ok(result.stdout_text());
    }
    Err(ScriptError::new(
        "ERR_VERIFY_BOOTSTRAP_CLONE",
        format!(
            "could not copy {} into a scratch clone",
            context.root.display()
        ),
        format!("`git {}` to exit 0 in a git checkout", args.join(" ")),
        format!(
            "exit {}: {}",
            result
                .status
                .map_or_else(|| "none".to_owned(), |status| status.to_string()),
            result.stderr_text().trim()
        ),
        "run this from a git checkout of the template",
    ))
}

/// Copy the work tree's uncommitted and untracked changes over the clone.
fn overlay(context: &Context<'_>, clone: &Path) -> TaskResult {
    let root = context.root.as_path();
    let mut changed = git(context, &["diff", "--name-only", "-z", "HEAD"], root)?;
    changed.push_str(&git(
        context,
        &["ls-files", "-z", "--others", "--exclude-standard"],
        root,
    )?);
    for path in changed.split('\0').filter(|path| !path.is_empty()) {
        let source = root.join(path);
        let target = clone.join(path);
        let copied = match std::fs::symlink_metadata(&source) {
            Ok(metadata) if metadata.is_file() => target
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| std::fs::copy(&source, &target).map(drop)),
            Ok(_) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                match std::fs::remove_file(&target) {
                    Err(error) if error.kind() != ErrorKind::NotFound => Err(error),
                    _ => Ok(()),
                }
            }
            Err(error) => Err(error),
        };
        copied.map_err(|error| {
            ScriptError::unexpected(&format!("copying {path} into the clone"), &error)
        })?;
    }
    Ok(())
}

fn parse_args(argv: &[String]) -> Result<bool, ScriptError> {
    let mut keep = false;
    for arg in argv {
        if arg == "--keep" {
            keep = true;
        } else {
            return Err(ScriptError::new(
                "ERR_VERIFY_BOOTSTRAP_USAGE",
                format!("unknown argument '{arg}'"),
                "no arguments, or --keep",
                arg.clone(),
                "cargo xtask verify-bootstrap [--keep]",
            ));
        }
    }
    Ok(keep)
}

/// Clone the checkout into `clone`, lay the work tree over it, and commit, so the
/// bootstrap sees a clean tree.
fn prepare_clone(context: &Context<'_>, workspace: &Path, clone: &Path) -> TaskResult {
    let clone_arg = clone.display().to_string();
    let root_arg = context.root.display().to_string();
    git(
        context,
        &["clone", "--quiet", "--no-hardlinks", &root_arg, &clone_arg],
        workspace,
    )?;
    overlay(context, clone)?;
    git(context, &["add", "-A"], clone)?;
    git(
        context,
        &[
            "-c",
            "user.name=verify-bootstrap",
            "-c",
            "user.email=verify-bootstrap@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "verify-bootstrap: the work tree's changes",
        ],
        clone,
    )?;
    Ok(())
}

/// Run `exe`'s bootstrap task in `clone`, its root found through `CARGO_MANIFEST_DIR`.
fn run_bootstrap(context: &Context<'_>, exe: &Path, clone: &Path, answers: &Answers) -> TaskResult {
    let mut env = git_env(&context.env);
    env.insert(
        "CARGO_MANIFEST_DIR".to_owned(),
        clone.join("xtask").display().to_string(),
    );
    let args = [
        "bootstrap",
        "--yes",
        "--name",
        &answers.name,
        "--slug",
        &answers.slug,
        "--bundle-id",
        &answers.bundle_id,
        "--repo",
        &answers.repo,
        "--author",
        &answers.author,
        "--copyright",
        &answers.copyright,
    ];
    context.log(&format!(
        "verify-bootstrap: bootstrapping a clone at {}",
        clone.display()
    ));
    let result = context.run(
        &exe.display().to_string(),
        &args,
        &RunOptions {
            cwd: Some(clone.to_path_buf()),
            env: Some(env),
            input: None,
        },
    );
    for line in result.stdout_text().lines() {
        context.log(line);
    }
    if result.success() {
        return Ok(());
    }
    Err(ScriptError::new(
        "ERR_VERIFY_BOOTSTRAP_RUN",
        "the bootstrap failed on a fresh clone",
        "`cargo xtask bootstrap --yes …` to exit 0",
        format!(
            "exit {}: {}",
            result
                .status
                .map_or_else(|| "none".to_owned(), |status| status.to_string()),
            result.stderr_text().trim().replace('\n', " / ")
        ),
        "fix what the bootstrap reports (its ERR_BOOTSTRAP_* code), then run this again",
    ))
}

/// The task with the bootstrap's binary given, so a test can name a fake one.
fn verify(context: &Context<'_>, exe: &Path) -> TaskResult {
    let keep = parse_args(&context.argv)?;

    let base = temp_base(context);
    let workspace = make_temp_dir(&base, TEMP_PREFIX)?;
    let clone = workspace.join("app");
    let answers = verify_answers();
    let product_section = |root: &Path| {
        run_check(
            product_section::run,
            &Input {
                root,
                run: context.run,
                env: &context.env,
            },
        )
    };
    let outcome = prepare_clone(context, &workspace, &clone)
        .and_then(|()| run_bootstrap(context, exe, &clone, &answers))
        .and_then(|()| assert_generated(&clone, &answers, &base, &product_section));
    let cleanup = if keep {
        context.log(&format!(
            "verify-bootstrap: kept the scratch copy at {}",
            clone.display()
        ));
        Ok(())
    } else {
        std::fs::remove_dir_all(&workspace).map_err(|error| {
            ScriptError::unexpected(&format!("removing {}", workspace.display()), &error)
        })
    };

    // The run's own failure outranks a failed cleanup, which would otherwise hide it.
    let violations = outcome?;
    cleanup?;
    if let Some(first) = violations.first() {
        for other in &violations[1..] {
            context.log(&other.to_string());
        }
        let mut details = first.clone();
        details.summary = format!("{} (1 of {})", details.summary, violations.len());
        return Err(ScriptError::new(
            &details.code,
            details.summary,
            details.expected,
            details.actual,
            details.next,
        ));
    }
    context.log(&format!(
        "verify-bootstrap: ok — a scratch clone bootstrapped as \"{}\" ({}, {}) with no leftover placeholder, marker, template-only file or text, dangling reference, Product-section fault, or name mismatch",
        answers.name, answers.slug, answers.bundle_id
    ));
    Ok(())
}

pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    let exe = std::env::current_exe()
        .map_err(|error| ScriptError::unexpected("finding the xtask binary", &error))?;
    verify(context, &exe)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    use super::{
        assert_generated, fill_product_bullets, is_marker, main, make_temp_dir, named_skills,
        normalize, verify, verify_answers,
    };
    use crate::context::{Context, Env, RunOptions, RunResult, run_command};
    use crate::fail::{FailureDetails, TaskResult};
    use crate::test_support::{Fake, committed_repo, git, temp_dir, write};

    const AGENTS: &str = "# Project Guide\n\n## Product\n\nThis section is the app's own.\n\n- **What it is, and who it is for** — TODO: one paragraph.\n  More of it.\n- **Non-goals** — TODO: the cut list.\n\n## Quick Reference\n\n- **Not a product bullet** — kept.\n";

    /// The product-section check as a fake: it fails, naming `skill`, until the bullets
    /// are filled in, or `always` holds what it reports regardless.
    fn product_check(
        skill: &'static str,
        always: Option<&'static str>,
    ) -> impl Fn(&Path) -> Vec<FailureDetails> {
        move |root| {
            let agents = std::fs::read_to_string(root.join("AGENTS.md")).unwrap_or_default();
            if always.is_none() && agents.contains("a stand-in answer") {
                return Vec::new();
            }
            vec![FailureDetails {
                code: "ERR_CHECK_PRODUCT_SECTION".to_owned(),
                summary: always
                    .unwrap_or("AGENTS.md:7 still holds a `TODO:` marker")
                    .to_owned(),
                expected: "no marker".to_owned(),
                actual: "a marker".to_owned(),
                next: format!("fill it in (the `{skill}` skill walks through it)"),
            }]
        }
    }

    /// A tree the bootstrap would have produced from [`verify_answers`].
    fn app_tree() -> tempfile::TempDir {
        let dir = temp_dir();
        let root = dir.path();
        let crates = [
            "tide-pool",
            "tide-pool-core",
            "tide-pool-platform",
            "tide-pool-test-support",
        ];
        for name in crates {
            write(
                root,
                &format!("crates/{name}/Cargo.toml"),
                format!("[package]\nname = \"{name}\"\n"),
            );
        }
        write(
            root,
            "crates/tide-pool-platform/src/paths.rs",
            "pub const BUNDLE_IDENTIFIER: &str = \"com.example.tide-pool\";\n",
        );
        write(
            root,
            "Cargo.toml",
            "[workspace]\nmembers = [\"crates/*\"]\n\n[workspace.package]\nversion = \"0.1.0\"\n\n[workspace.dependencies]\ntide-pool-core = { path = \"crates/tide-pool-core\" }\nserde = \"1\"\n",
        );
        let lock = crates
            .iter()
            .map(|name| format!("[[package]]\nname = \"{name}\"\nversion = \"0.1.0\"\n"))
            .collect::<Vec<_>>()
            .join("\n");
        write(root, "Cargo.lock", format!("version = 4\n\n{lock}"));
        write(
            root,
            "LICENSE",
            "MIT License\n\nCopyright (c) 2031 Ada Lovelace\n",
        );
        write(root, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
        write(
            root,
            "justfile",
            "bundle_id := \"com.example.tide-pool\"\n\n# Check\ncheck:\n    cargo test\n",
        );
        write(root, "AGENTS.md", AGENTS);
        write(
            root,
            ".agents/skills/starting-an-app/SKILL.md",
            "---\nname: starting-an-app\n---\n",
        );
        write(
            root,
            "docs/guide.md",
            "See [the guide](../AGENTS.md#product), [a site](https://example.com), [a template](adr/NNNN-<title>.md), and `[code](missing.md)`.\nRun `just check`.\n\n```sh\njust check\n[fenced](missing.md)\n```\n",
        );
        write(root, "target/debug/notes.md", "MyApp");
        dir
    }

    fn generated(root: &Path, check: &dyn Fn(&Path) -> Vec<FailureDetails>) -> Vec<FailureDetails> {
        let base = temp_dir();
        assert_generated(root, &verify_answers(), base.path(), check).expect("checked")
    }

    fn codes(found: &[FailureDetails]) -> Vec<String> {
        found.iter().map(|found| found.code.clone()).collect()
    }

    #[test]
    fn passes_an_app_the_bootstrap_produced() {
        let dir = app_tree();
        let found = generated(dir.path(), &product_check("starting-an-app", None));
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn reports_a_leftover_marker_template_file_and_template_text() {
        let dir = app_tree();
        let root = dir.path();
        write(root, "docs/a.md", "Run MyApp.\n<!-- template-only -->\n");
        write(
            root,
            "notes.txt",
            "The template ships the index empty; see docs/template.\n",
        );
        write(root, "docs/template/design.md", "x\n");
        write(
            root,
            ".github/workflows/ci.yml",
            "jobs:\n  bootstrap-smoke:\n    name: x\n",
        );
        write(
            root,
            ".github/rulesets/main.json",
            "{ \"context\": \"Template Bootstrap Smoke\" }\n",
        );
        write(
            root,
            "xtask/src/main.rs",
            "mod bootstrap;\nverify_bootstrap::main\n",
        );
        let justfile = std::fs::read_to_string(root.join("justfile")).expect("read");
        write(
            root,
            "justfile",
            format!("{justfile}\nverify-bootstrap:\n    true\n"),
        );
        let found = generated(root, &product_check("starting-an-app", None));
        assert_eq!(
            codes(&found),
            [
                "ERR_VERIFY_BOOTSTRAP_LEFTOVER",
                "ERR_VERIFY_BOOTSTRAP_MARKER",
                "ERR_VERIFY_BOOTSTRAP_TEMPLATE_FILE",
                "ERR_VERIFY_BOOTSTRAP_TEMPLATE_TEXT",
            ]
        );
        assert_eq!(found[0].actual, "docs/a.md:1: Run MyApp.");
        assert_eq!(found[1].actual, "docs/a.md:2");
        assert_eq!(
            found[2].actual,
            "docs/template, .github/workflows/ci.yml (the bootstrap-smoke job), .github/rulesets/main.json (the \"Template Bootstrap Smoke\" context), xtask/src/main.rs (the bootstrap task), xtask/src/main.rs (the verify_bootstrap task), justfile (the verify-bootstrap recipe)"
        );
        assert!(found[3].actual.contains("notes.txt:1: The template ships"));
    }

    #[test]
    fn reports_dangling_links_removed_paths_and_unknown_recipes() {
        let dir = app_tree();
        let root = dir.path();
        write(
            root,
            "docs/b.md",
            "[gone](gone.md) [above](../../outside.md) xtask/src/bootstrap.rs `just nope --x`\n\n```\njust missing\n  just 9no\n```\n",
        );
        let found = generated(root, &product_check("starting-an-app", None));
        assert_eq!(codes(&found), ["ERR_VERIFY_BOOTSTRAP_DANGLING_REFERENCE"]);
        assert_eq!(
            found[0].actual,
            "docs/b.md: link to gone.md | docs/b.md: link to ../../outside.md | docs/b.md: names the removed xtask/src/bootstrap.rs | docs/b.md: `just nope` (no such recipe) | docs/b.md: `just missing` (no such recipe)"
        );
    }

    #[test]
    fn reports_a_product_section_that_does_not_behave() {
        let dir = app_tree();
        let root = dir.path();
        let passes = |_: &Path| Vec::new();
        let found = generated(root, &passes);
        assert_eq!(found[0].actual, "the check passes on the unfilled section");
        let found = generated(root, &product_check("missing-skill", None));
        assert!(
            found[0]
                .actual
                .starts_with("its Next line names a skill the app lacks: missing-skill")
        );
        let found = generated(root, &product_check("not a skill name", None));
        assert!(found[0].actual.starts_with("its Next line names no skill"));
        let found = generated(
            root,
            &product_check("starting-an-app", Some("still failing")),
        );
        assert_eq!(
            found[0].actual,
            "with only the bullets filled in, the check still fails: still failing (a marker)"
        );
        std::fs::remove_file(root.join("AGENTS.md")).expect("remove");
        std::fs::remove_file(root.join("docs/guide.md")).expect("remove");
        let found = generated(root, &passes);
        assert_eq!(codes(&found), ["ERR_VERIFY_BOOTSTRAP_PRODUCT_SECTION"]);
        assert_eq!(
            found[0].actual,
            "no AGENTS.md or justfile in the generated app"
        );
    }

    #[test]
    fn reports_every_name_that_disagrees() {
        let dir = app_tree();
        let root = dir.path();
        write(
            root,
            "crates/tide-pool-core/Cargo.toml",
            "[package]\nname = \"other\"\n",
        );
        write(
            root,
            "crates/stray/Cargo.toml",
            "[package]\nname = \"stray\"\n",
        );
        std::fs::remove_dir_all(root.join("crates/tide-pool-test-support")).expect("remove");
        write(
            root,
            "Cargo.toml",
            "[workspace]\nmembers = [\"other/*\"]\n\n[workspace.dependencies]\nx = { path = \"crates/y\" }\n",
        );
        write(root, "Cargo.lock", "version = 4\n");
        write(root, "CHANGELOG.md", "## [Unreleased]\n## [0.1.0]\n");
        std::fs::remove_file(root.join("LICENSE")).expect("remove");
        let found = generated(root, &product_check("starting-an-app", None));
        assert_eq!(codes(&found), ["ERR_VERIFY_BOOTSTRAP_NAME_MISMATCH"]);
        let actual = &found[0].actual;
        for part in [
            "Cargo.toml [workspace.package] version: null (expected \"0.1.0\")",
            "LICENSE copyright line: null (expected \"Ada Lovelace\")",
            "CHANGELOG.md release headings: 2 (expected 1)",
            "crates/tide-pool-test-support: missing",
            "crates/stray: not a renamed template crate",
            "Cargo.toml workspace.members: [\"other/*\"] (expected crates/*)",
            "crates/tide-pool-core/Cargo.toml package name: \"other\"",
            "Cargo.lock: no package tide-pool",
            "Cargo.toml [workspace.dependencies] x: path crates/y",
        ] {
            assert!(actual.contains(part), "{part} in {actual}");
        }
    }

    #[test]
    fn fills_only_the_product_bullets() {
        assert_eq!(
            fill_product_bullets(AGENTS),
            "# Project Guide\n\n## Product\n\nThis section is the app's own.\n\n- **What it is, and who it is for** — a stand-in answer.\n- **Non-goals** — a stand-in answer.\n\n## Quick Reference\n\n- **Not a product bullet** — kept.\n"
        );
        assert_eq!(
            fill_product_bullets("## Product\n- **Bare**\n"),
            "## Product\n- **Bare**\n"
        );
    }

    #[test]
    fn reads_markers_skills_and_paths() {
        assert!(is_marker("  <!-- template-only -->"));
        assert!(is_marker("<!--/template-only-->"));
        assert!(!is_marker("<!-- template-onlyish -->"));
        assert!(!is_marker("template-only"));
        assert_eq!(
            named_skills("see the `starting-an-app` skill, the `x` file, and the `Bad Name` skill"),
            ["starting-an-app"]
        );
        assert_eq!(normalize("docs/./a/../b.md"), "docs/b.md");
        assert_eq!(normalize("docs/../../x.md"), "../x.md");
        assert_eq!(normalize("/docs//x.md"), "docs/x.md");
    }

    #[test]
    fn makes_unique_temporary_directories_and_reports_a_missing_base() {
        let base = temp_dir();
        let first = make_temp_dir(base.path(), "verify-bootstrap-").expect("dir");
        let second = make_temp_dir(base.path(), "verify-bootstrap-").expect("dir");
        assert_ne!(first, second);
        assert!(
            first
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("verify-bootstrap-"))
        );
        let error = make_temp_dir(&base.path().join("missing"), "x-").expect_err("no base");
        assert_eq!(error.code(), "ERR_INTERNAL_UNEXPECTED");
    }

    /// What one run of [`verify`] did, with `bootstrap` answering the bootstrap's run and
    /// every other command run for real.
    fn verify_at(
        root: &Path,
        argv: &[&str],
        tmp: &Path,
        bootstrap: &dyn Fn(&RunOptions) -> RunResult,
    ) -> (TaskResult, Vec<String>) {
        let lines = RefCell::new(Vec::new());
        let runner = |command: &str, args: &[&str], options: &RunOptions| {
            if command == "/fake/xtask" {
                assert_eq!(args.first(), Some(&"bootstrap"));
                bootstrap(options)
            } else {
                run_command(command, args, options)
            }
        };
        let log = |line: &str| lines.borrow_mut().push(line.to_owned());
        let mut env: Env = crate::test_support::hook_env();
        env.insert("TMPDIR".to_owned(), tmp.display().to_string());
        let context = Context {
            argv: argv.iter().map(ToString::to_string).collect(),
            env,
            root: root.to_path_buf(),
            run: &runner,
            log: &log,
            stdin: None,
        };
        let result = verify(&context, Path::new("/fake/xtask"));
        drop(context);
        (result, lines.into_inner())
    }

    fn workspaces(tmp: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(tmp)
            .expect("list")
            .map(|entry| entry.expect("entry").path())
            .collect()
    }

    #[test]
    fn refuses_bad_arguments() {
        let outcome = Fake::at(Path::new("/nonexistent"))
            .argv(&["--bogus"])
            .task(main);
        assert_eq!(outcome.code(), "ERR_VERIFY_BOOTSTRAP_USAGE");
    }

    #[test]
    fn refuses_outside_a_git_checkout_and_leaves_no_temporary_directory() {
        let dir = temp_dir();
        let tmp = temp_dir();
        let (result, _) = verify_at(dir.path(), &[], tmp.path(), &|_| {
            RunResult::exited(0, "", "")
        });
        assert_eq!(
            result.expect_err("no checkout").code(),
            "ERR_VERIFY_BOOTSTRAP_CLONE"
        );
        assert!(workspaces(tmp.path()).is_empty());
    }

    #[test]
    fn verifies_a_clone_with_the_work_tree_laid_over_it() {
        let repo = committed_repo();
        let root = repo.path();
        write(root, "gone.txt", "tracked\n");
        write(root, "AGENTS.md", AGENTS);
        write(root, "justfile", "check:\n    true\n");
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "--no-verify", "-m", "more"]);
        write(root, "README.md", "changed\n");
        write(root, "new.txt", "untracked\n");
        std::fs::remove_file(root.join("gone.txt")).expect("remove");

        let tmp = temp_dir();
        let seen = RefCell::new(None);
        let (result, lines) = verify_at(root, &["--keep"], tmp.path(), &|options| {
            *seen.borrow_mut() = options
                .env
                .as_ref()
                .and_then(|env| env.get("CARGO_MANIFEST_DIR").cloned());
            RunResult::exited(
                1,
                "bootstrap: started\n",
                "ERR_BOOTSTRAP_X: broke\nExpected: y\n",
            )
        });
        let error = result.expect_err("the bootstrap failed");
        assert_eq!(error.code(), "ERR_VERIFY_BOOTSTRAP_RUN");
        assert_eq!(
            error.details.actual,
            "exit 1: ERR_BOOTSTRAP_X: broke / Expected: y"
        );
        assert!(lines.contains(&"bootstrap: started".to_owned()));
        let kept = workspaces(tmp.path());
        assert_eq!(kept.len(), 1, "{kept:?}");
        let workspace = &kept[0];
        let clone = workspace.join("app");
        assert_eq!(
            seen.into_inner(),
            Some(clone.join("xtask").display().to_string())
        );
        assert_eq!(
            std::fs::read_to_string(clone.join("README.md")).expect("read"),
            "changed\n"
        );
        assert!(clone.join("new.txt").is_file());
        assert!(!clone.join("gone.txt").exists());
        let status = git(&clone, &["status", "--porcelain"]);
        assert_eq!(status, "", "the overlay is committed");

        // A bootstrap that changes nothing leaves a tree that is no app.
        let tmp = temp_dir();
        let (result, lines) = verify_at(root, &[], tmp.path(), &|_| RunResult::exited(0, "", ""));
        let error = result.expect_err("not an app");
        assert_eq!(error.code(), "ERR_VERIFY_BOOTSTRAP_PRODUCT_SECTION");
        assert!(
            error.details.summary.ends_with("(1 of 2)"),
            "{}",
            error.details.summary
        );
        assert!(
            lines
                .iter()
                .any(|line| line.starts_with("ERR_VERIFY_BOOTSTRAP_NAME_MISMATCH"))
        );
        assert!(workspaces(tmp.path()).is_empty());
    }

    #[test]
    fn reports_success_once_every_check_passes() {
        let app = app_tree();
        let repo = committed_repo();
        let root = repo.path();
        let tmp = temp_dir();
        // The fake bootstrap copies a finished app over the clone.
        let (result, lines) = verify_at(root, &[], tmp.path(), &|options| {
            let clone = options.cwd.clone().expect("a cwd");
            for entry in [
                "crates",
                "Cargo.toml",
                "Cargo.lock",
                "LICENSE",
                "CHANGELOG.md",
                "justfile",
                "AGENTS.md",
                ".agents",
                "docs",
            ] {
                let status = run_command(
                    "cp",
                    &[
                        "-R",
                        &app.path().join(entry).display().to_string(),
                        &clone.display().to_string(),
                    ],
                    &RunOptions::default(),
                );
                assert!(status.success(), "{}", status.stderr_text());
            }
            std::fs::write(clone.join("README.md"), "Tide Pool\n").expect("write");
            RunResult::exited(0, "", "")
        });
        result.expect("a finished app passes");
        assert!(
            lines
                .iter()
                .any(|line| line.starts_with("verify-bootstrap: bootstrapping a clone at "))
        );
        assert!(
            lines
                .last()
                .is_some_and(|line| line.starts_with("verify-bootstrap: ok"))
        );
    }
}
