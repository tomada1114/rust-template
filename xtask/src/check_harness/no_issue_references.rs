//! No reference to this repository's issues or pull requests in a document an agent reads
//! as standing instructions. An agent reading "see #139" cannot open the issue offline,
//! and a repository cut from the template has different issues under the same numbers, so
//! the text states the rule and its reason itself instead of pointing at one.
//!
//! Read: [`super::documents::standing_documents`], every line (prose, code spans, code
//! blocks, and YAML alike). Not read: a skill's scripts and tests, which are code, and the
//! planning and decision records in [`super::documents::UNCHECKED_DOCUMENTS`].
//!
//! A reference is any of:
//! - `#` then digits, bare (`#139`) or after this repository's owner/repo
//!   (`<owner>/<repo>#7`). After another owner/repo (`tauri-apps/tauri#7`) it is an
//!   upstream project's, and is not a reference, the same as its URL below;
//! - an issue, pull-request, or merge-request URL (`…/issues/139`, `…/pull/12`) on this
//!   repository or relative to it. An upstream project's (another owner/repo on
//!   github.com, or another host) is a source for an external claim and is not a
//!   reference. This repository's owner/repo is read from
//!   `.github/ISSUE_TEMPLATE/config.yml`, which the bootstrap rewrites; when it cannot be
//!   read the check fails rather than guess;
//! - the word issue, PR, pull request, or merge request before a number (`issue 166`,
//!   `PR-4`, `issue number 12`, `issue no. 12`);
//! - `GH-` then digits (`GH-12`);
//! - a `gh issue` or `gh pr` command given a number (`gh issue view 19`, `gh pr checks 12`).
//!
//! Not a reference: a Markdown link anchor (`#4-review-the-branch`, where a letter or `-`
//! follows the digits), an HTML entity (`&#123;`), a six- or eight-digit hex color
//! (`#000000`), a three- or four-digit one followed by `;` (`color: #000;`), and a
//! placeholder (`#N`, `issue <n>`, `gh issue view {n}`). Every document is optional.
//!
//! Errors: `ERR_CHECK_INPUT_MISSING` and `ERR_CHECK_INPUT_UNREADABLE` (this repository's
//! owner/repo cannot be read), `ERR_CHECK_ISSUE_REFERENCE`.

use regex::Regex;

use super::documents::{Repository, repository, standing_documents};
use super::{Input, finding, pattern, read_file};
use crate::fail::FailureDetails;

/// `\w` as JavaScript reads it.
fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn owner_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-'
}

fn repo_char(c: char) -> bool {
    word(c) || c == '.' || c == '-'
}

/// Whether `owner/name` is this repository; GitHub matches both case-insensitively.
fn is_own_repository(owner: &str, name: &str, own: &Repository) -> bool {
    owner.eq_ignore_ascii_case(&own.owner) && name.eq_ignore_ascii_case(&own.name)
}

/// The start of the longest run at the end of `text` whose chars pass `keep`.
fn run_start(text: &str, keep: fn(char) -> bool) -> usize {
    text.char_indices()
        .rev()
        .take_while(|(_, c)| keep(*c))
        .last()
        .map_or(text.len(), |(at, _)| at)
}

