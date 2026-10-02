//! The documents the document checks (just-recipes-exist, no-issue-references) read,
//! listed one way for both, and the owner/repo of this repository, which tells one of its
//! own issue references from an upstream project's.

use std::path::Path;

use regex::Regex;

use super::yaml::{self, Keys, Node};
use super::{finding, has_extension, read_file};
use crate::fail::FailureDetails;

/// Documents neither check reads. The template's own design record (`docs/template/`)
/// cites the upstream template's issues and plans recipes before they exist, and the
/// bootstrap deletes it. The roadmap and the ADRs are an app's own planning and decision
/// records: the roadmap links the issues behind each outcome, an ADR says where its
/// follow-ups are tracked, and both may name a recipe that is still to be written.
pub(super) const UNCHECKED_DOCUMENTS: &[&str] = &[
    "docs/template",
    "docs/architecture/roadmap.md",
    "docs/architecture/adr",
];

/// Every `*.md` file under `dir` (absent: none), recursively, as root-relative
/// `/`-separated paths in byte order, leaving out each path in [`UNCHECKED_DOCUMENTS`]
/// and what is under it.
pub(super) fn markdown_files(root: &Path, dir: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
        return Vec::new();
    };
    let mut entries: Vec<(String, std::fs::FileType)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = format!("{dir}/{}", entry.file_name().to_string_lossy());
            let kind = entry.file_type().ok()?;
            (!UNCHECKED_DOCUMENTS.contains(&path.as_str())).then_some((path, kind))
        })
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
        .into_iter()
        .flat_map(|(path, kind)| {
            if kind.is_dir() {
                markdown_files(root, &path)
            } else if kind.is_file() && has_extension(&path, &["md"]) {
                vec![path]
            } else {
                Vec::new()
            }
        })
        .collect()
}

/// Where GitHub reads the issue forms and templates a filer, human or agent, follows.
const ISSUE_TEMPLATES: &str = ".github/ISSUE_TEMPLATE";

/// The files directly in [`ISSUE_TEMPLATES`] (absent: none) that GitHub reads — the
/// `*.yml` and `*.yaml` issue forms, `config.yml` among them, and `*.md` templates — as
/// root-relative paths in byte order. GitHub reads no subdirectory there, so neither does
/// this.
pub(super) fn issue_templates(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root.join(ISSUE_TEMPLATES)) else {
        return Vec::new();
    };
    let mut found: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            [".md", ".yml", ".yaml"]
                .iter()
                .any(|extension| name.ends_with(extension))
        })
        .map(|name| format!("{ISSUE_TEMPLATES}/{name}"))
        .collect();
    found.sort();
    found
}

/// The documents an agent reads as standing instructions, which both document checks
/// read: `AGENTS.md`, `CLAUDE.md`, every `*.md` under `.claude/rules/`, `.claude/agents/`
/// (the sub-agent definitions), `docs/`, and `.agents/skills/` ([`UNCHECKED_DOCUMENTS`]
/// aside), and the issue templates. Every one is optional here; a check that needs one
/// says so itself.
pub(super) fn standing_documents(root: &Path) -> Vec<String> {
    let mut documents = vec!["AGENTS.md".to_owned(), "CLAUDE.md".to_owned()];
    for dir in [".claude/rules", ".claude/agents", "docs", ".agents/skills"] {
        documents.extend(markdown_files(root, dir));
    }
    documents.extend(issue_templates(root));
    documents
}

/// Where the repository's own GitHub URL is read: a file the bootstrap rewrites.
const REPOSITORY_SOURCE: &str = ".github/ISSUE_TEMPLATE/config.yml";

/// This repository on GitHub, as `owner/repo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Repository {
    pub(super) owner: String,
    pub(super) name: String,
}

/// This repository's owner and name, from the first `contact_links` URL on github.com in
/// [`REPOSITORY_SOURCE`] (the security-advisory link), or the failure that says why it
/// could not be read. A check that needs it fails closed on that failure rather than
/// guessing.
pub(super) fn repository(root: &Path) -> Result<Repository, FailureDetails> {
    let text = read_file(root, REPOSITORY_SOURCE);
    let failure = |actual: String| {
        finding(
            if text.is_none() {
                "ERR_CHECK_INPUT_MISSING"
            } else {
                "ERR_CHECK_INPUT_UNREADABLE"
            },
            format!("cannot tell this repository's owner/repo from {REPOSITORY_SOURCE}"),
            format!(
                "{REPOSITORY_SOURCE} with a `contact_links` entry whose `url` is https://github.com/<owner>/<repo>/…"
            ),
            actual,
            format!(
                "restore {REPOSITORY_SOURCE} from version control (the bootstrap rewrites its URL to the new repository)"
            ),
        )
    };
    let Some(source) = text.as_deref() else {
        return Err(failure("no such file".to_owned()));
    };
    let config = yaml::parse(source, Keys::Unique)
        .map_err(|error| failure(format!("line {}: {}", error.line, error.message)))?;
    let pattern = Regex::new(r"^https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)(?:/|$)")
        .map_err(|error| failure(error.to_string()))?;
    let links = config
        .root
        .get("contact_links")
        .map(Node::items)
        .unwrap_or_default();
    links
        .iter()
        .filter_map(|link| link.get("url").and_then(Node::as_str))
        .find_map(|url| {
            let captures = pattern.captures(url)?;
            let name = &captures[2];
            Some(Repository {
                owner: captures[1].to_owned(),
                name: name.strip_suffix(".git").unwrap_or(name).to_owned(),
            })
        })
        .ok_or_else(|| {
            failure("no `contact_links` url on https://github.com/<owner>/<repo>".to_owned())
        })
}

