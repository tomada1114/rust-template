//! The bundle identifier is one value in two places: `BUNDLE_IDENTIFIER` in
//! `crates/myapp-platform/src/paths.rs` (which names the app's data and log directories)
//! and the justfile's `bundle_id` variable (which `just logs` uses). A rename that misses
//! one leaves the app writing where the tools never look.
//!
//! The Rust const (`pub const BUNDLE_IDENTIFIER: &str = "…";`) and the justfile assignment
//! (`bundle_id := "…"`, either quote) are read as text: neither is a structured format.
//!
//! Errors: `ERR_CHECK_INPUT_MISSING`, `ERR_CHECK_BUNDLE_ID_UNPARSED`,
//! `ERR_CHECK_BUNDLE_ID_DIVERGED`.

use regex::Regex;

use super::{Input, finding, read_file};
use crate::fail::FailureDetails;

const PATHS: &str = "crates/myapp-platform/src/paths.rs";
const JUSTFILE: &str = "justfile";

/// The justfile's `bundle_id := "…"` (either quote, an optional trailing comment), as
/// the first such line assigns it.
pub(super) fn justfile_bundle_id(text: &str) -> Option<String> {
    text.split('\n').find_map(|line| {
        let rest = line.strip_prefix("bundle_id")?.trim_start();
        let rest = rest.strip_prefix(":=")?.trim_start();
        let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let body = &rest[1..];
        // The shortest value whose closing quote leaves only blanks and a comment.
        body.match_indices(quote).find_map(|(at, _)| {
            let after = body[at + 1..].trim_start();
            (after.is_empty() || after.starts_with('#')).then(|| body[..at].to_owned())
        })
    })
}

fn rust_bundle_id(text: &str) -> Option<String> {
    let pattern = Regex::new(
        r#"\bconst\s+BUNDLE_IDENTIFIER\s*:\s*&\s*(?:'static\s+)?str\s*=\s*"([^"\\]*)"\s*;"#,
    )
    .ok()?;
    pattern
        .captures(text)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_owned())
}

/// Where a bundle identifier is written: the file, the shape it is written in, and its reader.
type Site = (&'static str, &'static str, fn(&str) -> Option<String>);

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let sites: [Site; 2] = [
        (
            PATHS,
            "pub const BUNDLE_IDENTIFIER: &str = \"…\";",
            rust_bundle_id,
        ),
        (JUSTFILE, "bundle_id := \"…\"", justfile_bundle_id),
    ];
    let mut violations = Vec::new();
    let mut found: Vec<(&str, String)> = Vec::new();
    for (path, shape, read) in sites {
        match read_file(input.root, path) {
            None => violations.push(finding(
                "ERR_CHECK_INPUT_MISSING",
                format!("{path} does not exist"),
                format!("{path}, one of the bundle identifier's two sites"),
                "no such file",
                format!("restore {path} from version control, or update xtask/src/check_harness/bundle_identifier.rs if it moved"),
            )),
            Some(text) => match read(&text) {
                None => violations.push(finding(
                    "ERR_CHECK_BUNDLE_ID_UNPARSED",
                    format!("{path}: no bundle identifier could be read"),
                    format!("`{shape}` in {path}"),
                    "no such line, or not a string",
                    "restore the identifier in the shape Expected names, or update xtask/src/check_harness/bundle_identifier.rs's reader in the same change",
                )),
                Some(value) => found.push((path, value)),
            },
        }
    }
    let distinct = found.iter().any(|(_, value)| *value != found[0].1);
    if violations.is_empty() && distinct {
        violations.push(finding(
            "ERR_CHECK_BUNDLE_ID_DIVERGED",
            "the bundle identifier differs between its two sites",
            "one identifier in BUNDLE_IDENTIFIER and the justfile's bundle_id",
            found
                .iter()
                .map(|(path, value)| format!("{path}: {value}"))
                .collect::<Vec<_>>()
                .join("; "),
            "set both to the same value in one commit (the bootstrap rewrites both for a new app); changing an app's identifier moves its data and log directories, an ADR decision",
        ));
    }
    violations
}