/// Every `#` and digits on the line (with the owner/repo before it, when there is one),
/// as (start, text), leaving out colors and other repositories' references.
fn hash_references(line: &str, own: &Repository) -> Vec<(usize, String)> {
    let mut found = Vec::new();
    let mut consumed = 0;
    for (hash, _) in line.match_indices('#') {
        let after = &line[hash + 1..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        let rest = &after[digits..];
        if digits == 0
            || line[..hash].ends_with('&')
            || rest.starts_with(|c: char| word(c) || c == '-')
        {
            continue;
        }
        let end = hash + 1 + digits;
        // An owner/repo prefix: `<owner>/<repo>` right before the `#`, with no path or
        // name character running into the owner.
        let before = &line[consumed..hash];
        let repo_at = run_start(before, repo_char);
        let prefix = before[..repo_at].strip_suffix('/').and_then(|head| {
            let owner_at = run_start(head, owner_char);
            let owner = &head[owner_at..];
            let clear = !head[..owner_at].ends_with(|c: char| repo_char(c) || c == '/');
            (repo_at < before.len() && !owner.is_empty() && clear)
                .then(|| (owner_at + consumed, owner, &before[repo_at..]))
        });
        if let Some((start, owner, name)) = prefix {
            if is_own_repository(owner, name, own) {
                found.push((start, line[start..end].to_owned()));
            }
        } else {
            let color = digits == 6
                || digits == 8
                || ((digits == 3 || digits == 4) && rest.starts_with(';'));
            if !color {
                found.push((hash, line[hash..end].to_owned()));
            }
        }
        consumed = end;
    }
    found
}

/// Whether an issue or pull-request URL points at this repository: a github.com URL whose
/// owner/repo is this one, or a relative link, which GitHub resolves against this one.
fn is_own_url(url: &str, own: &Repository) -> bool {
    let after_scheme = url
        .split_once("://")
        .filter(|(scheme, _)| {
            scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        })
        .map(|(_, rest)| rest)
        .or_else(|| url.strip_prefix("//"));
    let hosted = |text: &str| -> Option<(String, String, String)> {
        let mut parts = text.splitn(4, '/');
        let host = parts.next()?;
        let owner = parts.next()?;
        let name = parts.next()?;
        parts.next()?;
        let labels: Vec<&str> = host.split('.').collect();
        let (last, rest) = labels.split_last()?;
        let host_ok = !rest.is_empty()
            && rest
                .iter()
                .all(|label| !label.is_empty() && label.chars().all(owner_char))
            && last.len() >= 2
            && last.chars().all(|c| c.is_ascii_alphabetic());
        (host_ok && !owner.is_empty() && !name.is_empty())
            .then(|| (host.to_owned(), owner.to_owned(), name.to_owned()))
    };
    let Some((host, owner, name)) = after_scheme.and_then(hosted).or_else(|| hosted(url)) else {
        return true;
    };
    let host = host.to_lowercase();
    (host == "github.com" || host == "www.github.com") && is_own_repository(&owner, &name, own)
}

const URL_MARKERS: [&str; 5] = [
    "/issues/",
    "/pulls/",
    "/pull/",
    "/-/merge_requests/",
    "/merge_requests/",
];

fn url_excluded(c: char) -> bool {
    c.is_whitespace() || matches!(c, '(' | ')' | '<' | '>' | '[' | ']' | '"' | '\'' | '`')
}

/// Each URL, absolute or relative, whose path ends in an issue or pull-request number, as
/// (start, text): the run of URL characters up to the last such number in it.
fn issue_urls(line: &str) -> Vec<(usize, String)> {
    let mut found = Vec::new();
    let mut start = None;
    let bounds: Vec<(usize, usize)> = line
        .char_indices()
        .chain(std::iter::once((line.len(), ' ')))
        .filter_map(|(at, c)| match (url_excluded(c), start) {
            (false, None) => {
                start = Some(at);
                None
            }
            (true, Some(from)) => {
                start = None;
                Some((from, at))
            }
            _ => None,
        })
        .collect();
    for (from, to) in bounds {
        let run = &line[from..to];
        let end = run
            .char_indices()
            .rev()
            .filter(|(_, c)| *c == '/')
            .find_map(|(at, _)| {
                let marker = URL_MARKERS
                    .iter()
                    .find(|marker| run[at..].starts_with(**marker))?;
                let digits_at = at + marker.len();
                let digits = run[digits_at..]
                    .bytes()
                    .take_while(u8::is_ascii_digit)
                    .count();
                let end = digits_at + digits;
                (digits > 0 && !line[from + end..].starts_with(word)).then_some(end)
            });
        if let Some(end) = end {
            found.push((from, run[..end].to_owned()));
        }
    }
    found
}

/// The spellings that name no URL. Word boundaries, digits, and case folding are ASCII,
/// as in the JavaScript originals (no `u` flag), so `参照issue 12` is still a reference;
/// `\s` is Unicode whitespace in both.
fn word_forms() -> Result<Vec<Regex>, FailureDetails> {
    [
        r"(?-u:\b)(?i-u:issues?|PRs?|pull[ -]requests?|merge[ -]requests?)(?:[ -]?|\s+(?i-u:numbers?|no\.)\s*)[0-9]+",
        r"(?-u:\b)(?i-u:GH-)[0-9]+",
        r"(?-u:\b)gh\s+(?:issue|pr)\s+[a-z][a-z-]*\s+[0-9]+",
    ]
    .into_iter()
    .map(pattern)
    .collect()
}

/// Every match of `pattern` not followed by a word character, as JavaScript's `(?!\w)`
/// after the pattern would take them.
fn word_form_references(line: &str, pattern: &Regex) -> Vec<(usize, String)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(found_match) = pattern.find_at(line, from) {
        if line[found_match.end()..].starts_with(word) {
            from = found_match.start()
                + line[found_match.start()..]
                    .chars()
                    .next()
                    .map_or(1, char::len_utf8);
            continue;
        }
        found.push((found_match.start(), found_match.as_str().to_owned()));
        from = found_match.end();
    }
    found
}

