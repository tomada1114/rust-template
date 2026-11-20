//! Every skill under `.claude/skills/`, the tree Claude Code loads, is well formed, and
//! `AGENTS.md`'s Skills table indexes exactly those skills. A skill with a stray key, a
//! mismatched name, or a value a strict YAML parser rejects looks fine and then
//! silently never loads; one with no row is never found by a reader.
//!
//! For each directory `.claude/skills/<dir>/`:
//! - `<dir>/SKILL.md` opens with a `---` line and a later `---` line closes the block; the
//!   block parses as YAML (duplicate keys rejected) into a mapping of `name`,
//!   `description`, and at most the optional Claude Code keys below. The parse is strict
//!   because a skill whose frontmatter does not load fails without an error: a skill
//!   found not to load gets a test and a rule here;
//! - the optional keys are a closed list, so a misspelled or unreviewed one fails:
//!   `paths` and `allowed-tools` are each a non-empty string or a non-empty list of
//!   non-empty strings, `disable-model-invocation` is `true` or `false`, and
//!   `argument-hint` is a non-empty string (quoted when it opens with `[`, which YAML
//!   otherwise reads as a list);
//! - `name` is a string equal to `<dir>`: lowercase letters, digits, and single hyphens,
//!   at most 64 characters (the Agent Skills format);
//! - `description` is a non-empty string of printable ASCII (tab and newline allowed), at
//!   most 500 characters once trailing whitespace is dropped, and neither value carries
//!   a trailing YAML comment (an unquoted ` #` silently cuts the value short);
//! - the descriptions of every skill in the tree together are at most 9,000 characters:
//!   the host lists them in one budget it shares with a person's own skills and plugins,
//!   and drops the descriptions that overflow it, after which a skill loads by name only;
//! - no file named `SKILL.md` exists below `<dir>/` other than `<dir>/SKILL.md`;
//! - the body after the closing `---` is at most 200 lines;
//! - nothing under `.claude/skills/` is a symbolic link (links are not followed).
//!
//! The index is the first table (lines starting with `|`) after `AGENTS.md`'s `## Skills`
//! heading and before the next heading, fenced code skipped; each row's first cell, with
//! backticks stripped, names one skill, and the rows and the directories must agree.
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` (no AGENTS.md or .claude/skills/),
//! `ERR_CHECK_INPUT_UNREADABLE` (.claude/skills is not a directory, or a path under it
//! cannot be read),
//! `ERR_CHECK_SKILL_FRONTMATTER`, `ERR_CHECK_SKILL_DESCRIPTION`, `ERR_CHECK_SKILL_LISTING`,
//! `ERR_CHECK_SKILL_NESTED`, `ERR_CHECK_SKILL_BODY`, `ERR_CHECK_SKILL_SYMLINK`,
//! `ERR_CHECK_SKILL_INDEX`.

use std::path::Path;

use super::yaml::{self, Keys, Node, Style, Yaml};
use super::{Input, finding, list_dir, read_file};
use crate::fail::FailureDetails;

const SKILLS: &str = ".claude/skills";
const MAX_DESCRIPTION: usize = 500;
const MAX_LISTING: usize = 9000;
/// The Claude Code keys a skill may carry beside `name` and `description`.
const OPTIONAL_KEYS: [&str; 4] = [
    "paths",
    "allowed-tools",
    "disable-model-invocation",
    "argument-hint",
];
const MAX_BODY_LINES: usize = 200;
const MAX_NAME: usize = 64;
const FIX_SKILL: &str = "fix the skill under .claude/skills/ (the authoring-skills skill)";

fn frontmatter_violation(dir: &str, actual: impl Into<String>) -> FailureDetails {
    finding(
        "ERR_CHECK_SKILL_FRONTMATTER",
        format!("{SKILLS}/{dir}/SKILL.md has a frontmatter that would not load as a skill"),
        format!(
            "a --- block of strict YAML holding `name: {dir}`, a non-empty string `description`, and no other key than {}",
            optional_keys()
        ),
        actual,
        FIX_SKILL,
    )
}

fn description_violation(dir: &str, actual: impl Into<String>) -> FailureDetails {
    finding(
        "ERR_CHECK_SKILL_DESCRIPTION",
        format!("{SKILLS}/{dir}/SKILL.md has a frontmatter value that would not load as written"),
        format!(
            "a printable-ASCII description of at most {MAX_DESCRIPTION} characters, and no YAML comment cutting a value short"
        ),
        actual,
        format!("{FIX_SKILL} (quote the value, or use `description: >`)"),
    )
}

fn optional_keys() -> String {
    OPTIONAL_KEYS
        .iter()
        .map(|key| format!("`{key}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn filled(node: &Node) -> bool {
    node.as_str().is_some_and(|text| !text.trim().is_empty())
}

