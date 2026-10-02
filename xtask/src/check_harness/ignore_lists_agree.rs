//! The tools that read the tree agree on skipping `.claude/skills/` and on reading
//! `.agents/skills/`. The mirror is a generated, byte-identical copy (`just agents-sync`):
//! checking it reports every finding twice, at a path nobody may edit, and a formatter
//! rewriting the copy alone is drift the mirror check must undo. The opposite ignore is
//! worse — a skill's real files checked nowhere, with CI green.
//!
//! Read (all required but `package.json`):
//! - `.prettierignore`: its lines in order, a later `!` line re-including what an earlier
//!   one excluded;
//! - `typos.toml`: `[files] extend-exclude` (the `toml` crate);
//! - `vitest.config.ts`: the string literals of its `include: [...]` and `exclude: [...]`
//!   lists, split into the `coverage: { ... }` object's and the rest (the test projects'),
//!   plus any `--coverage.include` in `package.json`'s scripts. Vitest skips the mirror
//!   when no test include reaches a test file in it and no coverage include reaches a
//!   source file in it, or an exclude of the same kind removes that file; a `**` is taken
//!   to reach dot-directories, the cautious reading. It skips the source when an exclude
//!   names `.agents/skills/` or a directory containing it.
//!
//! The linter's ignores (`eslint.config.mjs`) are not compared: `ESLint` leaves with the
//! Node toolchain, so the check keeps only the tools that stay in step.
//!
//! An entry excludes a directory when, with a leading `/`, `./`, or `**/` and a trailing
//! `/`, `/*`, or `/**` removed, it names that directory or one containing it
//! (`.claude/skills/**` and `.claude/` both exclude `.claude/skills/`).
//!
//! Errors: `ERR_CHECK_INPUT_MISSING`, `ERR_CHECK_INPUT_UNREADABLE` (`typos.toml` or
//! `package.json` does not parse, `package.json` is not an object, `vitest.config.ts` has
//! no `include` or `exclude` list to read, or a glob does not compile),
//! `ERR_CHECK_IGNORE_MIRROR` (a tool reads the mirror),
//! `ERR_CHECK_IGNORE_SOURCE` (a tool skips the real skills).

use regex::Regex;

use super::{Input, finding, first_line, pattern, read_file};
use crate::fail::FailureDetails;

const MIRROR: &str = ".claude/skills";
const SOURCE: &str = ".agents/skills";
const FILES: [&str; 3] = [".prettierignore", "typos.toml", "vitest.config.ts"];

/// The directory an ignore entry names, with anchors and trailing globs removed.
fn entry_dir(entry: &str) -> &str {
    let mut named = entry.trim();
    while let Some(rest) = ["./", "/", "**/"]
        .iter()
        .find_map(|prefix| named.strip_prefix(prefix))
    {
        named = rest;
    }
    while let Some(rest) = ["/**", "/*"]
        .iter()
        .find_map(|suffix| named.strip_suffix(suffix))
    {
        named = rest;
    }
    named.trim_end_matches('/')
}

fn covers(entry: &str, dir: &str) -> bool {
    let named = entry_dir(entry);
    !named.is_empty()
        && (dir == named
            || dir
                .strip_prefix(named)
                .is_some_and(|rest| rest.starts_with('/')))
}

/// Whether a gitignore-style list, read in order, leaves `dir` excluded.
fn list_excludes(text: &str, dir: &str) -> bool {
    let mut excluded = false;
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(negated) = line.strip_prefix('!') {
            let named = entry_dir(negated);
            let nested = |outer: &str, inner: &str| {
                inner
                    .strip_prefix(outer)
                    .is_some_and(|rest| rest.starts_with('/'))
            };
            if named == dir || nested(dir, named) || nested(named, dir) {
                excluded = false;
            }
        } else if covers(line, dir) {
            excluded = true;
        }
    }
    excluded
}