#[cfg(test)]
mod tests {
    use super::{JUSTFILE, PATHS, justfile_bundle_id, run};
    use crate::check_harness::test_support::{codes, run_at};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const ID: &str = "com.example.myapp";

    fn paths_rs(id: &str) -> String {
        format!(
            "//! Where the app keeps its files.\n\n/// The bundle identifier.\npub const BUNDLE_IDENTIFIER: &str = \"{id}\";\n"
        )
    }

    fn justfile(line: &str) -> String {
        format!(
            "set shell := [\"bash\", \"-euo\", \"pipefail\", \"-c\"]\n\n{line}\nlog_dir := env(\"HOME\", \"\") / \"Library/Logs\" / bundle_id\n"
        )
    }

    fn check(paths: Option<&str>, just: Option<&str>) -> Vec<FailureDetails> {
        let dir = temp_dir();
        if let Some(text) = paths {
            write(dir.path(), PATHS, text);
        }
        if let Some(text) = just {
            write(dir.path(), JUSTFILE, text);
        }
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_when_the_sites_agree() {
        let just = justfile(&format!("bundle_id := \"{ID}\""));
        assert_eq!(check(Some(&paths_rs(ID)), Some(&just)), []);
    }

    #[test]
    fn fails_when_either_site_differs() {
        let just = justfile(&format!("bundle_id := \"{ID}\""));
        let violations = check(Some(&paths_rs("com.example.app")), Some(&just));
        assert_eq!(codes(&violations), ["ERR_CHECK_BUNDLE_ID_DIVERGED"]);
        assert!(
            violations[0]
                .actual
                .contains(&format!("{PATHS}: com.example.app"))
        );
        assert!(violations[0].actual.contains(&format!("{JUSTFILE}: {ID}")));
        let violations = check(
            Some(&paths_rs(ID)),
            Some(&justfile("bundle_id := 'com.example.x' # renamed")),
        );
        assert_eq!(codes(&violations), ["ERR_CHECK_BUNDLE_ID_DIVERGED"]);
        assert!(
            violations[0]
                .actual
                .contains(&format!("{JUSTFILE}: com.example.x"))
        );
    }

    #[test]
    fn fails_when_a_site_holds_no_readable_identifier_or_is_missing() {
        let just = justfile(&format!("bundle_id := \"{ID}\""));
        let unreadable = format!("pub const BUNDLE_ID: &str = \"{ID}\";\n");
        let violations = check(Some(&unreadable), Some(&just));
        assert_eq!(codes(&violations), ["ERR_CHECK_BUNDLE_ID_UNPARSED"]);
        assert!(violations[0].summary.contains(PATHS));
        let violations = check(Some(&paths_rs(ID)), Some(&format!("bundle := \"{ID}\"\n")));
        assert_eq!(codes(&violations), ["ERR_CHECK_BUNDLE_ID_UNPARSED"]);
        assert_eq!(
            codes(&check(None, Some(&just))),
            ["ERR_CHECK_INPUT_MISSING"]
        );
        assert_eq!(
            codes(&check(Some(&paths_rs(ID)), None)),
            ["ERR_CHECK_INPUT_MISSING"]
        );
    }

    #[test]
    fn reads_the_justfile_assignment_in_either_quote() {
        assert_eq!(
            justfile_bundle_id("bundle_id := \"a.b\"\n").as_deref(),
            Some("a.b")
        );
        assert_eq!(
            justfile_bundle_id("bundle_id:='a\"b' # c\n").as_deref(),
            Some("a\"b")
        );
        assert_eq!(
            justfile_bundle_id("bundle_id := \"a\" b\"\n").as_deref(),
            Some("a\" b")
        );
        assert_eq!(justfile_bundle_id("bundle_id := \"a\" x\n"), None);
        assert_eq!(justfile_bundle_id("bundle_id := a\n"), None);
        assert_eq!(justfile_bundle_id(" bundle_id := \"a\"\n"), None);
    }
}