/// What is wrong with the value of the optional key `key`, if anything.
fn optional_key_problem(key: &str, value: &Node) -> Option<String> {
    let shape = match key {
        "disable-model-invocation" => value.as_bool().is_none().then_some("`true` or `false`"),
        "argument-hint" => (!filled(value)).then_some("a non-empty string"),
        _ => {
            let items = value.items();
            let list = value.is_seq() && !items.is_empty() && items.iter().all(filled);
            (!filled(value) && !list)
                .then_some("a non-empty string or a non-empty list of non-empty strings")
        }
    }?;
    Some(format!("`{key}` is not {shape}"))
}

fn name_shape(name: &str) -> bool {
    name.split('-').all(|part| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
}

/// The `#…` comment in `text`: a `#` at its start or after whitespace, to the line's end.
fn comment_in(text: &str) -> Option<String> {
    let at = text.char_indices().find_map(|(at, c)| {
        (c == '#' && (at == 0 || text[..at].ends_with(char::is_whitespace))).then_some(at)
    })?;
    Some(text[at..].trim_end().to_owned())
}

/// The comment after a quoted value that opens at `start` (its quote) on `lines[first]`:
/// the text after the closing quote on its line. A double-quoted value skips `\`
/// escapes; a single-quoted one reads `''` as a quote. `None` when it never closes.
fn quoted_comment(lines: &[&str], first: usize, start: usize) -> Option<String> {
    let quote = lines[first][start..].chars().next()?;
    let mut from = start + quote.len_utf8();
    for (index, line) in lines.iter().enumerate().skip(first) {
        let mut chars = line[from..]
            .char_indices()
            .map(|(at, c)| (at + from, c))
            .peekable();
        while let Some((at, c)) = chars.next() {
            let escaped = (quote == '"' && c == '\\')
                || (quote == '\''
                    && c == quote
                    && chars.peek().is_some_and(|(_, next)| *next == '\''));
            if escaped {
                chars.next();
            } else if c == quote {
                return comment_in(&lines[index][at + c.len_utf8()..]);
            }
        }
        from = 0;
    }
    None
}

/// The comment a YAML parser would attach after a top-level block-mapping value, whose
/// key is on `lines[key]` and whose own lines end before `lines[end]`, or `None`. A
/// comment before the value (on the key's line with the value on a later one, or on its
/// own line) and one after a plain value's last line on its own line are not attached to
/// the value, and a `#` inside quotes or a block scalar's content is text.
fn value_comment(lines: &[&str], key: usize, end: usize, value: &Node) -> Option<String> {
    let region = lines.get(key..end.max(key + 1).min(lines.len()))?;
    let first = *region.first()?;
    let colon = first.find(':')? + 1;
    let rest = &first[colon..];
    match value.style {
        Style::Literal | Style::Folded => {
            let header = rest.find(['|', '>']).map_or(rest, |at| &rest[at + 1..]);
            comment_in(header)
        }
        Style::Quoted => {
            let (line, start) = std::iter::once((0, rest, colon))
                .chain(
                    region
                        .iter()
                        .enumerate()
                        .skip(1)
                        .map(|(index, line)| (index, *line, 0)),
                )
                .find_map(|(index, text, offset)| {
                    let trimmed = text.trim_start();
                    let start = text.len() - trimmed.len() + offset;
                    (trimmed.starts_with(['"', '\''])).then_some((index, start))
                })?;
            quoted_comment(region, line, start)
        }
        Style::Plain => {
            let mut started = false;
            for text in std::iter::once(rest).chain(region.iter().skip(1).copied()) {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.starts_with('#') {
                    if started {
                        return None;
                    }
                    continue;
                }
                started = true;
                if let Some(comment) = comment_in(text) {
                    return Some(comment);
                }
            }
            None
        }
        Style::Collection => None,
    }
}

/// Checks each frontmatter key, and returns the `name` and `description` values found.
fn key_violations<'a>(
    dir: &str,
    pairs: &'a [(Node, Node)],
    block: &[&str],
    flow: bool,
    violations: &mut Vec<FailureDetails>,
) -> (Option<&'a Node>, Option<&'a Node>) {
    let mut name = None;
    let mut description = None;
    for (index, (key, value)) in pairs.iter().enumerate() {
        let label = key.scalar_text().unwrap_or_else(|| key.to_json());
        if OPTIONAL_KEYS.contains(&label.as_str()) {
            violations.extend(
                optional_key_problem(&label, value)
                    .map(|problem| frontmatter_violation(dir, problem)),
            );
            continue;
        }
        if label != "name" && label != "description" {
            violations.push(frontmatter_violation(
                dir,
                format!(
                    "unexpected key `{label}` (beside `name` and `description`, only {} are allowed)",
                    optional_keys()
                ),
            ));
            continue;
        }
        // A flow mapping (`{name: x, description: y}`) shares its lines between keys, and
        // its values carry no comment this reads.
        let end = pairs
            .get(index + 1)
            .map_or(block.len(), |(next, _)| next.line - 1);
        let comment = if flow {
            None
        } else {
            value_comment(block, key.line - 1, end, value)
        };
        if let Some(comment) = comment {
            violations.push(description_violation(
                dir,
                format!("`{label}` is followed by a YAML comment (`{comment}`), which drops that text from the value"),
            ));
        }
        if label == "name" {
            name = Some(value);
        } else {
            description = Some(value);
        }
    }
    (name, description)
}