#[cfg(test)]
mod tests {
    use super::{
        Repository, UNCHECKED_DOCUMENTS, issue_templates, markdown_files, repository,
        standing_documents,
    };
    use crate::test_support::{temp_dir, write};

    fn tree(files: &[&str]) -> tempfile::TempDir {
        let dir = temp_dir();
        for path in files {
            write(dir.path(), path, "");
        }
        dir
    }

    #[test]
    fn lists_markdown_in_byte_order_without_the_unchecked_records() {
        let unchecked: Vec<String> = UNCHECKED_DOCUMENTS
            .iter()
            .map(|path| {
                if crate::check_harness::has_extension(path, &["md"]) {
                    (*path).to_owned()
                } else {
                    format!("{path}/x.md")
                }
            })
            .collect();
        let mut files = vec![
            "docs/b.md",
            "docs/Z.md",
            "docs/a/z.md",
            "docs/notes.txt",
            "docs/architecture/README.md",
        ];
        files.extend(unchecked.iter().map(String::as_str));
        let dir = tree(&files);
        assert_eq!(
            markdown_files(dir.path(), "docs"),
            [
                "docs/Z.md",
                "docs/a/z.md",
                "docs/architecture/README.md",
                "docs/b.md"
            ]
        );
        assert_eq!(
            markdown_files(tree(&[]).path(), "docs"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn lists_the_issue_templates_github_reads() {
        let dir = tree(&[
            ".github/ISSUE_TEMPLATE/task.yml",
            ".github/ISSUE_TEMPLATE/Bug.yaml",
            ".github/ISSUE_TEMPLATE/config.yml",
            ".github/ISSUE_TEMPLATE/legacy.md",
            ".github/ISSUE_TEMPLATE/notes.txt",
            ".github/ISSUE_TEMPLATE/drafts/old.yml",
        ]);
        assert_eq!(
            issue_templates(dir.path()),
            [
                ".github/ISSUE_TEMPLATE/Bug.yaml",
                ".github/ISSUE_TEMPLATE/config.yml",
                ".github/ISSUE_TEMPLATE/legacy.md",
                ".github/ISSUE_TEMPLATE/task.yml",
            ]
        );
        assert_eq!(issue_templates(tree(&[]).path()), Vec::<String>::new());
    }

    #[test]
    fn lists_the_standing_documents() {
        let dir = tree(&[
            "README.md",
            ".claude/rules/rust.md",
            ".claude/agents/executor.md",
            ".claude/skills/demo/SKILL.md",
            "docs/guide.md",
            "docs/architecture/roadmap.md",
            ".agents/skills/demo/SKILL.md",
            ".github/ISSUE_TEMPLATE/task.yml",
            ".github/PULL_REQUEST_TEMPLATE.md",
        ]);
        assert_eq!(
            standing_documents(dir.path()),
            [
                "AGENTS.md",
                "CLAUDE.md",
                ".claude/rules/rust.md",
                ".claude/agents/executor.md",
                "docs/guide.md",
                ".agents/skills/demo/SKILL.md",
                ".github/ISSUE_TEMPLATE/task.yml",
            ]
        );
    }

    #[test]
    fn reads_the_repository_or_fails_closed() {
        let config = ".github/ISSUE_TEMPLATE/config.yml";
        let dir = temp_dir();
        assert_eq!(
            repository(dir.path()).map_err(|found| found.code),
            Err("ERR_CHECK_INPUT_MISSING".to_owned())
        );
        write(
            dir.path(),
            config,
            "contact_links:\n  - url: https://example.com/x\n  - url: https://github.com/acme/widgets.git\n",
        );
        assert_eq!(
            repository(dir.path()),
            Ok(Repository {
                owner: "acme".to_owned(),
                name: "widgets".to_owned()
            })
        );
        for text in ["contact_links:\n  - name: x\n", "contact_links: [\n"] {
            write(dir.path(), config, text);
            let found = repository(dir.path()).expect_err("unreadable");
            assert_eq!(found.code, "ERR_CHECK_INPUT_UNREADABLE");
            assert!(found.summary.contains("owner/repo"));
        }
    }
}