/// The string literals of every `<key>: [...]` list in `source`.
fn literal_lists(source: &str, list: &Regex, literal: &Regex) -> Vec<String> {
    list.captures_iter(source)
        .filter_map(|found| found.get(1))
        .flat_map(|body| {
            literal
                .captures_iter(body.as_str())
                .filter_map(|found| {
                    found
                        .get(1)
                        .or_else(|| found.get(2))
                        .or_else(|| found.get(3))
                })
                .map(|text| text.as_str().to_owned())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// `path` with the leading dot of each segment dropped, so `**` reaches dot-directories.
fn undotted(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            let rest = segment.strip_prefix('.');
            match rest.and_then(|rest| rest.chars().next()) {
                Some(next) if next != '/' && next != '.' && next != '*' => &segment[1..],
                Some(_) | None => segment,
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The index of the `}` closing the `{` at `open`, if any.
fn brace_close(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (index, c) in chars.iter().enumerate().skip(open) {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

/// A glob class's content as a regex class's: a `-` between two other characters stays a
/// range, and each character a regex class would read as syntax (`&&`, `--`, `~~`, a
/// nested `[`, `^`, `\`) is escaped.
fn class_source(content: &[char]) -> String {
    let mut source = String::new();
    for (index, &c) in content.iter().enumerate() {
        let range = c == '-'
            && index > 0
            && index + 1 < content.len()
            && content[index - 1] != '-'
            && content[index + 1] != '-';
        if !range && ['\\', '[', ']', '&', '~', '-', '^'].contains(&c) {
            source.push('\\');
        }
        source.push(c);
    }
    source
}

/// A glob as a regex, the way Node's `path.matchesGlob` reads one: `**` as a whole segment
/// matches any number of segments (elsewhere it is `*`), `*` any text within one, `?` one
/// character in one, `{a,b}` either, and `[...]` a class. An unclosed `{` or `[` is a
/// literal character. The error is the regex's own when the result does not compile.
fn glob_regex(glob: &str) -> Result<Regex, String> {
    let chars: Vec<char> = glob.chars().collect();
    let mut source = String::from("^");
    let mut closes: Vec<usize> = Vec::new();
    let mut index = 0;
    while let Some(&c) = chars.get(index) {
        let at_start = index == 0 || chars.get(index - 1) == Some(&'/');
        match c {
            '*' if chars.get(index + 1) == Some(&'*') => {
                index += 2;
                let segment_end = matches!(chars.get(index), None | Some('/'));
                if at_start && segment_end && chars.get(index) == Some(&'/') {
                    index += 1;
                    source.push_str("(?:[^/]*/)*");
                } else if at_start && segment_end {
                    source.push_str(".*");
                } else {
                    source.push_str("[^/]*");
                }
                continue;
            }
            '*' => source.push_str("[^/]*"),
            '?' => source.push_str("[^/]"),
            '{' => match brace_close(&chars, index) {
                Some(close) => {
                    closes.push(close);
                    source.push_str("(?:");
                }
                None => source.push_str(&regex::escape("{")),
            },
            '}' if closes.last() == Some(&index) => {
                closes.pop();
                source.push(')');
            }
            ',' if !closes.is_empty() => source.push('|'),
            '[' => {
                let negated = chars.get(index + 1) == Some(&'!');
                let first = index + 1 + usize::from(negated);
                // The first character is content, so `[]]` is a class of `]`.
                let close = chars
                    .get(first + 1..)
                    .and_then(|rest| rest.iter().position(|&end| end == ']'))
                    .map(|at| at + first + 1);
                if let Some(close) = close {
                    source.push('[');
                    if negated {
                        source.push('^');
                    }
                    source.push_str(&class_source(&chars[first..close]));
                    source.push(']');
                    index = close + 1;
                    continue;
                }
                source.push_str(&regex::escape("["));
            }
            other => source.push_str(&regex::escape(&other.to_string())),
        }
        index += 1;
    }
    source.push('$');
    Regex::new(&source).map_err(|error| first_line(&error.to_string()).to_owned())
}

/// Each glob of `globs`, undotted and compiled; a glob that does not compile is an
/// unreadable `path`, never one that matches nothing.
fn compile(path: &str, globs: &[String]) -> Result<Vec<Regex>, FailureDetails> {
    globs
        .iter()
        .map(|glob| {
            glob_regex(&undotted(glob)).map_err(|error| {
                finding(
                    "ERR_CHECK_INPUT_UNREADABLE",
                    format!("a glob in {path} cannot be read"),
                    format!(
                        "every glob in {path} to compile, so the check can tell what it reaches"
                    ),
                    format!("`{glob}`: {error}"),
                    format!("fix the glob in {path}"),
                )
            })
        })
        .collect()
}

/// The patterns this check reads the configs with.
struct Patterns {
    include: Regex,
    exclude: Regex,
    literal: Regex,
    coverage: Regex,
    flag: Regex,
}

impl Patterns {
    fn new() -> Result<Self, FailureDetails> {
        Ok(Self {
            include: pattern(r"\binclude\s*:\s*\[([^\]]*)\]")?,
            exclude: pattern(r"\bexclude\s*:\s*\[([^\]]*)\]")?,
            literal: pattern(r#""([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`"#)?,
            coverage: pattern(r"\bcoverage\s*:\s*\{")?,
            flag: pattern(r#"--coverage\.include[= ](?:'([^']*)'|"([^"]*)"|(\S+))"#)?,
        })
    }
}

struct Globs {
    include: Vec<String>,
    exclude: Vec<String>,
}

/// Whether `file` is reached by an include glob and not removed by an exclude glob.
fn reached(file: &str, include: &[Regex], exclude: &[Regex]) -> bool {
    let file = undotted(file);
    let matches = |list: &[Regex]| list.iter().any(|pattern| pattern.is_match(&file));
    matches(include) && !matches(exclude)
}

/// The text of the `coverage: { ... }` object in a Vitest config, and the rest.
fn split_coverage(source: &str, coverage: &Regex) -> (String, String) {
    let Some(open) = coverage.find(source) else {
        return (String::new(), source.to_owned());
    };
    let start = open.end();
    let mut depth = 1;
    let mut end = start;
    for (offset, c) in source[start..].char_indices() {
        end = start + offset + c.len_utf8();
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            break;
        }
    }
    (
        source[start..end].to_owned(),
        format!("{}{}", &source[..open.start()], &source[end..]),
    )
}

fn globs(source: &str, patterns: &Patterns) -> Globs {
    Globs {
        include: literal_lists(source, &patterns.include, &patterns.literal),
        exclude: literal_lists(source, &patterns.exclude, &patterns.literal),
    }
}

fn mirror_violation(path: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_IGNORE_MIRROR",
        format!("{path} does not exclude {MIRROR}/"),
        format!(
            "Prettier, typos, and Vitest all to skip {MIRROR}/, the generated mirror of {SOURCE}/ (`just agents-sync`)"
        ),
        format!("{path} lets its tool read {MIRROR}/"),
        format!(
            "add `{MIRROR}/` to {path}'s ignore list (a gate change: the changing-gates skill)"
        ),
    )
}

fn source_violation(path: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_IGNORE_SOURCE",
        format!("{path} excludes {SOURCE}/, the skills' real files"),
        format!(
            "every tool to read {SOURCE}/, where the skills are authored, and skip only the mirror"
        ),
        format!("{path} skips {SOURCE}/"),
        format!("remove the entry that covers {SOURCE}/ from {path}; exclude {MIRROR}/ instead"),
    )
}

fn unreadable(path: &str, message: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_INPUT_UNREADABLE",
        format!("{path} does not parse"),
        format!("{path} to parse, so its ignore list can be read"),
        first_line(message),
        format!("fix {path}"),
    )
}

fn typos_excludes(text: &str) -> Result<Vec<String>, String> {
    let parsed = text
        .parse::<toml::Table>()
        .map_err(|error| error.to_string())?;
    let list = parsed
        .get("files")
        .and_then(|files| files.get("extend-exclude"))
        .and_then(toml::Value::as_array);
    Ok(list
        .map(|list| {
            list.iter()
                .filter_map(toml::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default())
}

/// Every `--coverage.include` value in `package.json`'s scripts.
fn coverage_includes(text: &str, flag: &Regex) -> Result<Vec<String>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(text).map_err(|error| error.to_string())?;
    if !parsed.is_object() {
        return Err("the document is JSON, but not an object".to_owned());
    }
    let commands = parsed
        .get("scripts")
        .and_then(serde_json::Value::as_object)
        .map(|scripts| {
            scripts
                .values()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(commands
        .into_iter()
        .flat_map(|command| {
            flag.captures_iter(command)
                .filter_map(|found| {
                    found
                        .get(1)
                        .or_else(|| found.get(2))
                        .or_else(|| found.get(3))
                })
                .map(|value| value.as_str().to_owned())
                .collect::<Vec<_>>()
        })
        .collect())
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let patterns = match Patterns::new() {
        Ok(patterns) => patterns,
        Err(invalid) => return vec![invalid],
    };
    let texts: Vec<Option<String>> = FILES
        .iter()
        .map(|path| read_file(input.root, path))
        .collect();
    let [Some(prettier), Some(typos), Some(vitest)] = texts.as_slice() else {
        let missing: Vec<&str> = FILES
            .iter()
            .zip(&texts)
            .filter(|(_, text)| text.is_none())
            .map(|(path, _)| *path)
            .collect();
        return vec![finding(
            "ERR_CHECK_INPUT_MISSING",
            format!("{} does not exist", missing.join(", ")),
            format!("{} at the root", FILES.join(", ")),
            format!("missing: {}", missing.join(", ")),
            "run the check against the repository root (--root DIR)",
        )];
    };
    let typos_excludes = match typos_excludes(typos) {
        Ok(list) => list,
        Err(message) => return vec![unreadable("typos.toml", &message)],
    };
    let coverage_flags = match read_file(input.root, "package.json")
        .map(|text| coverage_includes(&text, &patterns.flag))
    {
        None => Vec::new(),
        Some(Ok(list)) => list,
        Some(Err(message)) => return vec![unreadable("package.json", &message)],
    };
    let vitest = match read_vitest(vitest, &coverage_flags, &patterns) {
        Ok(vitest) => vitest,
        Err(invalid) => return vec![invalid],
    };
    // A test file Vitest would collect, and a source file its coverage would measure.
    let vitest_reads = |dir: &str| {
        reached(
            &format!("{dir}/probe/scripts/probe.test.ts"),
            &vitest.test_include,
            &vitest.test_exclude,
        ) || reached(
            &format!("{dir}/probe/scripts/probe.ts"),
            &vitest.coverage_include,
            &vitest.coverage_exclude,
        )
    };
    let mirror = [
        (".prettierignore", list_excludes(prettier, MIRROR)),
        (
            "typos.toml",
            typos_excludes.iter().any(|entry| covers(entry, MIRROR)),
        ),
        ("vitest.config.ts", !vitest_reads(MIRROR)),
        (
            "package.json",
            !reached(
                &format!("{MIRROR}/probe/scripts/probe.ts"),
                &vitest.flag_include,
                &vitest.coverage_exclude,
            ),
        ),
    ];
    let source = [
        (".prettierignore", list_excludes(prettier, SOURCE)),
        (
            "typos.toml",
            typos_excludes.iter().any(|entry| covers(entry, SOURCE)),
        ),
        (
            "vitest.config.ts",
            vitest.excludes.iter().any(|entry| covers(entry, SOURCE)),
        ),
    ];
    let mut violations: Vec<FailureDetails> = mirror
        .iter()
        .filter(|(_, excluded)| !excluded)
        .map(|(path, _)| mirror_violation(path))
        .collect();
    violations.extend(
        source
            .iter()
            .filter(|(_, excluded)| *excluded)
            .map(|(path, _)| source_violation(path)),
    );
    violations
}

/// What Vitest reads: every exclude as written, and each list compiled.
struct Vitest {
    excludes: Vec<String>,
    test_include: Vec<Regex>,
    test_exclude: Vec<Regex>,
    coverage_include: Vec<Regex>,
    coverage_exclude: Vec<Regex>,
    flag_include: Vec<Regex>,
}

fn read_vitest(
    vitest: &str,
    coverage_flags: &[String],
    patterns: &Patterns,
) -> Result<Vitest, FailureDetails> {
    if !patterns.include.is_match(vitest) && !patterns.exclude.is_match(vitest) {
        return Err(finding(
            "ERR_CHECK_INPUT_UNREADABLE",
            "vitest.config.ts has no include or exclude list to read",
            "vitest.config.ts to name its globs in `include: [...]` and `exclude: [...]` lists of string literals",
            "no such list",
            "write the globs as literal lists, or change this check to read the new form",
        ));
    }
    let (coverage, projects) = split_coverage(vitest, &patterns.coverage);
    let collected = globs(&projects, patterns);
    let measured = globs(&coverage, patterns);
    Ok(Vitest {
        test_include: compile("vitest.config.ts", &collected.include)?,
        test_exclude: compile("vitest.config.ts", &collected.exclude)?,
        coverage_include: compile("vitest.config.ts", &measured.include)?,
        coverage_exclude: compile("vitest.config.ts", &measured.exclude)?,
        flag_include: compile("package.json", coverage_flags)?,
        excludes: collected
            .exclude
            .into_iter()
            .chain(measured.exclude)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::{glob_regex, run, undotted};
    use crate::check_harness::test_support::{codes, run_at, summaries};
    use crate::test_support::{temp_dir, write};

    const PRETTIERIGNORE: &str = "dist/\n# The generated mirror\n.claude/skills/\n*.md\n";
    const TYPOS: &str =
        "[files]\nextend-exclude = [\n  \"Cargo.lock\",\n  \".claude/skills/\",\n]\n";
    const VITEST: &str = r#"import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.ts", ".agents/skills/*/scripts/**/*.test.ts"],
          exclude: ['**/fixtures/**'],
        },
      },
    ],
    coverage: {
      include: ["scripts/**/*.{ts,tsx}", `.agents/skills/*/scripts/**/*.ts`],
      exclude: ["**/*.test.{ts,tsx}"],
      thresholds: { "scripts/**": { lines: 85 } },
    },
  },
});
"#;
    const PACKAGE: &str = r#"{
  "scripts": {
    "test:scripts": "vitest run --coverage --coverage.include='scripts/**/*.ts' --coverage.include=\".agents/skills/*/scripts/**/*.ts\"",
    "lint": "eslint ."
  }
}
"#;

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<crate::fail::FailureDetails> {
        let mut files: Vec<(&str, Option<&str>)> = vec![
            (".prettierignore", Some(PRETTIERIGNORE)),
            ("typos.toml", Some(TYPOS)),
            ("vitest.config.ts", Some(VITEST)),
            ("package.json", Some(PACKAGE)),
        ];
        for (path, content) in overrides {
            files.retain(|(existing, _)| existing != path);
            files.push((path, *content));
        }
        let dir = temp_dir();
        for (path, content) in files {
            if let Some(content) = content {
                write(dir.path(), path, content);
            }
        }
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_when_every_tool_excludes_the_mirror_and_none_the_source() {
        assert_eq!(check(&[]), []);
        assert_eq!(check(&[("package.json", None)]), []);
        for entry in [
            "/.claude/skills",
            ".claude/skills/**",
            ".claude/",
            "**/.claude/skills/*",
            "./.claude/skills",
        ] {
            assert_eq!(
                check(&[(".prettierignore", Some(&format!("{entry}\n")))]),
                [],
                "{entry}"
            );
        }
    }

    #[test]
    fn fails_when_a_tool_reads_the_mirror() {
        let found = check(&[(".prettierignore", Some("dist/\n.claude/skills-old/\n"))]);
        assert_eq!(
            summaries(&found),
            [".prettierignore does not exclude .claude/skills/"]
        );
        assert_eq!(codes(&found), ["ERR_CHECK_IGNORE_MIRROR"]);
        assert_eq!(
            codes(&check(&[(
                ".prettierignore",
                Some(".claude/skills/\n!.claude/skills/demo/\n")
            )])),
            ["ERR_CHECK_IGNORE_MIRROR"]
        );
        assert_eq!(
            check(&[(
                ".prettierignore",
                Some(".claude/skills/\n!.claude/other/\n")
            )]),
            []
        );
        let found = check(&[(
            "typos.toml",
            Some("[files]\nextend-exclude = [\"Cargo.lock\"]\n"),
        )]);
        assert_eq!(
            summaries(&found),
            ["typos.toml does not exclude .claude/skills/"]
        );
        assert_eq!(
            codes(&check(&[(
                "typos.toml",
                Some("[default]\nlocale = 'en'\n")
            )])),
            ["ERR_CHECK_IGNORE_MIRROR"]
        );
        let widened = VITEST.replace("\"scripts/**/*.test.ts\"", "\"**/*.test.ts\"");
        let found = check(&[("vitest.config.ts", Some(&widened))]);
        assert_eq!(
            summaries(&found),
            ["vitest.config.ts does not exclude .claude/skills/"]
        );
        let removed = widened.replace(
            "'**/fixtures/**'",
            "'**/fixtures/**', \".claude/skills/**\"",
        );
        assert_eq!(check(&[("vitest.config.ts", Some(&removed))]), []);
        let coverage = VITEST.replace("\"scripts/**/*.{ts,tsx}\"", "\"**/*.{ts,tsx}\"");
        assert_eq!(
            summaries(&check(&[("vitest.config.ts", Some(&coverage))])),
            ["vitest.config.ts does not exclude .claude/skills/"]
        );
        let package = PACKAGE.replace(
            "--coverage.include='scripts/**/*.ts'",
            "--coverage.include=**/*.ts",
        );
        let found = check(&[("package.json", Some(&package))]);
        assert_eq!(
            summaries(&found),
            ["package.json does not exclude .claude/skills/"]
        );
    }

    #[test]
    fn fails_when_a_tool_skips_the_source() {
        for (path, content) in [
            (
                ".prettierignore",
                format!("{PRETTIERIGNORE}.agents/skills/\n"),
            ),
            (
                "typos.toml",
                TYPOS.replace("\"Cargo.lock\",", "\"Cargo.lock\", \".agents/skills/**\","),
            ),
            (
                "vitest.config.ts",
                VITEST.replace("['**/fixtures/**']", "['**/fixtures/**', \".agents/**\"]"),
            ),
        ] {
            let found = check(&[(path, Some(&content))]);
            assert_eq!(codes(&found), ["ERR_CHECK_IGNORE_SOURCE"], "{path}");
            assert_eq!(
                summaries(&found),
                [format!(
                    "{path} excludes .agents/skills/, the skills' real files"
                )]
            );
        }
    }

    #[test]
    fn fails_on_a_missing_or_unreadable_input() {
        for path in [".prettierignore", "typos.toml", "vitest.config.ts"] {
            let found = check(&[(path, None)]);
            assert_eq!(codes(&found), ["ERR_CHECK_INPUT_MISSING"], "{path}");
            assert_eq!(found[0].actual, format!("missing: {path}"));
        }
        for (path, content) in [("typos.toml", "[files\n"), ("package.json", "{")] {
            assert_eq!(
                codes(&check(&[(path, Some(content))])),
                ["ERR_CHECK_INPUT_UNREADABLE"],
                "{path}"
            );
        }
        for (path, content) in [
            ("package.json", "[]"),
            ("package.json", "null"),
            ("vitest.config.ts", "export default {};\n"),
        ] {
            let found = check(&[(path, Some(content))]);
            assert_eq!(
                codes(&found),
                ["ERR_CHECK_INPUT_UNREADABLE"],
                "{path} {content}"
            );
        }
        let huge = format!("\"{}\"", "?".repeat(100_000));
        for (path, content) in [
            (
                "vitest.config.ts",
                VITEST.replace("'**/fixtures/**'", &huge),
            ),
            (
                "package.json",
                PACKAGE.replace("'scripts/**/*.ts'", &huge.replace('"', "'")),
            ),
        ] {
            let found = check(&[(path, Some(&content))]);
            assert_eq!(codes(&found), ["ERR_CHECK_INPUT_UNREADABLE"], "{path}");
            assert_eq!(found[0].summary, format!("a glob in {path} cannot be read"));
        }
    }

    #[test]
    fn reads_globs_as_node_does() {
        for (glob, path, matches) in [
            ("**/*.test.ts", "a/b/c.test.ts", true),
            ("**/*.test.ts", "c.test.ts", true),
            ("scripts/**/*.ts", "scripts/x.ts", true),
            ("scripts/**/*.ts", "other/x.ts", false),
            ("scripts/*.ts", "scripts/a/x.ts", false),
            ("a/**", "a/b/c", true),
            ("*.{ts,tsx}", "x.tsx", true),
            ("*.{ts,tsx}", "x.js", false),
            ("x?.ts", "x1.ts", true),
            ("[ab].ts", "a.ts", true),
            ("[!ab].ts", "a.ts", false),
            ("a.b", "axb", false),
        ] {
            assert_eq!(
                glob_regex(glob).is_ok_and(|pattern| pattern.is_match(path)),
                matches,
                "{glob} {path}"
            );
        }
        for (glob, path, matches) in [
            // `**` is a globstar only as a whole segment.
            ("**.ts", "a/b.ts", false),
            ("**.ts", "b.ts", true),
            ("a/x**/b", "a/x/y/b", false),
            ("a/x**/b", "a/xyz/b", true),
            // A class's content is characters, never a regex class operator.
            ("[a&&b].ts", "&.ts", true),
            ("[a--b].ts", "-.ts", true),
            ("[a~~b].ts", "~.ts", true),
            ("[[a].ts", "[.ts", true),
            ("[a-c].ts", "b.ts", true),
            ("[a-c].ts", "-.ts", false),
            ("[]].ts", "].ts", true),
            ("[^a].ts", "^.ts", true),
            // An unclosed `{` or `[` is a literal character.
            ("{a,b", "{a,b", true),
            ("[ab", "[ab", true),
            ("{a,{b,c}}.ts", "c.ts", true),
        ] {
            assert_eq!(
                glob_regex(glob).is_ok_and(|pattern| pattern.is_match(path)),
                matches,
                "{glob} {path}"
            );
        }
        let error = glob_regex(&"?".repeat(100_000)).expect_err("too large to compile");
        assert!(!error.is_empty());
        assert_eq!(
            undotted(".claude/skills/.x/..y/.*"),
            "claude/skills/x/..y/.*"
        );
    }
}