/// Checks one SKILL.md's frontmatter and body length, and returns with the violations
/// the length its description adds to the listing (0 when it has none to measure).
fn skill_file_violations(dir: &str, text: &str) -> (Vec<FailureDetails>, usize) {
    let mut listed = 0;
    let violations = frontmatter_and_body_violations(dir, text, &mut listed);
    (violations, listed)
}

fn frontmatter_and_body_violations(
    dir: &str,
    text: &str,
    listed: &mut usize,
) -> Vec<FailureDetails> {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.first() != Some(&"---") {
        return vec![frontmatter_violation(
            dir,
            "SKILL.md does not start with a `---` line",
        )];
    }
    let Some(close) = lines
        .iter()
        .skip(1)
        .position(|line| *line == "---")
        .map(|at| at + 1)
    else {
        return vec![frontmatter_violation(
            dir,
            "the frontmatter block is never closed with a `---` line",
        )];
    };

    let mut violations = Vec::new();
    let mut body = &lines[close + 1..];
    if body.last() == Some(&"") {
        body = &body[..body.len() - 1];
    }
    if body.len() > MAX_BODY_LINES {
        violations.push(finding(
            "ERR_CHECK_SKILL_BODY",
            format!("{SKILLS}/{dir}/SKILL.md is over the {MAX_BODY_LINES}-line body cap"),
            format!("at most {MAX_BODY_LINES} lines after the closing `---` (the target is 150)"),
            format!("{} lines", body.len()),
            "move tables, long examples, and edge cases into references/ (the authoring-skills skill)",
        ));
    }

    let block = &lines[1..close];
    let document = match yaml::parse(&block.join("\n"), Keys::Unique) {
        Ok(document) => document,
        Err(error) => {
            let mut found = vec![frontmatter_violation(
                dir,
                format!("the block does not parse as YAML: {}", error.message),
            )];
            found.extend(violations);
            return found;
        }
    };
    let flow = block
        .iter()
        .map(|line| line.trim())
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .is_some_and(|line| line.starts_with('{'));
    let Yaml::Map(pairs) = &document.root.value else {
        let mut found = vec![frontmatter_violation(
            dir,
            "the block is not a mapping of keys",
        )];
        found.extend(violations);
        return found;
    };

    let (name, description) = key_violations(dir, pairs, block, flow, &mut violations);
    violations.extend(name_violation(dir, name));
    violations.extend(description_violations(dir, description));
    *listed = description
        .and_then(Node::as_str)
        .map_or(0, description_length);
    violations
}

/// What is wrong with the frontmatter's `name`, if anything.
fn name_violation(dir: &str, name: Option<&Node>) -> Option<FailureDetails> {
    let problem = match name.map(Node::as_str) {
        None => "no `name` key".to_owned(),
        Some(None) => "`name` is not a string".to_owned(),
        Some(Some(name)) if name != dir => {
            format!("`name` is `{name}`, but the directory is `{dir}`")
        }
        Some(Some(name)) if !name_shape(name) || name.len() > MAX_NAME => format!(
            "`name` `{name}` is not lowercase letters, digits, and single hyphens of at most {MAX_NAME} characters"
        ),
        Some(Some(_)) => return None,
    };
    Some(frontmatter_violation(dir, problem))
}

/// A description's length as the caps count it: trailing whitespace dropped.
fn description_length(text: &str) -> usize {
    text.trim_end().encode_utf16().count()
}

/// The finding when the tree's descriptions together are over the listing cap: the total
/// and the longest ones, as (skill, length).
fn listing_violation(mut lengths: Vec<(String, usize)>) -> Option<FailureDetails> {
    let total: usize = lengths.iter().map(|(_, length)| length).sum();
    if total <= MAX_LISTING {
        return None;
    }
    lengths.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let longest: Vec<String> = lengths
        .iter()
        .take(5)
        .map(|(name, length)| format!("{name} ({length})"))
        .collect();
    Some(finding(
        "ERR_CHECK_SKILL_LISTING",
        format!(
            "the descriptions under {SKILLS}/ are together over the {MAX_LISTING}-character listing cap"
        ),
        format!(
            "at most {MAX_LISTING} characters of description across every skill, so the host's skill listing keeps each one"
        ),
        format!(
            "{total} characters in {} skills; the longest: {}",
            lengths.len(),
            longest.join(", ")
        ),
        "shorten the longest descriptions to what the skill covers and when to load it (the authoring-skills skill)",
    ))
}

