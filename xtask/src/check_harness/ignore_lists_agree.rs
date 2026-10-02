//! The tools that read the whole tree skip `.claude/skills/` and read `.agents/skills/`.
//! The mirror is a generated, byte-identical copy (`just agents-sync`): checking it reports
//! every finding twice, at a path nobody may edit. The opposite ignore is worse — a
//! skill's real files checked nowhere, with CI green.
//!
//! Read (required): `typos.toml`'s `[files] extend-exclude` (the `toml` crate), the one
//! tree-wide ignore list left once the Node toolchain (Prettier, `ESLint`, Vitest) went.
//! The other tools that read skills — the skills' Python suites and shellcheck in `just
//! test-scripts`, the skills mirror check — name `.agents/skills/` paths explicitly, so
//! they have no ignore list to compare.
//!
//! An entry excludes a directory when, with a leading `/`, `./`, or `**/` and a trailing
//! `/`, `/*`, or `/**` removed, it names that directory or one containing it
//! (`.claude/skills/**` and `.claude/` both exclude `.claude/skills/`).
//!
//! Errors: `ERR_CHECK_INPUT_MISSING`, `ERR_CHECK_INPUT_UNREADABLE` (`typos.toml` does not
//! parse), `ERR_CHECK_IGNORE_MIRROR` (a tool reads the mirror),
//! `ERR_CHECK_IGNORE_SOURCE` (a tool skips the real skills).

use super::{Input, finding, first_line, read_file};
use crate::fail::FailureDetails;

const MIRROR: &str = ".claude/skills";
const SOURCE: &str = ".agents/skills";
const TYPOS: &str = "typos.toml";

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

fn mirror_violation(path: &str) -> FailureDetails {
    finding(
        "ERR_CHECK_IGNORE_MIRROR",
        format!("{path} does not exclude {MIRROR}/"),
        format!("typos to skip {MIRROR}/, the generated mirror of {SOURCE}/ (`just agents-sync`)"),
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

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let Some(typos) = read_file(input.root, TYPOS) else {
        return vec![finding(
            "ERR_CHECK_INPUT_MISSING",
            format!("{TYPOS} does not exist"),
            format!("{TYPOS} at the root"),
            format!("missing: {TYPOS}"),
            "run the check against the repository root (--root DIR)",
        )];
    };
    let excludes = match typos_excludes(&typos) {
        Ok(list) => list,
        Err(message) => {
            return vec![finding(
                "ERR_CHECK_INPUT_UNREADABLE",
                format!("{TYPOS} does not parse"),
                format!("{TYPOS} to parse, so its ignore list can be read"),
                first_line(&message),
                format!("fix {TYPOS}"),
            )];
        }
    };
    let mut violations = Vec::new();
    if !excludes.iter().any(|entry| covers(entry, MIRROR)) {
        violations.push(mirror_violation(TYPOS));
    }
    if excludes.iter().any(|entry| covers(entry, SOURCE)) {
        violations.push(source_violation(TYPOS));
    }
    violations
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::check_harness::test_support::{codes, run_at, summaries};
    use crate::test_support::{temp_dir, write};

    const TYPOS: &str =
        "[files]\nextend-exclude = [\n  \"Cargo.lock\",\n  \".claude/skills/\",\n]\n";

    fn check(typos: Option<&str>) -> Vec<crate::fail::FailureDetails> {
        let dir = temp_dir();
        if let Some(content) = typos {
            write(dir.path(), "typos.toml", content);
        }
        run_at(dir.path(), run)
    }

    fn excluding(entries: &str) -> String {
        format!("[files]\nextend-exclude = [{entries}]\n")
    }

    #[test]
    fn passes_when_typos_excludes_the_mirror_and_not_the_source() {
        assert_eq!(check(Some(TYPOS)), []);
        for entry in [
            "/.claude/skills",
            ".claude/skills/**",
            ".claude/",
            "**/.claude/skills/*",
            "./.claude/skills",
        ] {
            assert_eq!(
                check(Some(&excluding(&format!("\"{entry}\"")))),
                [],
                "{entry}"
            );
        }
    }

    #[test]
    fn fails_when_typos_reads_the_mirror() {
        for typos in [
            excluding("\"Cargo.lock\""),
            excluding("\".claude/skills-old/\""),
            excluding("\"\""),
            "[default]\nlocale = 'en'\n".to_owned(),
        ] {
            let found = check(Some(&typos));
            assert_eq!(codes(&found), ["ERR_CHECK_IGNORE_MIRROR"], "{typos}");
            assert_eq!(
                summaries(&found),
                ["typos.toml does not exclude .claude/skills/"]
            );
        }
    }

    #[test]
    fn fails_when_typos_skips_the_source() {
        for entry in [
            "\".agents/skills/**\"",
            "\".agents/\"",
            "\"/.agents/skills\"",
        ] {
            let found = check(Some(&excluding(&format!("\".claude/skills/\", {entry}"))));
            assert_eq!(codes(&found), ["ERR_CHECK_IGNORE_SOURCE"], "{entry}");
            assert_eq!(
                summaries(&found),
                ["typos.toml excludes .agents/skills/, the skills' real files"]
            );
        }
        assert_eq!(
            codes(&check(Some(&excluding("\".agents/\"")))),
            ["ERR_CHECK_IGNORE_MIRROR", "ERR_CHECK_IGNORE_SOURCE"]
        );
        assert_eq!(
            check(Some(&excluding(
                "\".claude/skills/\", \".agents/skillsets/\""
            ))),
            []
        );
    }

    #[test]
    fn fails_on_a_missing_or_unreadable_typos_toml() {
        let found = check(None);
        assert_eq!(codes(&found), ["ERR_CHECK_INPUT_MISSING"]);
        assert_eq!(found[0].actual, "missing: typos.toml");
        assert_eq!(
            codes(&check(Some("[files\n"))),
            ["ERR_CHECK_INPUT_UNREADABLE"]
        );
    }
}