/// Every reference on one line, in the order they appear.
fn references(line: &str, own: &Repository, forms: &[Regex]) -> Vec<String> {
    let mut found = hash_references(line, own);
    found.extend(
        issue_urls(line)
            .into_iter()
            .filter(|(_, url)| is_own_url(url, own)),
    );
    for form in forms {
        found.extend(word_form_references(line, form));
    }
    found.sort_by_key(|(at, _)| *at);
    found.into_iter().map(|(_, text)| text).collect()
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let own = match repository(input.root) {
        Ok(own) => own,
        Err(failure) => return vec![failure],
    };
    let forms = match word_forms() {
        Ok(forms) => forms,
        Err(invalid) => return vec![invalid],
    };
    let mut violations = Vec::new();
    for path in standing_documents(input.root) {
        let Some(text) = read_file(input.root, &path) else {
            continue;
        };
        for (index, line) in text.split('\n').enumerate() {
            for reference in references(line, &own, &forms) {
                violations.push(finding(
                    "ERR_CHECK_ISSUE_REFERENCE",
                    format!("{path}:{} cites `{reference}`", index + 1),
                    format!("no reference to an issue or pull request of {}/{} in a standing document an agent reads: the text carries the rule and its reason itself", own.owner, own.name),
                    line.trim(),
                    format!("rewrite the sentence in {path} to state what the issue decided, and drop the reference"),
                ));
            }
        }
    }
    violations
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::check_harness::documents::UNCHECKED_DOCUMENTS;
    use crate::check_harness::test_support::{codes, run_at, summaries};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const CLEAN: &str = "# Guide

See [Skills](#skills), [step 4](#4-review-the-branch), and
[step 8c](../SKILL.md#8c-take-the-runs-own-output-back-into-the-queue).
Colors: `#0366d6`, `#000000`, `#11223344`, `color: #000;`. An entity: &#123;.
A body says `Closes #N` and `Depends on #N`.
Words that are not references: an issue-number rule, issues and PRs in general, the
`gh issue view` command, `gh issue view <n>`, `gh pr view {n}`, `issue <n>`,
`/issues/new`, a GH-hosted runner, and the v2 release.
Sources: https://github.com/tauri-apps/tauri/issues/139 and
[an upstream fix](https://github.com/Other/widgets/pull/12), and
<https://gitlab.com/group/project/-/merge_requests/3>. Upstream shorthand:
tauri-apps/tauri#1234, (other/repo#12), `Other-Org/some.repo_x#5`.
";

    const FORM: &str = "# Issue form: GitHub renders these strings as Markdown.
name: Task
body:
  - type: input
    attributes:
      label: Dependencies
      placeholder: \"Depends on: #N\"
";

    const CONFIG: &str = "blank_issues_enabled: false
contact_links:
  - name: Discussions
    url: https://example.com/forum
  - name: Report a security vulnerability
    url: https://github.com/acme/widgets/security/advisories/new
";

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<FailureDetails> {
        let dir = temp_dir();
        let unchecked: Vec<(String, &str)> = UNCHECKED_DOCUMENTS
            .iter()
            .map(|path| {
                let file = if crate::check_harness::has_extension(path, &["md"]) {
                    (*path).to_owned()
                } else {
                    format!("{path}/0001-x.md")
                };
                (
                    file,
                    "Decided in #140 (issue 166), https://github.com/acme/widgets/issues/14.\n",
                )
            })
            .collect();
        let mut files: Vec<(&str, Option<&str>)> = vec![
            (".github/ISSUE_TEMPLATE/config.yml", Some(CONFIG)),
            ("AGENTS.md", Some(CLEAN)),
            (".agents/skills/demo/SKILL.md", Some(CLEAN)),
            (".agents/skills/demo/references/more.md", Some(CLEAN)),
            (
                ".agents/skills/demo/scripts/plan.py",
                Some("# See issue #139.\n"),
            ),
            ("CLAUDE.md", Some(CLEAN)),
            (".claude/rules/docs.md", Some(CLEAN)),
            (".claude/agents/executor.md", Some(CLEAN)),
            (".github/ISSUE_TEMPLATE/task.yml", Some(FORM)),
            (".github/ISSUE_TEMPLATE/legacy.md", Some(CLEAN)),
            (
                ".github/ISSUE_TEMPLATE/drafts/old.yml",
                Some("Fixed in #12.\n"),
            ),
            (".github/ISSUE_TEMPLATE/notes.txt", Some("Fixed in #12.\n")),
            ("docs/guide.md", Some(CLEAN)),
            ("docs/design/system.md", Some(CLEAN)),
            ("docs/architecture/README.md", Some(CLEAN)),
            ("README.md", Some("Fixed in #12.\n")),
        ];
        files.extend(
            unchecked
                .iter()
                .map(|(path, text)| (path.as_str(), Some(*text))),
        );
        for (path, content) in overrides {
            files.retain(|(existing, _)| existing != path);
            files.push((path, *content));
        }
        for (path, content) in files {
            if let Some(content) = content {
                write(dir.path(), path, content);
            }
        }
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_on_anchors_colors_entities_placeholders_and_upstream_sources() {
        assert_eq!(check(&[]), []);
        let dir = temp_dir();
        write(dir.path(), ".github/ISSUE_TEMPLATE/config.yml", CONFIG);
        assert_eq!(run_at(dir.path(), run), []);
    }

    #[test]
    fn fails_closed_without_the_repository() {
        for (config, code) in [
            (None, "ERR_CHECK_INPUT_MISSING"),
            (Some("contact_links: [\n"), "ERR_CHECK_INPUT_UNREADABLE"),
            (
                Some("contact_links:\n  - url: https://example.com/x\n"),
                "ERR_CHECK_INPUT_UNREADABLE",
            ),
            (
                Some("blank_issues_enabled: false\n"),
                "ERR_CHECK_INPUT_UNREADABLE",
            ),
        ] {
            let violations = check(&[(".github/ISSUE_TEMPLATE/config.yml", config)]);
            assert_eq!(codes(&violations), [code]);
            assert!(violations[0].summary.contains("owner/repo"));
        }
    }

    #[test]
    fn reports_a_reference_in_each_document_with_its_line() {
        for (path, text, reference) in [
            ("AGENTS.md", "Excluded from typos (issue #139).", "#139"),
            (
                ".agents/skills/demo/SKILL.md",
                "The staged guard (#42) refuses it.",
                "#42",
            ),
            (
                ".agents/skills/demo/references/more.md",
                "Tracked here in acme/widgets#7.",
                "acme/widgets#7",
            ),
            (
                ".agents/skills/demo/references/deep/x.md",
                "Closes #12",
                "#12",
            ),
            ("CLAUDE.md", "The hook changed in #88.", "#88"),
            (".claude/rules/x.md", "Banned since #5.", "#5"),
            ("docs/x.md", "Decided in #31.", "#31"),
            ("docs/architecture/README.md", "Indexed in #31.", "#31"),
            (".claude/agents/x.md", "see #12", "#12"),
            (
                ".github/ISSUE_TEMPLATE/bug_report.yml",
                "description: see #12",
                "#12",
            ),
            (
                ".github/ISSUE_TEMPLATE/feature.yaml",
                "description: see #12",
                "#12",
            ),
            (".github/ISSUE_TEMPLATE/legacy.md", "see #12", "#12"),
        ] {
            let content = format!("# Title\n\n{text}\n");
            let violations = check(&[(path, Some(&content))]);
            assert_eq!(codes(&violations), ["ERR_CHECK_ISSUE_REFERENCE"], "{path}");
            assert_eq!(
                violations[0].summary,
                format!("{path}:3 cites `{reference}`")
            );
        }
        let violations = check(&[(
            "docs/architecture/overview.md",
            Some("Tracked in https://github.com/acme/widgets/issues/14.\n"),
        )]);
        assert_eq!(
            summaries(&violations),
            ["docs/architecture/overview.md:1 cites `https://github.com/acme/widgets/issues/14`"]
        );
    }

    #[test]
    fn reports_every_spelling() {
        for (text, reference) in [
            (
                "See https://github.com/acme/widgets/issues/139.",
                "https://github.com/acme/widgets/issues/139",
            ),
            (
                "Landed in [it](https://www.github.com/Acme/Widgets/pull/12/files).",
                "https://www.github.com/Acme/Widgets/pull/12",
            ),
            ("See [it](../../issues/3).", "../../issues/3"),
            (
                "See //github.com/acme/widgets/pulls/4 now.",
                "//github.com/acme/widgets/pulls/4",
            ),
            ("Brought under the cap (issue 166).", "issue 166"),
            ("Settled by issue number 12.", "issue number 12"),
            ("Settled by issue no. 12.", "issue no. 12"),
            ("Read it with `gh issue view 19`.", "gh issue view 19"),
            ("Watch `gh pr checks 12 --watch`.", "gh pr checks 12"),
            ("Issue 7 decided it.", "Issue 7"),
            ("Reverted by PR-4.", "PR-4"),
            ("Per pull request 9.", "pull request 9"),
            ("Fixed by GH-12.", "GH-12"),
        ] {
            let content = format!("# Title\n\n{text}\n");
            let violations = check(&[("docs/x.md", Some(&content))]);
            assert_eq!(
                summaries(&violations),
                [format!("docs/x.md:3 cites `{reference}`")],
                "{text}"
            );
        }
        for text in [
            "issue 12a, GH-3x, gh pr view 4b, issues/5x",
            "see https://example.org/acme/widgets/issues/9 and https://github.com/x/y/issues/1",
            "&#12; and #1a and #-2",
        ] {
            let content = format!("{text}\n");
            assert_eq!(check(&[("docs/x.md", Some(&content))]), [], "{text}");
        }
    }

    #[test]
    fn reads_word_boundaries_digits_and_case_as_ascii() {
        for (text, cited) in [
            ("参照issue 12", "issue 12"),
            ("見てPR 7", "PR 7"),
            ("詳細はGH-3", "GH-3"),
            ("実行: gh pr view 9", "gh pr view 9"),
        ] {
            let content = format!("{text}\n");
            let found = check(&[("docs/x.md", Some(&content))]);
            assert_eq!(
                summaries(&found),
                [format!("docs/x.md:1 cites `{cited}`")],
                "{text}"
            );
        }
        for text in ["issue １２", "PRſ 4", "xissue 12"] {
            let content = format!("{text}\n");
            assert_eq!(check(&[("docs/x.md", Some(&content))]), [], "{text}");
        }
    }

    #[test]
    fn treats_an_upstream_owner_repo_like_its_url_and_this_one_as_a_reference() {
        let own = "tomada1114/tauri-template";
        let config = CONFIG.replace("acme/widgets", own);
        let upper = own.to_uppercase();
        let text = format!(
            "Upstream: other/repo#12 and acme/widgets#12.\nBare: #12.\nThis repository: {own}#12 and {upper}#13.\nA path is not an owner/repo: docs/a/b#14.\n#1/acme/widgets#2\na.b/c#12"
        );
        let violations = check(&[
            (".github/ISSUE_TEMPLATE/config.yml", Some(&config)),
            ("AGENTS.md", Some(&text)),
        ]);
        assert_eq!(
            summaries(&violations),
            [
                "AGENTS.md:2 cites `#12`".to_owned(),
                format!("AGENTS.md:3 cites `{own}#12`"),
                format!("AGENTS.md:3 cites `{upper}#13`"),
                "AGENTS.md:4 cites `#14`".to_owned(),
                "AGENTS.md:5 cites `#1`".to_owned(),
                "AGENTS.md:5 cites `#2`".to_owned(),
                "AGENTS.md:6 cites `#12`".to_owned(),
            ]
        );
        let violations = check(&[("AGENTS.md", Some("See acme/widgets#123456.\n"))]);
        assert_eq!(
            summaries(&violations),
            ["AGENTS.md:1 cites `acme/widgets#123456`"]
        );
    }

    #[test]
    fn reports_each_reference_on_a_line_in_order_code_included() {
        let violations = check(&[(
            "CLAUDE.md",
            Some("GH-1, then https://github.com/acme/widgets/issues/2, then #3.\n"),
        )]);
        assert_eq!(
            summaries(&violations),
            [
                "CLAUDE.md:1 cites `GH-1`",
                "CLAUDE.md:1 cites `https://github.com/acme/widgets/issues/2`",
                "CLAUDE.md:1 cites `#3`",
            ]
        );
        let violations = check(&[("AGENTS.md", Some("See #1, #2 and #3.\n"))]);
        assert_eq!(violations.len(), 3);
        let violations = check(&[("AGENTS.md", Some("```bash\ngh issue view #321\n```\n"))]);
        assert_eq!(summaries(&violations), ["AGENTS.md:2 cites `#321`"]);
    }
}