/// What is wrong with the frontmatter's `description`.
fn description_violations(dir: &str, description: Option<&Node>) -> Vec<FailureDetails> {
    let mut found = Vec::new();
    match description.map(|value| value.as_str()) {
        None => found.push(frontmatter_violation(dir, "no `description` key")),
        Some(None) => found.push(frontmatter_violation(dir, "`description` is not a string")),
        Some(Some(text)) if text.trim().is_empty() => {
            found.push(frontmatter_violation(dir, "`description` is empty"));
        }
        Some(Some(text)) => {
            let text = text.trim_end();
            if text
                .chars()
                .any(|c| c != '\t' && c != '\n' && !(' '..='~').contains(&c))
            {
                found.push(description_violation(
                    dir,
                    "`description` holds a non-ASCII or non-printable character (an em dash or a curly quote, say)",
                ));
            }
            let length = description_length(text);
            if length > MAX_DESCRIPTION {
                found.push(description_violation(
                    dir,
                    format!("`description` is {length} characters"),
                ));
            }
        }
    }
    found
}

/// Every path under `dir` (root-relative), without following symbolic links: (path, is a
/// link, is a file).
fn walk(root: &Path, dir: &str) -> Vec<(String, bool, bool)> {
    let mut found = Vec::new();
    for (name, kind) in list_dir(root, dir) {
        let path = format!("{dir}/{name}");
        found.push((path.clone(), kind.is_symlink(), kind.is_file()));
        if kind.is_dir() {
            found.extend(walk(root, &path));
        }
    }
    found
}

fn symlink_violation(path: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_SKILL_SYMLINK",
        format!("{path} is a symbolic link"),
        "real files only under .claude/skills/ (git checks a link out as a link only where core.symlinks allows)",
        "a symbolic link",
        "replace the link with the file it points to",
    )
}

fn tree_violations(root: &Path, dir: &str) -> Vec<FailureDetails> {
    let top = format!("{SKILLS}/{dir}/SKILL.md");
    let mut violations = Vec::new();
    for (path, link, file) in walk(root, &format!("{SKILLS}/{dir}")) {
        if link {
            violations.push(symlink_violation(&path));
        } else if file && path.ends_with("/SKILL.md") && path != top {
            violations.push(finding(
                "ERR_CHECK_SKILL_NESTED",
                format!("{path} is a SKILL.md below a skill's top directory"),
                "SKILL.md only at .claude/skills/<dir>/SKILL.md, so a host never loads a second skill from a subdirectory",
                path.clone(),
                "rename the nested file for its content (references/<topic>.md)",
            ));
        }
    }
    violations
}

/// The Skills table's rows as (line, name), or `None` when there is no table.
fn index_rows(agents: &str) -> Option<Vec<(usize, String)>> {
    let lines: Vec<&str> = agents.split('\n').collect();
    let start = lines.iter().position(|line| {
        line.strip_prefix("## Skills")
            .is_some_and(|rest| rest.trim().is_empty())
    })?;
    let mut fenced = false;
    let mut rows: Option<Vec<(usize, String)>> = None;
    for (index, line) in lines.iter().enumerate().skip(start + 1) {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
        }
        if fenced {
            continue;
        }
        if line.starts_with('#') {
            break;
        }
        if !line.starts_with('|') {
            if rows.is_some() {
                break;
            }
            continue;
        }
        let Some(found) = rows.as_mut() else {
            rows = Some(Vec::new());
            continue;
        };
        if line
            .chars()
            .all(|c| matches!(c, '|' | ':' | '-') || c.is_whitespace())
        {
            continue;
        }
        let cell = line.split('|').nth(1).unwrap_or_default().replace('`', "");
        found.push((index + 1, cell.trim().to_owned()));
    }
    rows
}

fn index_violation(summary: String, actual: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_SKILL_INDEX",
        summary,
        "one row in AGENTS.md's Skills table per directory under .claude/skills/, and no other rows",
        actual,
        "add, rename, or remove the row in AGENTS.md's Skills table (or the skill directory) in the same commit",
    )
}

fn index_violations(agents: &str, dirs: &[String]) -> Vec<FailureDetails> {
    let Some(rows) = index_rows(agents) else {
        return vec![index_violation(
            "AGENTS.md has no Skills table".to_owned(),
            "no table under a `## Skills` heading",
        )];
    };
    let mut violations = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for (line, name) in &rows {
        let place = format!("AGENTS.md:{line}");
        if name.is_empty() {
            violations.push(index_violation(
                format!("{place}: a Skills table row has an empty first cell"),
                "an empty first cell",
            ));
        } else if seen.contains(&name.as_str()) {
            violations.push(index_violation(
                format!("{place}: `{name}` is indexed twice"),
                &format!("a second row for `{name}`"),
            ));
        } else if !dirs.contains(name) {
            violations.push(index_violation(
                format!("{place}: `{name}` has a row but no .claude/skills/{name}/"),
                "a row for a skill that does not exist",
            ));
        }
        seen.push(name);
    }
    for dir in dirs.iter().filter(|dir| !seen.contains(&dir.as_str())) {
        violations.push(index_violation(
            format!(".claude/skills/{dir}/ has no row, `{dir}`, in AGENTS.md's Skills table"),
            "a skill no row indexes",
        ));
    }
    violations
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let agents = read_file(input.root, "AGENTS.md");
    let skills_dir = input.root.join(SKILLS);
    let mut absent = Vec::new();
    if agents.is_none() {
        absent.push("AGENTS.md".to_owned());
    }
    let skills_kind = match std::fs::symlink_metadata(&skills_dir) {
        Ok(metadata) => Some(metadata.is_dir()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return vec![finding(
                "ERR_CHECK_INPUT_UNREADABLE",
                format!("{SKILLS} cannot be read"),
                format!("{SKILLS}/ to be a readable directory"),
                error.to_string(),
                format!("fix the permissions on {SKILLS}/"),
            )];
        }
    };
    if skills_kind.is_none() {
        absent.push(format!("{SKILLS}/"));
    }
    let (Some(agents), true) = (agents, absent.is_empty()) else {
        return vec![finding(
            "ERR_CHECK_INPUT_MISSING",
            format!("{} does not exist", absent.join(" and ")),
            "AGENTS.md and .claude/skills/ under the root",
            format!("missing: {}", absent.join(", ")),
            "run the check against the repository root (--root DIR)",
        )];
    };
    if skills_kind == Some(false) {
        return vec![finding(
            "ERR_CHECK_INPUT_UNREADABLE",
            format!("{SKILLS} is not a directory"),
            format!("{SKILLS}/ to be a directory holding one directory per skill"),
            "a file or a link",
            format!("restore {SKILLS}/ from version control"),
        )];
    }

    let mut entries: Vec<(String, bool)> = list_dir(input.root, SKILLS)
        .into_iter()
        .filter(|(_, kind)| kind.is_dir() || kind.is_symlink())
        .map(|(name, kind)| (name, kind.is_symlink()))
        .collect();
    entries.sort_by(|a, b| {
        a.0.to_lowercase()
            .cmp(&b.0.to_lowercase())
            .then(a.0.cmp(&b.0))
    });

    let mut violations = Vec::new();
    let mut lengths = Vec::new();
    for (name, link) in &entries {
        if *link {
            violations.push(symlink_violation(&format!("{SKILLS}/{name}")));
            continue;
        }
        match read_file(input.root, &format!("{SKILLS}/{name}/SKILL.md")) {
            None => violations.push(frontmatter_violation(name, "the directory has no SKILL.md")),
            Some(text) => {
                let (found, listed) = skill_file_violations(name, &text);
                violations.extend(found);
                lengths.push((name.clone(), listed));
            }
        }
        violations.extend(tree_violations(input.root, name));
    }
    violations.extend(listing_violation(lengths));
    let dirs: Vec<String> = entries.into_iter().map(|(name, _)| name).collect();
    violations.extend(index_violations(&agents, &dirs));
    violations
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::check_harness::test_support::{codes, run_at};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    fn skill(frontmatter: &str) -> String {
        format!("---\n{frontmatter}\n---\n\n# Title\n\nBody.\n")
    }

    fn index(rows: &[&str]) -> String {
        let rows: Vec<String> = rows
            .iter()
            .map(|row| format!("| {row} | Something |"))
            .collect();
        format!(
            "# Guide\n\n## Skills\n\nSkills live under `.claude/skills/`.\n\n| Skill | Load it for |\n|---|---|\n{}\n\n### Rules\n\n| Rule | Loads when you touch |\n|---|---|\n| `.claude/rules/rust.md` | Rust |\n\n## Next section\n",
            rows.join("\n")
        )
    }

    fn fixture(overrides: &[(&str, Option<&str>)]) -> tempfile::TempDir {
        let dir = temp_dir();
        let alpha =
            skill("name: alpha\ndescription: >\n  Covers alpha. Use when alpha\n  happens.");
        let beta = skill("name: \"beta\"\ndescription: \"Beta: quoted, with a colon.\" ");
        let agents = index(&["`alpha`", "`beta`"]);
        let mut files: Vec<(&str, Option<&str>)> = vec![
            ("AGENTS.md", Some(&agents)),
            (".claude/skills/alpha/SKILL.md", Some(&alpha)),
            (".claude/skills/beta/SKILL.md", Some(&beta)),
            (".claude/skills/beta/references/notes.md", Some("# Notes\n")),
        ];
        for (path, content) in overrides {
            files.retain(|(existing, _)| existing != path);
            files.push((path, *content));
        }
        for (path, content) in files {
            if let Some(content) = content {
                write(dir.path(), path, content);
            }
        }
        dir
    }

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<FailureDetails> {
        let dir = fixture(overrides);
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_on_well_formed_skills_indexed_once() {
        assert_eq!(check(&[]), []);
    }

    #[test]
    fn fails_on_each_frontmatter_fault() {
        for (content, actual) in [
            (
                skill("name: alpha\ndescription: x\nwhen_to_use: always"),
                "unexpected key `when_to_use`",
            ),
            (
                skill("name: alpha\ndescription: x\nmodel: opus"),
                "unexpected key `model`",
            ),
            (
                skill("name: alpha\ndescription: x\n? [a]\n: b"),
                "unexpected key `[\"a\"]`",
            ),
            (skill("name: alfa\ndescription: x"), "`name` is `alfa`"),
            (skill("description: x"), "no `name`"),
            (skill("name: alpha"), "no `description`"),
            (
                skill("name: alpha\ndescription: \"\""),
                "`description` is empty",
            ),
            (
                skill("name: alpha\ndescription: 42"),
                "`description` is not a string",
            ),
            (
                skill("name: [alpha]\ndescription: x"),
                "`name` is not a string",
            ),
            ("# Alpha\n".to_owned(), "does not start with a `---` line"),
            (
                "---\nname: alpha\ndescription: x\n".to_owned(),
                "never closed",
            ),
            (
                skill("name: alpha\ndescription: Use when: this"),
                "does not parse as YAML",
            ),
            (
                skill("name: alpha\nname: alpha\ndescription: x"),
                "does not parse as YAML",
            ),
            (skill("- alpha"), "not a mapping"),
        ] {
            let violations = check(&[(".claude/skills/alpha/SKILL.md", Some(&content))]);
            assert_eq!(
                codes(&violations),
                ["ERR_CHECK_SKILL_FRONTMATTER"],
                "{content}"
            );
            assert!(
                violations[0].actual.contains(actual),
                "{}",
                violations[0].actual
            );
        }
        let agents = index(&["`alpha`", "`beta`", "`Gamma_Skill`"]);
        let gamma = skill("name: Gamma_Skill\ndescription: x");
        let violations = check(&[
            ("AGENTS.md", Some(&agents)),
            (".claude/skills/Gamma_Skill/SKILL.md", Some(&gamma)),
        ]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_FRONTMATTER"]);
        assert!(
            violations[0]
                .actual
                .contains("lowercase letters, digits, and single hyphens")
        );
        let agents = index(&["`alpha`", "`beta`", "`empty`"]);
        let violations = check(&[
            ("AGENTS.md", Some(&agents)),
            (".claude/skills/empty/references/x.md", Some("x\n")),
        ]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_FRONTMATTER"]);
        assert!(violations[0].actual.contains("no SKILL.md"));
    }

    #[test]
    fn fails_on_a_description_that_would_not_load() {
        let content = skill("name: alpha\ndescription: Covers alpha \u{2014} and more.");
        assert_eq!(
            codes(&check(&[(".claude/skills/alpha/SKILL.md", Some(&content))])),
            ["ERR_CHECK_SKILL_DESCRIPTION"]
        );
        let at = skill(&format!(
            "name: alpha\ndescription: >\n  {}",
            "a".repeat(500)
        ));
        assert_eq!(check(&[(".claude/skills/alpha/SKILL.md", Some(&at))]), []);
        let over = skill(&format!(
            "name: alpha\ndescription: >\n  {}",
            "a".repeat(501)
        ));
        let violations = check(&[(".claude/skills/alpha/SKILL.md", Some(&over))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_DESCRIPTION"]);
        assert!(violations[0].actual.contains("501 characters"));
        for content in [
            skill("name: alpha\ndescription: Use it #now to see"),
            skill("name: alpha # the name\ndescription: x"),
            skill("name: alpha\ndescription: 'quoted' # gone"),
            skill("name: alpha\ndescription: > # gone\n  text"),
            skill("name: alpha\ndescription: a plain\n  value # gone"),
        ] {
            let violations = check(&[(".claude/skills/alpha/SKILL.md", Some(&content))]);
            assert_eq!(
                codes(&violations),
                ["ERR_CHECK_SKILL_DESCRIPTION"],
                "{content}"
            );
            assert!(violations[0].actual.contains("comment"));
        }
        let content = skill("name: alpha\ndescription: >\n  A # inside a block is text.");
        assert_eq!(
            check(&[(".claude/skills/alpha/SKILL.md", Some(&content))]),
            []
        );
    }

    #[test]
    fn passes_on_each_optional_claude_code_key() {
        for frontmatter in [
            "paths:\n  - \"crates/alpha/**\"\n  - \"xtask/**\"",
            "paths: crates/alpha/**, xtask/**",
            "allowed-tools: Read Grep",
            "allowed-tools:\n  - Read\n  - Bash(git status *)",
            "disable-model-invocation: true",
            "disable-model-invocation: false # asked for by name",
            "argument-hint: \"[issue-number]\"",
            "paths: [\"a/**\"]\nallowed-tools: Read\ndisable-model-invocation: true\nargument-hint: \"[n]\"",
        ] {
            let content = skill(&format!("name: alpha\ndescription: x\n{frontmatter}"));
            assert_eq!(
                check(&[(".claude/skills/alpha/SKILL.md", Some(&content))]),
                [],
                "{frontmatter}"
            );
        }
    }

    #[test]
    fn fails_on_an_optional_key_of_the_wrong_type() {
        for (frontmatter, actual) in [
            ("paths: 42", "`paths` is not"),
            ("paths: \"\"", "`paths` is not"),
            ("paths: []", "`paths` is not"),
            ("paths:\n  - src/**\n  - 42", "`paths` is not"),
            ("paths:\n  - src/**\n  - \" \"", "`paths` is not"),
            ("paths:\n  glob: src/**", "`paths` is not"),
            ("allowed-tools: true", "`allowed-tools` is not"),
            ("allowed-tools:\n  - [Read]", "`allowed-tools` is not"),
            (
                "disable-model-invocation: \"true\"",
                "`disable-model-invocation` is not `true` or `false`",
            ),
            (
                "disable-model-invocation: yes",
                "`disable-model-invocation` is not `true` or `false`",
            ),
            (
                "argument-hint: [issue-number]",
                "`argument-hint` is not a non-empty string",
            ),
            (
                "argument-hint: \"\"",
                "`argument-hint` is not a non-empty string",
            ),
        ] {
            let content = skill(&format!("name: alpha\ndescription: x\n{frontmatter}"));
            let violations = check(&[(".claude/skills/alpha/SKILL.md", Some(&content))]);
            assert_eq!(
                codes(&violations),
                ["ERR_CHECK_SKILL_FRONTMATTER"],
                "{frontmatter}"
            );
            assert!(
                violations[0].actual.contains(actual),
                "{frontmatter}: {}",
                violations[0].actual
            );
        }
    }

    #[test]
    fn fails_when_the_descriptions_together_pass_the_listing_cap() {
        let described = |length: usize| {
            skill(&format!(
                "name: {{name}}\ndescription: >\n  {}",
                "a".repeat(length)
            ))
        };
        let names: Vec<String> = (1..=17).map(|n| format!("full{n:02}")).collect();
        let listing = |last: usize| {
            let mut rows: Vec<String> = vec!["`alpha`".to_owned(), "`beta`".to_owned()];
            rows.extend(names.iter().map(|name| format!("`{name}`")));
            let rows: Vec<&str> = rows.iter().map(String::as_str).collect();
            let agents = index(&rows);
            let mut files: Vec<(String, String)> = vec![
                ("AGENTS.md".to_owned(), agents),
                (
                    ".claude/skills/alpha/SKILL.md".to_owned(),
                    described(250).replace("{name}", "alpha"),
                ),
                (
                    ".claude/skills/beta/SKILL.md".to_owned(),
                    described(last).replace("{name}", "beta"),
                ),
            ];
            files.extend(names.iter().map(|name| {
                (
                    format!(".claude/skills/{name}/SKILL.md"),
                    described(500).replace("{name}", name),
                )
            }));
            let overrides: Vec<(&str, Option<&str>)> = files
                .iter()
                .map(|(path, content)| (path.as_str(), Some(content.as_str())))
                .collect();
            check(&overrides)
        };
        assert_eq!(listing(250), []);
        let violations = listing(251);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_LISTING"]);
        assert!(
            violations[0].actual.contains("9001 characters"),
            "{}",
            violations[0].actual
        );
        assert!(violations[0].actual.contains("full01 (500)"));
    }

    #[test]
    fn reads_comments_only_where_a_yaml_parser_attaches_them() {
        let comment_of = |frontmatter: &str| {
            let content = skill(frontmatter);
            check(&[(".claude/skills/alpha/SKILL.md", Some(&content))])
                .into_iter()
                .find(|found| found.actual.contains("YAML comment"))
                .map(|found| found.actual)
        };
        for frontmatter in [
            "name: alpha\ndescription: \"Use when a lint fires,\n  even with #[allow] or #[expect].\"",
            "name: alpha\ndescription: \"it's #x\n  still text\"",
            "name: alpha\ndescription: 'it''s # text'",
            "name: alpha\ndescription: \"a \\\" # quoted\"",
            "name: alpha\ndescription: # a note before the value\n  Covers alpha.",
            "name: alpha\ndescription: Covers alpha.\n  # an own-line comment",
            "{name: alpha, description: Covers alpha.}",
            "{name: alpha,\n description: Covers alpha.}",
        ] {
            assert_eq!(comment_of(frontmatter), None, "{frontmatter}");
        }
        for (frontmatter, comment) in [
            ("name: \"alpha\" # it's\ndescription: x", "# it's"),
            (
                "name: alpha\ndescription: \"first\n  second\" # gone",
                "# gone",
            ),
            ("name: alpha\ndescription: 'a ''b''' # gone", "# gone"),
            ("name: alpha\ndescription:\n  text # gone", "# gone"),
        ] {
            let found = comment_of(frontmatter).unwrap_or_default();
            assert!(
                found.contains(&format!("(`{comment}`)")),
                "{frontmatter}: {found}"
            );
        }
    }

    #[test]
    fn fails_when_the_skills_path_or_a_skill_cannot_be_read() {
        let dir = temp_dir();
        let agents = index(&[]);
        write(dir.path(), "AGENTS.md", &agents);
        write(dir.path(), ".claude/skills", "not a directory\n");
        let found = run_at(dir.path(), run);
        assert_eq!(codes(&found), ["ERR_CHECK_INPUT_UNREADABLE"]);
        assert!(found[0].summary.contains("not a directory"), "{found:?}");

        let dir = fixture(&[]);
        let file = dir.path().join(".claude/skills/alpha/SKILL.md");
        let mut permissions = std::fs::metadata(&file).expect("metadata").permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o000);
        std::fs::set_permissions(&file, permissions).expect("chmod");
        // Root reads a mode-000 file, so the case holds only for an ordinary user.
        if std::fs::read(&file).is_err() {
            let found = run_at(dir.path(), run);
            assert!(
                codes(&found).contains(&"ERR_CHECK_INPUT_UNREADABLE".to_owned()),
                "{found:?}"
            );
        }
    }

    #[test]
    fn fails_on_a_nested_skill_and_a_long_body() {
        let nested = skill("name: alpha\ndescription: x");
        let violations = check(&[(".claude/skills/beta/references/SKILL.md", Some(&nested))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_NESTED"]);
        assert!(
            violations[0]
                .summary
                .contains(".claude/skills/beta/references/SKILL.md")
        );
        let body = |lines: usize| {
            (0..lines)
                .map(|i| format!("line {i}"))
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        };
        let at = format!("---\nname: alpha\ndescription: x\n---\n{}", body(200));
        assert_eq!(check(&[(".claude/skills/alpha/SKILL.md", Some(&at))]), []);
        let over = format!("---\nname: alpha\ndescription: x\n---\n{}", body(201));
        let violations = check(&[(".claude/skills/alpha/SKILL.md", Some(&over))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_BODY"]);
        assert!(violations[0].actual.contains("201 lines"));
        let bad = format!("---\nname: alpha\nname: x\n---\n{}", body(201));
        let violations = check(&[(".claude/skills/alpha/SKILL.md", Some(&bad))]);
        assert_eq!(
            codes(&violations),
            ["ERR_CHECK_SKILL_FRONTMATTER", "ERR_CHECK_SKILL_BODY"]
        );
    }

    #[test]
    fn fails_on_a_symlinked_file_or_skill_directory() {
        let dir = fixture(&[]);
        let root = dir.path();
        std::os::unix::fs::symlink(
            root.join(".claude/skills/beta/references/notes.md"),
            root.join(".claude/skills/alpha/link.md"),
        )
        .expect("link");
        let violations = run_at(root, run);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_SYMLINK"]);
        assert!(
            violations[0]
                .summary
                .contains(".claude/skills/alpha/link.md")
        );

        let agents = index(&["`alpha`", "`beta`", "`gamma`"]);
        let dir = fixture(&[("AGENTS.md", Some(&agents))]);
        let root = dir.path();
        std::os::unix::fs::symlink(
            root.join(".claude/skills/alpha"),
            root.join(".claude/skills/gamma"),
        )
        .expect("link");
        assert_eq!(codes(&run_at(root, run)), ["ERR_CHECK_SKILL_SYMLINK"]);
    }

    #[test]
    fn fails_when_the_index_and_the_directories_disagree() {
        let violations = check(&[("AGENTS.md", Some(&index(&["`alpha`"])))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_INDEX"]);
        assert!(violations[0].summary.contains("`beta`"));
        let agents = index(&["`alpha`", "`beta`", "`ghost`"]);
        let violations = check(&[("AGENTS.md", Some(&agents))]);
        let line = agents
            .split('\n')
            .position(|l| l.contains("ghost"))
            .expect("row")
            + 1;
        assert!(violations[0].summary.contains(&format!("AGENTS.md:{line}")));
        let violations = check(&[("AGENTS.md", Some(&index(&["`alpha`", "`beta`", "alpha"])))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_INDEX"]);
        assert!(violations[0].actual.contains("second row"));
        let violations = check(&[("AGENTS.md", Some(&index(&["`alpha`", "`beta`", " "])))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_INDEX"]);
        let none = "# Guide\n\n## Skills\n\nNone yet.\n\n## Rules\n\n| a | b |\n|---|---|\n| `alpha` | x |\n";
        let violations = check(&[("AGENTS.md", Some(none))]);
        assert_eq!(codes(&violations), ["ERR_CHECK_SKILL_INDEX"]);
        assert!(violations[0].actual.contains("no table"));
        let fenced = index(&["`alpha`", "`beta`"]).replace(
            "Skills live under",
            "```bash\n# a comment, not a heading\n```\n\nSkills live under",
        );
        assert_eq!(check(&[("AGENTS.md", Some(&fenced))]), []);
    }

    #[test]
    fn fails_when_an_input_is_missing() {
        assert_eq!(
            codes(&check(&[("AGENTS.md", None)])),
            ["ERR_CHECK_INPUT_MISSING"]
        );
        let dir = temp_dir();
        write(dir.path(), "AGENTS.md", index(&[]));
        assert_eq!(codes(&run_at(dir.path(), run)), ["ERR_CHECK_INPUT_MISSING"]);
    }
}
