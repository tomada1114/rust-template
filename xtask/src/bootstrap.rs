//! `cargo xtask bootstrap`: turns this template into a new app, once (`just bootstrap`).
//! It asks for, or takes as flags, the display name, the slug used for crate and binary
//! names, the bundle identifier, the GitHub owner/repo, the author, and the copyright
//! holder, then:
//!
//! - rewrites an explicit list of placeholder sites ([`sites`]) — each a file and the
//!   spellings it carries (`MyApp`; the slug as `myapp` / `myapp-core`, `myapp_core`, and
//!   `MYAPP`; `com.example.myapp`; the template's owner/repo) — never a global replace;
//! - renames `crates/myapp` and `crates/myapp-*` to `crates/<slug>` and `crates/<slug>-*`,
//!   after `cargo fetch --locked`, and updates Cargo.lock offline
//!   (`cargo update --workspace --offline`);
//! - removes the `<!-- template-only -->` … `<!-- /template-only -->` blocks,
//!   `docs/template/`, the `Template Bootstrap Smoke` CI job and its required context, the
//!   `bootstrap` and `verify-bootstrap` recipes and tasks (this file and
//!   `verify_bootstrap.rs`) and every mention of them, and the skill reference that only
//!   describes this task, and rewrites the passages outside those blocks that describe the
//!   template ([`text_edits`]);
//! - resets CHANGELOG.md to an empty [Unreleased] and Cargo.toml's version to 0.1.0, and
//!   writes the copyright line into LICENSE (the holder defaults to the author);
//! - formats the renamed crates (`cargo fmt --all`), and prints the next steps.
//!
//! ```text
//! cargo xtask bootstrap [--name N] [--slug S] [--bundle-id ID] [--repo OWNER/REPO]
//!                       [--author A] [--copyright C] [--yes]
//! ```
//!
//! A missing value is asked for on the terminal; with --yes, or when standard input is not
//! a terminal, a missing value takes its default (slug from the name, copyright holder
//! from the author) or fails. Every edit is computed and checked in memory before the
//! first write, so a drifted site list fails with nothing changed.
//!
//! Git work tree: in one it refuses uncommitted or untracked changes, so the rewrite is
//! the only change to review. Outside one it still runs; only that check and the closing
//! scan for placeholders outside the site list are skipped.
//!
//! Errors: `ERR_BOOTSTRAP_USAGE`, `ERR_BOOTSTRAP_MISSING_VALUE`,
//! `ERR_BOOTSTRAP_INVALID_NAME`, `ERR_BOOTSTRAP_INVALID_SLUG`,
//! `ERR_BOOTSTRAP_INVALID_BUNDLE_ID`, `ERR_BOOTSTRAP_INVALID_REPO`,
//! `ERR_BOOTSTRAP_INVALID_AUTHOR`, `ERR_BOOTSTRAP_INVALID_COPYRIGHT`,
//! `ERR_BOOTSTRAP_ABORTED`, `ERR_BOOTSTRAP_NOT_TEMPLATE`,
//! `ERR_BOOTSTRAP_DIRTY`, `ERR_BOOTSTRAP_SITE_MISSING`, `ERR_BOOTSTRAP_SITE_INCOMPLETE`,
//! `ERR_BOOTSTRAP_MARKER`, `ERR_BOOTSTRAP_REWRITE`, `ERR_BOOTSTRAP_FETCH`,
//! `ERR_BOOTSTRAP_LOCKFILE`, `ERR_BOOTSTRAP_FORMAT`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, IsTerminal, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;

use crate::context::{Context, RunOptions, RunResult};
use crate::fail::{ScriptError, TaskResult};
use crate::git_env::git_env;

/// The values an app is cut with.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Answers {
    pub(crate) name: String,
    pub(crate) slug: String,
    pub(crate) bundle_id: String,
    pub(crate) repo: String,
    pub(crate) author: String,
    pub(crate) copyright: String,
}

/// One of the values in [`Answers`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Field {
    Name,
    Slug,
    BundleId,
    Repo,
    Author,
    Copyright,
}

impl Answers {
    fn get(&self, field: Field) -> &str {
        match field {
            Field::Name => &self.name,
            Field::Slug => &self.slug,
            Field::BundleId => &self.bundle_id,
            Field::Repo => &self.repo,
            Field::Author => &self.author,
            Field::Copyright => &self.copyright,
        }
    }

    fn set(&mut self, field: Field, value: String) {
        let slot = match field {
            Field::Name => &mut self.name,
            Field::Slug => &mut self.slug,
            Field::BundleId => &mut self.bundle_id,
            Field::Repo => &mut self.repo,
            Field::Author => &mut self.author,
            Field::Copyright => &mut self.copyright,
        };
        *slot = value;
    }
}

struct FieldSpec {
    field: Field,
    flag: &'static str,
    label: &'static str,
    code: &'static str,
}

const FIELDS: [FieldSpec; 6] = [
    FieldSpec {
        field: Field::Name,
        flag: "--name",
        label: "Display name (e.g. Tide Pool)",
        code: "ERR_BOOTSTRAP_INVALID_NAME",
    },
    FieldSpec {
        field: Field::Slug,
        flag: "--slug",
        label: "Slug for crate and binary names",
        code: "ERR_BOOTSTRAP_INVALID_SLUG",
    },
    FieldSpec {
        field: Field::BundleId,
        flag: "--bundle-id",
        label: "Bundle identifier (e.g. com.example.tide-pool)",
        code: "ERR_BOOTSTRAP_INVALID_BUNDLE_ID",
    },
    FieldSpec {
        field: Field::Repo,
        flag: "--repo",
        label: "GitHub owner/repo",
        code: "ERR_BOOTSTRAP_INVALID_REPO",
    },
    FieldSpec {
        field: Field::Author,
        flag: "--author",
        label: "Author",
        code: "ERR_BOOTSTRAP_INVALID_AUTHOR",
    },
    FieldSpec {
        field: Field::Copyright,
        flag: "--copyright",
        label: "Copyright holder",
        code: "ERR_BOOTSTRAP_INVALID_COPYRIGHT",
    },
];

fn spec(field: Field) -> &'static FieldSpec {
    &FIELDS[field as usize]
}

/// A label without its "(e.g. …)" example.
fn short_label(label: &str) -> &str {
    label.split(" (e.g.").next().unwrap_or(label)
}

/// The template's own values: what each placeholder site holds before the bootstrap.
pub(crate) const TEMPLATE_NAME: &str = "MyApp";
pub(crate) const TEMPLATE_SLUG: &str = "myapp";
pub(crate) const TEMPLATE_BUNDLE_ID: &str = "com.example.myapp";
pub(crate) const TEMPLATE_OWNER: &str = "tomada1114";
pub(crate) const TEMPLATE_REPO_NAME: &str = "rust-template";

/// The slug in each spelling a site needs, and the owner/repo halves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Names {
    pub(crate) slug: String,
    pub(crate) slug_snake: String,
    pub(crate) slug_upper: String,
    pub(crate) owner: String,
    pub(crate) repo_name: String,
}

/// The slug in every spelling a site needs, and the two halves of owner/repo.
pub(crate) fn derive_names(answers: &Answers) -> Names {
    let (owner, repo_name) = answers.repo.split_once('/').unwrap_or((&answers.repo, ""));
    let slug_snake = answers.slug.replace('-', "_");
    Names {
        slug: answers.slug.clone(),
        slug_upper: slug_snake.to_uppercase(),
        slug_snake,
        owner: owner.to_owned(),
        repo_name: repo_name.to_owned(),
    }
}

/// A spelling of a placeholder, as a site carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Form {
    BundleId,
    Repo,
    RepoName,
    Owner,
    Name,
    SlugSnake,
    Slug,
    SlugUpper,
}

/// What may follow a placeholder for it to count as one.
#[derive(Debug, Clone, Copy)]
enum After {
    /// Neither an ASCII letter or digit nor any of these characters.
    Not(&'static str),
    /// Exactly this character.
    Is(char),
}

/// A form's token, matched as a whole token only: the character before it is neither an
/// ASCII letter or digit nor one of `before`, and the one after it fits `after`. A longer
/// word that merely contains the token is never touched.
struct Rule {
    form: Form,
    token: &'static str,
    before: &'static str,
    after: After,
}

/// Each form's rule, applied in this order (the bundle identifier and the owner/repo
/// contain shorter placeholders, so they go first).
const FORMS: [Rule; 8] = [
    Rule {
        form: Form::BundleId,
        token: TEMPLATE_BUNDLE_ID,
        before: ".-",
        after: After::Not("-"),
    },
    Rule {
        form: Form::Repo,
        token: "tomada1114/rust-template",
        before: "-",
        after: After::Not("_-"),
    },
    Rule {
        form: Form::RepoName,
        token: TEMPLATE_REPO_NAME,
        before: "_/.-",
        after: After::Not("_-"),
    },
    Rule {
        form: Form::Owner,
        token: TEMPLATE_OWNER,
        before: "-",
        after: After::Not("/-"),
    },
    Rule {
        form: Form::Name,
        token: TEMPLATE_NAME,
        before: "",
        after: After::Not(""),
    },
    Rule {
        form: Form::SlugSnake,
        token: TEMPLATE_SLUG,
        before: "",
        after: After::Is('_'),
    },
    Rule {
        form: Form::Slug,
        token: TEMPLATE_SLUG,
        before: ".",
        after: After::Not("_"),
    },
    Rule {
        form: Form::SlugUpper,
        token: "MYAPP",
        before: "",
        after: After::Not(""),
    },
];

fn blocked(c: Option<char>, extra: &str) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

/// The byte offsets where `rule` matches in `text`.
fn form_matches(text: &str, rule: &Rule) -> Vec<usize> {
    text.match_indices(rule.token)
        .map(|(start, _)| start)
        .filter(|&start| {
            let end = start + rule.token.len();
            let previous = text[..start].chars().next_back();
            let next = text[end..].chars().next();
            !blocked(previous, rule.before)
                && match rule.after {
                    After::Not(extra) => !blocked(next, extra),
                    After::Is(wanted) => next == Some(wanted),
                }
        })
        .collect()
}

/// `text` with every match of `rule` replaced by `value`.
fn replace_form(text: &str, rule: &Rule, value: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut copied = 0;
    for start in form_matches(text, rule) {
        result.push_str(&text[copied..start]);
        result.push_str(value);
        copied = start + rule.token.len();
    }
    result.push_str(&text[copied..]);
    result
}

fn form_value(form: Form, answers: &Answers, names: &Names) -> String {
    match form {
        Form::BundleId => answers.bundle_id.clone(),
        Form::Repo => answers.repo.clone(),
        Form::RepoName => names.repo_name.clone(),
        Form::Owner => names.owner.clone(),
        Form::Name => answers.name.clone(),
        Form::SlugSnake => names.slug_snake.clone(),
        Form::Slug => names.slug.clone(),
        Form::SlugUpper => names.slug_upper.clone(),
    }
}

use Form::{BundleId, Name, Owner, Repo, RepoName, Slug, SlugSnake, SlugUpper};

/// The skill files carrying a placeholder; each is listed for both skill trees.
const SKILL_SITES: [(&str, &[Form]); 36] = [
    ("authoring-skills/SKILL.md", &[Slug]),
    (
        "authoring-skills/references/convention-examples.md",
        &[Slug],
    ),
    ("building-tuis/SKILL.md", &[Slug]),
    ("changing-gates/SKILL.md", &[Slug]),
    ("changing-gates/references/gate-files.md", &[Slug]),
    ("changing-gates/references/weakening.md", &[Slug]),
    ("create-pr/SKILL.md", &[Slug]),
    ("create-pr/references/release-impact.md", &[Slug]),
    ("designing-clis/SKILL.md", &[SlugSnake, Slug, SlugUpper]),
    ("designing-core-logic/SKILL.md", &[Slug]),
    ("designing-errors/SKILL.md", &[Slug]),
    ("integrating-system-apis/SKILL.md", &[Slug]),
    (
        "integrating-system-apis/references/tcc-permissions.md",
        &[Slug],
    ),
    (
        "integrating-system-apis/references/unsafe-and-ffi.md",
        &[Slug],
    ),
    ("managing-dependencies/SKILL.md", &[Slug]),
    ("merging-dependency-prs/SKILL.md", &[Slug]),
    ("placing-tests/SKILL.md", &[Slug]),
    (
        "recording-architecture-decisions/SKILL.md",
        &[BundleId, Slug],
    ),
    ("running-the-app/SKILL.md", &[SlugSnake, Slug]),
    ("shipping-issues/SKILL.md", &[Slug]),
    (
        "shipping-issues/references/agent-implementation.md",
        &[Slug],
    ),
    ("shipping-issues/references/closing-out.md", &[Slug]),
    ("shipping-issues/references/cost-discipline.md", &[Slug]),
    ("shipping-issues/references/dependency-triage.md", &[Slug]),
    ("shipping-issues/references/pr-ci-merge.md", &[Slug]),
    ("shipping-issues/references/priority-rubric.md", &[Slug]),
    ("shipping-issues/references/ship-contract.md", &[Slug]),
    ("starting-an-app/SKILL.md", &[Slug]),
    ("tdd/SKILL.md", &[Slug]),
    ("triaging-issues/SKILL.md", &[Slug]),
    ("updating-docs/SKILL.md", &[Slug]),
    ("writing-rust/SKILL.md", &[Slug]),
    ("writing-rust/references/clap-and-ratatui.md", &[Slug]),
    (
        "writing-rust/references/compiler-errors.md",
        &[SlugSnake, Slug],
    ),
    ("writing-tests/SKILL.md", &[Slug]),
    ("writing-tests/references/patterns.md", &[Slug]),
];

/// Every placeholder site outside the skills. Keep this list explicit: a new file that
/// names the app is added here, and `just verify-bootstrap` (which CI's Template
/// Bootstrap Smoke runs) fails on a placeholder in a file this list does not name.
const REPOSITORY_SITES: [(&str, &[Form]); 50] = [
    (".claude/rules/project.md", &[Slug]),
    (".claude/rules/rust.md", &[SlugSnake, Slug]),
    (".claude/rules/testing.md", &[Slug]),
    (".github/ISSUE_TEMPLATE/bug_report.yml", &[BundleId, Slug]),
    (".github/ISSUE_TEMPLATE/config.yml", &[Repo]),
    (".github/PULL_REQUEST_TEMPLATE.md", &[Slug]),
    ("AGENTS.md", &[BundleId, SlugSnake, Slug]),
    ("CODE_OF_CONDUCT.md", &[Owner]),
    ("CONTRIBUTING.md", &[Slug]),
    ("Cargo.toml", &[Slug]),
    ("README.md", &[BundleId, Repo, RepoName, Name, Slug]),
    ("SECURITY.md", &[Repo, Slug]),
    ("clippy.toml", &[Slug]),
    ("crates/myapp/Cargo.toml", &[Slug]),
    ("crates/myapp/src/main.rs", &[SlugSnake, Slug]),
    ("crates/myapp/src/tui/mod.rs", &[SlugSnake, Slug]),
    ("crates/myapp/src/tui/view.rs", &[SlugSnake]),
    ("crates/myapp/src/wording.rs", &[SlugSnake, Slug]),
    ("crates/myapp/tests/cli.rs", &[BundleId, Slug]),
    ("crates/myapp-core/Cargo.toml", &[Name, Slug]),
    ("crates/myapp-core/src/counter/mod.rs", &[SlugSnake, Slug]),
    ("crates/myapp-core/src/lib.rs", &[Slug]),
    ("crates/myapp-core/src/log.rs", &[SlugSnake]),
    ("crates/myapp-core/tests/contracts.rs", &[SlugSnake, Slug]),
    (
        "crates/myapp-core/tests/counter_screen.rs",
        &[SlugSnake, Slug],
    ),
    ("crates/myapp-core/tests/counter_service.rs", &[SlugSnake]),
    ("crates/myapp-core/tests/serialization.rs", &[SlugSnake]),
    ("crates/myapp-platform/Cargo.toml", &[Slug]),
    ("crates/myapp-platform/src/clock.rs", &[SlugSnake]),
    ("crates/myapp-platform/src/counter_store.rs", &[SlugSnake]),
    ("crates/myapp-platform/src/lib.rs", &[Slug]),
    ("crates/myapp-platform/src/paths.rs", &[BundleId, Slug]),
    (
        "crates/myapp-platform/tests/contracts.rs",
        &[SlugSnake, Slug],
    ),
    (
        "crates/myapp-platform/tests/json_file_counter_store.rs",
        &[SlugSnake],
    ),
    ("crates/myapp-platform/tests/logging.rs", &[SlugSnake]),
    ("crates/myapp-test-support/Cargo.toml", &[Slug]),
    ("crates/myapp-test-support/src/clock.rs", &[SlugSnake]),
    (
        "crates/myapp-test-support/src/counter_store.rs",
        &[SlugSnake],
    ),
    ("crates/myapp-test-support/src/lib.rs", &[Slug]),
    ("deny.toml", &[Slug]),
    ("docs/architecture.md", &[BundleId, SlugSnake, Slug]),
    ("docs/architecture/README.md", &[Slug]),
    ("docs/architecture/adr/template.md", &[Slug]),
    ("docs/getting-started.md", &[BundleId, Slug]),
    ("justfile", &[BundleId, Slug]),
    (
        "xtask/src/check_harness/bundle_identifier.rs",
        &[BundleId, Slug],
    ),
    ("xtask/src/check_harness/core_boundary.rs", &[Slug]),
    ("xtask/src/check_harness/no_issue_references.rs", &[Repo]),
    ("xtask/tests/fixtures/core-boundary/pass/deny.toml", &[Slug]),
    (
        "xtask/tests/fixtures/core-boundary/pass/metadata.json",
        &[SlugSnake, Slug],
    ),
];

/// `.agents/skills/<path>` and `.claude/skills/<path>`.
fn both_skill_trees(path: &str) -> [String; 2] {
    [
        format!(".agents/skills/{path}"),
        format!(".claude/skills/{path}"),
    ]
}

/// Every placeholder site: a file and the forms it carries, sorted by path.
pub(crate) fn sites() -> Vec<(String, &'static [Form])> {
    let mut sites: Vec<(String, &'static [Form])> = REPOSITORY_SITES
        .iter()
        .map(|(file, forms)| ((*file).to_owned(), *forms))
        .chain(SKILL_SITES.iter().flat_map(|(path, forms)| {
            both_skill_trees(path)
                .into_iter()
                .map(move |file| (file, *forms))
        }))
        .collect();
    sites.sort_by(|a, b| a.0.cmp(&b.0));
    sites
}

/// An exact passage that reads wrongly in an app, and what replaces it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TextEdit {
    pub(crate) file: String,
    pub(crate) find: &'static str,
    pub(crate) replace: &'static str,
}

fn edit(file: &str, find: &'static str, replace: &'static str) -> TextEdit {
    TextEdit {
        file: file.to_owned(),
        find,
        replace,
    }
}

const STARTING_AN_APP_DESCRIPTION: &str = "description: >
  Covers turning this template into a new app and its first decisions: just bootstrap
  (cargo xtask bootstrap), its prompts or flags (display name, slug, bundle identifier,
  owner/repo, author, copyright holder), the placeholders it rewrites (MyApp, myapp,
  myapp-core, myapp_core, com.example.myapp), just verify-bootstrap and the
  Template Bootstrap Smoke job; AGENTS.md's Product section and the roadmap; the tool's
  shape, subcommands only or subcommands plus the myapp tui screen; where it keeps state
  and the first ADRs; removing the sample counter; installing it with just install-cli;
  just labels, just ruleset, the GitHub security settings, and private-repository
  steps. Use when starting an app from this repository, running or changing the
  bootstrap, a placeholder survived the rename, just check-harness fails on the Product
  section, or setting up a repository created from the template.
";

const STARTING_AN_APP_DESCRIPTION_IN_AN_APP: &str = "description: >
  Covers the first decisions of this app, cut from the template by its bootstrap:
  AGENTS.md's Product section and the roadmap; the tool's shape, subcommands only or
  subcommands plus the myapp tui screen; where it keeps state and the first ADRs;
  removing the sample counter; installing it with just install-cli; just labels, just
  ruleset, the GitHub security settings, and private-repository steps. Use when
  starting the app's first feature, a name the rename missed turns up, just
  check-harness fails on the Product section, or setting up the repository on GitHub.
";

const STARTING_AN_APP_RENAME_STEP: &str =
    "2. **Rename.** `just bootstrap` rewrites the repository, so it is a human's step (an
   agent runs it only when asked). It prompts for, or takes as flags, the display name
   (`MyApp`), the slug used for crate and binary names (`myapp`), the bundle identifier
   (`com.example.myapp`), the GitHub `owner/repo`, the author, and the copyright holder.
   It needs step 1's `just install`. **REQUIRED:**
   [references/bootstrap.md](references/bootstrap.md), for its flags, defaults, and
   validation, before running it, changing it, or chasing a leftover placeholder.
";

const STARTING_AN_APP_RENAME_DONE: &str =
    "2. **Rename.** Done: the bootstrap rewrote the template's placeholders to this app's
   names, removed the template-only material, and deleted itself. A name it missed is
   fixed by hand, in every spelling (hyphenated, underscored, upper-case).
";

// The Product section's introduction. In an app it must hold no `TODO:` of its own, so
// that filling in the four bullets is all it takes to pass the product-section check.
const PRODUCT_INTRO: &str =
    "**TODO: in the template this section is a placeholder.** It is the one part of this
file about the application rather than the harness, so every repository cut from the
template writes its own: without it an agent implementing an issue here has no in-repo
answer to \"is this in scope?\". Fill in every `TODO:` below right after the rename
(`README.md`'s \"Using This Template\") — once `cargo xtask bootstrap` has run,
`just check-harness` fails while one is left.";

const PRODUCT_INTRO_IN_AN_APP: &str =
    "This section is the one part of this file about the application rather than the
harness: without it, an agent implementing an issue here has no in-repo answer to \"is
this in scope?\". The owner writes each bullet (the `starting-an-app` skill says how);
`just check-harness` fails while one still holds its `TODO` marker.";

const UPDATING_DOCS_TEMPLATE_SECTION: &str = "## Template-only material

The bootstrap removes every `<!-- template-only -->` … `<!-- /template-only -->` block
and the template's own design notes, so an app never inherits text about the template.
Text only a template reader needs (why the bootstrap exists, how to use the template)
goes inside a block; text an app keeps (the Design Philosophy of a kept decision, the
install steps) goes outside. A standing document outside a block never links into
the template's design notes: that link dangles in every app. A sentence outside a block
is worded to hold in an app too (\"the index starts empty\", not \"the template ships the
index empty\"), or, where it cannot, rewritten for the app by an entry in `TEXT_EDITS`
in `xtask/src/bootstrap.rs`, in the same change.

Only the files `MARKER_FILES` in `xtask/src/bootstrap.rs` lists have their blocks
removed. A block in any other file adds that file to the list in the same change, or its
marker lines survive into the app and `just verify-bootstrap` (CI's Template Bootstrap
Smoke job) fails with `ERR_VERIFY_BOOTSTRAP_MARKER`. It fails with
`ERR_VERIFY_BOOTSTRAP_TEMPLATE_TEXT` when the app still names the template's design
record or README's template-only section, a decision by its number in that record, or
what the template itself ships or its own reasoning.

";

const CI_ONLY_JOBS: &str = "    ci_only_jobs: &[(
        \"Template Bootstrap Smoke\",
        \"template-only (the bootstrap removes the job and the `verify-bootstrap` recipe): it runs `cargo xtask verify-bootstrap`, which fails when this tree holds a placeholder spelling, template-only text, or a dangling reference the bootstrap would leave behind, then bootstraps a throwaway copy and runs `just check` there. `just check` leaves it out because it clones the tree, needs cargo's registry, and would run a second `just check`; `just verify-bootstrap` runs the verification locally, and AGENTS.md › Validating a change says when\",
    )],";

const DOCUMENTS_EXCLUSION: &str =
    "/// Documents neither check reads. The template's own design record (`docs/template/`)
/// cites the upstream template's issues and plans recipes before they exist, and the
/// bootstrap deletes it. The roadmap and the ADRs are an app's own planning and decision
/// records:";

const DOCUMENTS_EXCLUSION_IN_AN_APP: &str =
    "/// Documents neither check reads. The roadmap and the ADRs are an app's own planning and
/// decision records:";

const MAIN_BOOTSTRAP_TASK: &str = "    (
        \"bootstrap\",
        \"turn the template into a new app: rename its placeholders, remove template-only material\",
        bootstrap::main,
    ),
";

const MAIN_VERIFY_TASK: &str = "    (
        \"verify-bootstrap\",
        \"bootstrap a scratch clone and fail on anything the bootstrap leaves behind\",
        verify_bootstrap::main,
    ),
";

/// Passages that name this task, its recipe, the template's design record, or README's
/// template-only section, or that describe the template rather than the app, and so
/// would dangle or mislead in an app. Each `find` must occur exactly once, in the
/// template's spelling; the form rewrite runs after these edits.
pub(crate) fn text_edits() -> Vec<TextEdit> {
    let mut edits = document_edits();
    edits.extend(skill_edits());
    edits.extend(source_edits());
    edits
}

/// The edits to the top-level documents.
fn document_edits() -> Vec<TextEdit> {
    vec![
        edit("AGENTS.md", PRODUCT_INTRO, PRODUCT_INTRO_IN_AN_APP),
        edit(
            "AGENTS.md",
            "| `starting-an-app` | Turning the template into a new app: bootstrap, Product section, the tool's shape (subcommands only, or plus `myapp tui`), first ADRs |",
            "| `starting-an-app` | The app's first decisions: Product section, the tool's shape (subcommands only, or plus `myapp tui`), first ADRs, removing the sample |",
        ),
        edit(
            "AGENTS.md",
            "just bootstrap  # Turn the template into a new app (renames, removes template-only files)\n",
            "",
        ),
        edit(
            "AGENTS.md",
            "just verify-bootstrap    # Bootstrap a scratch clone in a temp directory; fail on anything it leaves behind (template only)\n",
            "",
        ),
        edit(
            "AGENTS.md",
            "| A new file, or a new spelling of a placeholder (`MyApp`, `myapp`, `myapp-core`, `myapp_core`, `com.example.myapp`, the template's owner/repo) — template only: the bootstrap removes this row | `just verify-bootstrap` (it bootstraps a scratch clone in a temporary directory and fails on a placeholder the rename misses, template-only text, or a dangling reference) |\n",
            "",
        ),
        edit(
            "AGENTS.md",
            "(`com.example.myapp` until the bootstrap renames it)",
            "(`com.example.myapp`)",
        ),
        edit(
            "AGENTS.md",
            "stays a `TODO:` skeleton in the template and holds no `TODO:` once `cargo xtask bootstrap` has run |",
            "holds no `TODO:` |",
        ),
        edit(
            "AGENTS.md",
            "`labels`, `ruleset`, `bootstrap`)",
            "`labels`, `ruleset`)",
        ),
        edit(
            "AGENTS.md",
            "(`bootstrap`, `labels`, `ruleset`)",
            "(`labels`, `ruleset`)",
        ),
        edit(
            "AGENTS.md",
            "`docs/` (apart from the template's own design record, the roadmap, and the ADRs), the skills, and the issue forms name exists;",
            "`docs/` (apart from the roadmap and the ADRs), the skills, and the issue forms name exists;",
        ),
        edit(
            "AGENTS.md",
            "`docs/` (apart from the template's own design record, the roadmap, and the ADRs), a skill, or an issue form;",
            "`docs/` (apart from the roadmap and the ADRs), a skill, or an issue form;",
        ),
        edit(
            "AGENTS.md",
            " `Template Bootstrap Smoke` (the bootstrap run on a throwaway copy, then `just check` there),",
            "",
        ),
        edit(
            "CONTRIBUTING.md",
            "`Template Bootstrap Smoke`, `Workflow Security Lint`, `Dependency Review`, and\n`Validate PR title`.",
            "`Workflow Security Lint`, `Dependency Review`, and `Validate PR title`.",
        ),
    ]
}

/// The edits to the skills, each in both skill trees.
fn skill_edits() -> Vec<TextEdit> {
    let mut edits = Vec::new();
    for file in both_skill_trees("starting-an-app/SKILL.md") {
        edits.push(edit(
            &file,
            STARTING_AN_APP_DESCRIPTION,
            STARTING_AN_APP_DESCRIPTION_IN_AN_APP,
        ));
        edits.push(edit(
            &file,
            STARTING_AN_APP_RENAME_STEP,
            STARTING_AN_APP_RENAME_DONE,
        ));
        edits.push(edit(
            &file,
            "README's \"Using This Template\" is the reader-facing list of the steps below, in the same\norder; the bootstrap removes that section with the rest of the template-only material,\nso this skill is where an app still finds them.\n\n",
            "",
        ));
    }
    for file in both_skill_trees("authoring-skills/SKILL.md") {
        edits.push(edit(
            &file,
            "names an owner or credits a source stays bare. Never point at `docs/template/`: the\nbootstrap deletes it.\n",
            "names an owner or credits a source stays bare.\n",
        ));
        edits.push(edit(
            &file,
            "or test depends on a skill's code block. Write placeholder names exactly (`myapp-core`,\n`myapp_core`, `MyApp`, `com.example.myapp`) so the bootstrap's rename finds them.\n",
            "or test depends on a skill's code block.\n",
        ));
    }
    for file in both_skill_trees("authoring-skills/references/convention-examples.md") {
        edits.push(edit(
            &file,
            "at a glance); a link to\n`docs/template/` (gone after the bootstrap).",
            "at a glance).",
        ));
    }
    for file in both_skill_trees("updating-docs/SKILL.md") {
        edits.extend([
            edit(
                &file,
                "rejects, how the\ntemplate becomes an app (`just bootstrap`), how the tool is installed, and",
                "rejects, how the\ntool is installed, and",
            ),
            edit(&file, UPDATING_DOCS_TEMPLATE_SECTION, ""),
            edit(
                &file,
                "  README.md (Quickstart, Design Philosophy, Using This Template), AGENTS.md,\n",
                "  README.md (Quickstart, Design Philosophy), AGENTS.md,\n",
            ),
            edit(
                &file,
                "  steps drifted, when a template-only block is involved, or when deciding that an\n",
                "  steps drifted, or when deciding that an\n",
            ),
            edit(
                &file,
                "(the Quickstart,\n  what \"Using This Template\" asks), or when",
                "(the Quickstart),\n  or when",
            ),
            edit(
                &file,
                "| The tour: what the template is, Quickstart, Design Philosophy (a \"Why\" per decision), Using This Template, links onward |",
                "| The tour: what the app is, Quickstart, Design Philosophy (a \"Why\" per decision), links onward |",
            ),
            edit(
                &file,
                "Neither\n  check reads the template's own design record, the roadmap, or the ADRs,",
                "Neither\n  check reads the roadmap or the ADRs,",
            ),
        ]);
    }
    edits
}

/// The edits to README's opening line and to xtask's own sources.
fn source_edits() -> Vec<TextEdit> {
    vec![
        edit(
            "README.md",
            "A template for personal Rust command-line tools: one binary, `myapp`, whose clap\nsubcommands",
            "A personal Rust command-line tool: one binary, `myapp`, whose clap\nsubcommands",
        ),
        edit(
            "xtask/src/check_harness/just_check_matches_ci.rs",
            CI_ONLY_JOBS,
            "    ci_only_jobs: &[],",
        ),
        edit(
            "xtask/src/check_harness/just_check_matches_ci.rs",
            " `ci_only_jobs` is not: the\n//! bootstrap removes that job from an app cut from the template.",
            " `ci_only_jobs` is not\n//! reported as stale; it lists no job in this app.",
        ),
        edit(
            "xtask/src/check_harness/documents.rs",
            DOCUMENTS_EXCLUSION,
            DOCUMENTS_EXCLUSION_IN_AN_APP,
        ),
        edit(
            "xtask/src/check_harness/documents.rs",
            "    \"docs/template\",\n",
            "",
        ),
        edit("xtask/src/main.rs", "mod bootstrap;\n", ""),
        edit("xtask/src/main.rs", "mod verify_bootstrap;\n", ""),
        edit("xtask/src/main.rs", MAIN_BOOTSTRAP_TASK, ""),
        edit("xtask/src/main.rs", MAIN_VERIFY_TASK, ""),
        edit(
            "osv-scanner.toml",
            "# Every entry expires after 90 days and is recorded in docs/template/implementation-notes.md.\n",
            "# Every entry expires after 90 days.\n",
        ),
    ]
}

/// Files carrying `<!-- template-only -->` … `<!-- /template-only -->` blocks.
pub(crate) const MARKER_FILES: [&str; 1] = ["README.md"];

/// Removed from the app: the template's design notes, the skill reference that only
/// describes this task, and this task and its verifier.
pub(crate) const REMOVED_PATHS: [&str; 5] = [
    "docs/template",
    ".agents/skills/starting-an-app/references/bootstrap.md",
    ".claude/skills/starting-an-app/references/bootstrap.md",
    "xtask/src/bootstrap.rs",
    "xtask/src/verify_bootstrap.rs",
];

/// The crate directories named after the slug: `crates/myapp` becomes `crates/<slug>`,
/// and each other one `crates/<slug>-<suffix>`.
pub(crate) const CRATE_DIRS: [&str; 4] = [
    "crates/myapp",
    "crates/myapp-core",
    "crates/myapp-platform",
    "crates/myapp-test-support",
];

/// `path` under the renamed crate directory: `crates/myapp…` becomes `crates/<slug>…`.
pub(crate) fn renamed_crate(path: &str, slug: &str) -> String {
    match path.strip_prefix("crates/myapp") {
        Some(rest) if rest.is_empty() || rest.starts_with(['-', '/']) => {
            format!("crates/{slug}{rest}")
        }
        _ => path.to_owned(),
    }
}

const CI_FILE: &str = ".github/workflows/ci.yml";
const CI_JOB_KEY: &str = "  bootstrap-smoke:";
const RULESET_FILE: &str = ".github/rulesets/main.json";
/// The CI job (and required context) the bootstrap removes.
pub(crate) const SMOKE_JOB_NAME: &str = "Template Bootstrap Smoke";
const RULESET_ENTRY: &str =
    r#"(?m)^[ \t]*\{ "context": "Template Bootstrap Smoke", "integration_id": \d+ \},?[ \t]*\n"#;
const JUSTFILE_RECIPE: &str = "
# Turn the template into a new app: rename its placeholders and remove the template-only material (a human's step, run once)
[positional-arguments]
bootstrap *args:
    cargo xtask bootstrap \"$@\"
";
const JUSTFILE_VERIFY_RECIPE: &str = "
# Bootstrap a scratch clone in a temp directory and fail on any placeholder, template-only text, or dangling reference left behind (`--keep` keeps the clone)
verify-bootstrap *args:
    cargo xtask verify-bootstrap {{ args }}
";
const CARGO_VERSION: &str = r#"(?ms)^(\[workspace\.package\][^\[]*?^version\s*=\s*")([^"]*)(")"#;
const LICENSE_LINE: &str = r"(?m)^Copyright \(c\) \d{4} tomada1114$";
const START_MARKER: &str = "<!-- template-only -->";
const END_MARKER: &str = "<!-- /template-only -->";
const FIRST_VERSION: &str = "0.1.0";

/// What still means "placeholder" anywhere in an app.
const LEFTOVER_TOKENS: [&str; 3] = [TEMPLATE_SLUG, TEMPLATE_OWNER, TEMPLATE_REPO_NAME];
/// Placeholder tokens an answer may not contain: the leftover scan would stop looking
/// for them.
const FORBIDDEN_TOKENS: [&str; 2] = [TEMPLATE_SLUG, TEMPLATE_REPO_NAME];

const USAGE: &str = "usage: cargo xtask bootstrap [--name NAME] [--slug SLUG] [--bundle-id ID]
                             [--repo OWNER/REPO] [--author AUTHOR]
                             [--copyright HOLDER] [--yes]

Turns this template into a new app, once. A missing value is asked for on a terminal;
with --yes (or without a terminal) the slug defaults to the name and the copyright
holder to the author, and any other missing value is an error. Quote a value with
spaces, through just or cargo alike.";

/// A pattern this file writes as a literal, compiled; one that does not compile is a bug
/// here, reported rather than panicking.
fn compile(source: &str) -> Result<Regex, ScriptError> {
    Regex::new(source).map_err(|error| ScriptError::unexpected("compiling a pattern", &error))
}

/// `value` as a JSON string, the way a message quotes an answer.
fn quoted(value: &str) -> String {
    serde_json::Value::from(value).to_string()
}

/// The flags on the command line; values are validated later, in [`collect_answers`].
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ParsedArgs {
    values: BTreeMap<Field, String>,
    yes: bool,
    help: bool,
}

fn usage_error(summary: String, actual: String) -> ScriptError {
    ScriptError::new(
        "ERR_BOOTSTRAP_USAGE",
        summary,
        "only the flags in the usage line, each value flag followed by its value",
        actual,
        "run `cargo xtask bootstrap --help`; quote a value with spaces",
    )
}

fn parse_args(argv: &[String]) -> Result<ParsedArgs, ScriptError> {
    let mut parsed = ParsedArgs::default();
    let mut index = 0;
    while let Some(arg) = argv.get(index) {
        index += 1;
        match arg.as_str() {
            "--yes" | "-y" => {
                parsed.yes = true;
                continue;
            }
            "--help" | "-h" => {
                parsed.help = true;
                continue;
            }
            _ => {}
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if arg.starts_with("--") => (flag, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        let Some(spec) = FIELDS.iter().find(|spec| spec.flag == flag) else {
            if arg.starts_with('-') {
                return Err(usage_error(
                    format!("unknown flag '{flag}'"),
                    format!("argument '{arg}'"),
                ));
            }
            return Err(usage_error(
                format!("unexpected argument '{arg}'"),
                format!(
                    "'{arg}' follows no flag (an unquoted value with spaces splits into words)"
                ),
            ));
        };
        let value = match inline {
            Some(value) => value,
            None => match argv.get(index) {
                Some(value) if !value.starts_with("--") => {
                    index += 1;
                    value.clone()
                }
                _ => {
                    return Err(usage_error(
                        format!("{flag} needs a value"),
                        format!("{flag} with no value"),
                    ));
                }
            },
        };
        if parsed.values.contains_key(&spec.field) {
            return Err(usage_error(
                format!("{flag} is given twice"),
                format!("{flag} repeated"),
            ));
        }
        parsed.values.insert(spec.field, value);
    }
    Ok(parsed)
}

fn invalid(field: Field, value: &str, expected: &str) -> ScriptError {
    let spec = spec(field);
    ScriptError::new(
        spec.code,
        format!(
            "{} is not a valid {}",
            quoted(value),
            short_label(spec.label).to_lowercase()
        ),
        expected,
        quoted(value),
        format!("pass {} again with a value that fits", spec.flag),
    )
}

/// Rust keywords and names Cargo refuses as a package or binary name: the built-in
/// crates, the directories Cargo keeps in target/ (`build`, `deps`, `examples`,
/// `incremental`), and Windows' reserved file names.
const RESERVED_SLUGS: &str = "abstract alloc as async await become box break const continue core crate do dyn else enum extern false final fn for gen if impl in let loop macro match mod move mut override priv proc-macro pub ref return self static std struct super test trait true try type typeof union unsafe unsized use virtual where while yield build deps examples incremental con prn aux nul com1 com2 com3 com4 com5 com6 com7 com8 com9 lpt1 lpt2 lpt3 lpt4 lpt5 lpt6 lpt7 lpt8 lpt9";

/// A dot- or slash-separated part: a non-empty run of ASCII letters, digits, and
/// hyphens that starts and ends with a letter or digit.
fn dns_label(part: &str) -> bool {
    !part.is_empty()
        && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !part.starts_with('-')
        && !part.ends_with('-')
}

/// Whether `text` ends with `suffix`, ignoring ASCII case.
fn has_suffix(text: &str, suffix: &str) -> bool {
    text.len()
        .checked_sub(suffix.len())
        .and_then(|start| text.get(start..))
        .is_some_and(|tail| tail.eq_ignore_ascii_case(suffix))
}

fn valid_name(value: &str) -> bool {
    let count = value.chars().count();
    let ends = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    (1..=50).contains(&count)
        && ends(value.chars().next())
        && ends(value.chars().next_back())
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '-'))
        && !value.contains("  ")
}

fn valid_slug(value: &str) -> bool {
    value.len() <= 40
        && value.starts_with(|c: char| c.is_ascii_lowercase())
        && value.split('-').all(|word| {
            !word.is_empty()
                && word
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

fn valid_bundle_id(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    value.len() <= 155
        && parts.len() >= 2
        && parts.iter().all(|part| dns_label(part))
        && value.starts_with(|c: char| c.is_ascii_alphabetic())
}

fn valid_repo(value: &str) -> bool {
    let Some((owner, name)) = value.split_once('/') else {
        return false;
    };
    (1..=39).contains(&owner.len())
        && dns_label(owner)
        && (1..=100).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && name != "."
        && name != ".."
        && !has_suffix(value, ".git")
}

fn valid_line(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 100
        && !value.chars().any(|c| c < ' ' || c == '\u{7f}')
}

/// The value, trimmed, when it is valid for `field`; otherwise an
/// `ERR_BOOTSTRAP_INVALID_*` error.
fn validate_field(field: Field, raw: &str) -> Result<String, ScriptError> {
    let value = raw.trim();
    let problem = match field {
        Field::Name => (!valid_name(value)).then_some(
            "1-50 letters, digits, spaces, hyphens, or periods, starting and ending with a letter or digit (it becomes the .app name and the window title)",
        ),
        Field::Slug => {
            if !valid_slug(value) {
                Some(
                    "lower-case words of letters and digits joined by single hyphens, starting with a letter, at most 40 characters (e.g. tide-pool)",
                )
            } else if RESERVED_SLUGS.split(' ').any(|reserved| reserved == value) {
                Some(
                    "a name that is not a Rust keyword, a built-in crate, or a name Cargo reserves",
                )
            } else {
                None
            }
        }
        Field::BundleId => {
            let lower = value.to_lowercase();
            if !valid_bundle_id(value) {
                Some(
                    "reverse-DNS: two or more dot-separated parts of letters, digits, and hyphens, the first starting with a letter and no part starting or ending with a hyphen (e.g. com.example.tide-pool)",
                )
            } else if lower.starts_with("com.apple.") {
                Some("an identifier outside Apple's com.apple namespace")
            } else if has_suffix(value, ".app") {
                Some(
                    "an identifier that does not end in .app (it clashes with the bundle extension)",
                )
            } else {
                None
            }
        }
        Field::Repo => (!valid_repo(value))
            .then_some("OWNER/REPO as GitHub spells it (e.g. ada/tide-pool)"),
        Field::Author | Field::Copyright => {
            (!valid_line(value)).then_some("1-100 printable characters on one line")
        }
    };
    if let Some(expected) = problem {
        return Err(invalid(field, value, expected));
    }
    let lower = value.to_lowercase();
    if let Some(token) = FORBIDDEN_TOKENS.iter().find(|token| lower.contains(*token)) {
        return Err(invalid(
            field,
            value,
            &format!(
                "a value that does not contain the template's placeholder \"{token}\" (the scan for leftover placeholders looks for it)"
            ),
        ));
    }
    Ok(value.to_owned())
}

/// The ASCII letter a common accented Latin letter folds to, as Unicode decomposition
/// would give it; any other character unchanged.
fn fold(c: char) -> char {
    match c {
        'À'..='Å' | 'à'..='å' | 'Ā'..='ą' => 'a',
        'Ç' | 'ç' | 'Ć'..='č' => 'c',
        'Ď' | 'ď' => 'd',
        'È'..='Ë' | 'è'..='ë' | 'Ē'..='ě' => 'e',
        'Ĝ'..='ģ' => 'g',
        'Ĥ' | 'ĥ' => 'h',
        'Ì'..='Ï' | 'ì'..='ï' | 'Ĩ'..='İ' => 'i',
        'Ĵ' | 'ĵ' => 'j',
        'Ķ' | 'ķ' => 'k',
        'Ĺ'..='ľ' => 'l',
        'Ñ' | 'ñ' | 'Ń'..='ň' => 'n',
        'Ò'..='Ö' | 'ò'..='ö' | 'Ō'..='ő' => 'o',
        'Ŕ'..='ř' => 'r',
        'Ś'..='š' => 's',
        'Ţ'..='ť' => 't',
        'Ù'..='Ü' | 'ù'..='ü' | 'Ũ'..='ų' => 'u',
        'Ŵ' | 'ŵ' => 'w',
        'Ý' | 'ý' | 'ÿ' | 'Ŷ'..='Ÿ' => 'y',
        'Ź'..='ž' => 'z',
        other => other,
    }
}

/// The slug a display name suggests: "Tide Pool" -> "tide-pool".
fn slug_from(name: &str) -> String {
    let mut slug = String::new();
    let mut gap = false;
    for c in name.chars().map(fold).flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(c);
        } else {
            gap = true;
        }
    }
    slug
}

fn default_for(field: Field, answers: &Answers) -> Option<String> {
    match field {
        Field::Slug if !answers.name.is_empty() => Some(slug_from(&answers.name))
            .filter(|slug| slug.starts_with(|c: char| c.is_ascii_lowercase())),
        Field::Copyright if !answers.author.is_empty() => Some(answers.author.clone()),
        Field::Name
        | Field::Slug
        | Field::BundleId
        | Field::Repo
        | Field::Author
        | Field::Copyright => None,
    }
}

/// Where interactive answers come from; a test passes a fake.
pub(crate) trait Terminal {
    /// Whether a person can answer (standard input and output are both terminals).
    fn interactive(&self) -> bool;
    /// The answer to `question`, or `None` when input has ended.
    fn ask(&mut self, question: &str) -> Option<String>;
}

/// A terminal over a line reader and a prompt writer.
struct LineTerminal<R, W> {
    input: R,
    output: W,
    interactive: bool,
}

impl<R: BufRead, W: Write> Terminal for LineTerminal<R, W> {
    fn interactive(&self) -> bool {
        self.interactive
    }

    fn ask(&mut self, question: &str) -> Option<String> {
        // A prompt that cannot be shown is still answered from the input.
        let _ = write!(self.output, "{question}").and_then(|()| self.output.flush());
        let mut line = String::new();
        match self.input.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line.trim_end_matches(['\n', '\r']).to_owned()),
        }
    }
}

const ATTEMPTS: usize = 3;

fn aborted(actual: String) -> ScriptError {
    ScriptError::new(
        "ERR_BOOTSTRAP_ABORTED",
        "the bootstrap was stopped before it changed anything",
        "an answer to every question and a yes to the confirmation",
        actual,
        "run `just bootstrap` again, or pass every value as a flag with --yes",
    )
}

/// Every answer: from its flag, else (on a terminal without --yes) from a question, else
/// from its default. On a terminal it shows the values and asks before anything changes.
fn collect_answers(
    parsed: &ParsedArgs,
    terminal: &mut dyn Terminal,
    log: &dyn Fn(&str),
) -> Result<Answers, ScriptError> {
    let interactive = terminal.interactive() && !parsed.yes;
    let mut answers = Answers::default();
    let mut missing = Vec::new();
    for spec in &FIELDS {
        let fallback = default_for(spec.field, &answers);
        let value = if let Some(given) = parsed.values.get(&spec.field) {
            validate_field(spec.field, given)?
        } else if !interactive {
            let Some(fallback) = fallback else {
                missing.push(spec.flag);
                continue;
            };
            validate_field(spec.field, &fallback)?
        } else {
            ask(terminal, spec, fallback.as_deref(), log)?
        };
        answers.set(spec.field, value);
    }
    if !missing.is_empty() {
        let list = missing.join(", ");
        return Err(ScriptError::new(
            "ERR_BOOTSTRAP_MISSING_VALUE",
            format!("no value for {list}"),
            "every value as a flag when the bootstrap cannot ask (--yes, or no terminal)",
            format!("missing: {list}"),
            "pass the missing flags, or run `just bootstrap` on a terminal to be asked",
        ));
    }
    if interactive {
        log("");
        for spec in &FIELDS {
            log(&format!(
                "  {}: {}",
                short_label(spec.label),
                answers.get(spec.field)
            ));
        }
        let confirm = terminal.ask("Rewrite this checkout with these values? [y/N] ");
        let yes = confirm
            .as_deref()
            .is_some_and(|answer| matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"));
        if !yes {
            return Err(aborted(confirm.map_or_else(
                || "input ended".to_owned(),
                |answer| format!("the answer {}", quoted(&answer)),
            )));
        }
    }
    Ok(answers)
}

fn ask(
    terminal: &mut dyn Terminal,
    spec: &FieldSpec,
    fallback: Option<&str>,
    log: &dyn Fn(&str),
) -> Result<String, ScriptError> {
    let question = match fallback {
        Some(fallback) => format!("{} [{fallback}]: ", spec.label),
        None => format!("{}: ", spec.label),
    };
    let mut last = aborted("input ended".to_owned());
    for _ in 0..ATTEMPTS {
        let Some(answer) = terminal.ask(&question) else {
            return Err(aborted("input ended".to_owned()));
        };
        let value = match fallback {
            Some(fallback) if answer.trim().is_empty() => fallback.to_owned(),
            _ => answer,
        };
        match validate_field(spec.field, &value) {
            Ok(value) => return Ok(value),
            Err(error) => {
                log(&format!(
                    "{}: {} — expected {}",
                    error.details.code, error.details.summary, error.details.expected
                ));
                last = error;
            }
        }
    }
    Err(last)
}

/// The tokens that still mean "placeholder" for these answers (a user may legitimately
/// be the template's owner).
fn tokens_for(answers: Option<&Answers>) -> Vec<&'static str> {
    let given = answers.map_or_else(String::new, |answers| {
        FIELDS
            .iter()
            .map(|spec| answers.get(spec.field))
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase()
    });
    LEFTOVER_TOKENS
        .into_iter()
        .filter(|token| !given.contains(token))
        .collect()
}

/// Every line of `text` that names one of `tokens`, in any case, as `file:line: text`.
fn leftover_lines(file: &str, text: &str, tokens: &[&str]) -> Vec<String> {
    if tokens.is_empty() {
        return Vec::new();
    }
    text.split('\n')
        .enumerate()
        .filter(|(_, line)| {
            let lower = line.to_lowercase();
            tokens.iter().any(|token| lower.contains(token))
        })
        .map(|(index, line)| format!("{file}:{}: {}", index + 1, line.trim()))
        .collect()
}

/// A file's bytes as text, or `None` when it is absent, not a regular file, unreadable,
/// or binary (it holds a NUL byte).
pub(crate) fn read_text(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    (!bytes.contains(&0)).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

/// Every line of `files` (paths under `root`) that still names a template placeholder in
/// any spelling, as `path:line: text`. Missing, unreadable, and binary files are skipped.
pub(crate) fn find_leftovers(
    root: &Path,
    files: &[String],
    answers: Option<&Answers>,
) -> Vec<String> {
    let tokens = tokens_for(answers);
    files
        .iter()
        .filter_map(|file| read_text(&root.join(file)).map(|text| (file, text)))
        .flat_map(|(file, text)| leftover_lines(file, &text, &tokens))
        .collect()
}

fn site_missing(file: &str, actual: impl Into<String>) -> ScriptError {
    ScriptError::new(
        "ERR_BOOTSTRAP_SITE_MISSING",
        format!("the site list no longer matches {file}; nothing was written"),
        format!("{file} to hold what xtask/src/bootstrap.rs lists for it"),
        actual,
        "update the site in xtask/src/bootstrap.rs (sites, text_edits, or the structured edits) to match the file, then run `just verify-bootstrap`",
    )
}

fn rewrite_failed(file: &str, actual: impl Into<String>) -> ScriptError {
    ScriptError::new(
        "ERR_BOOTSTRAP_REWRITE",
        format!("{file} did not parse as expected after its edit; nothing was written"),
        format!("{file} to stay valid and to hold the new values"),
        actual,
        "fix the file's shape in the template (or the edit in xtask/src/bootstrap.rs), then run `just verify-bootstrap`",
    )
}

/// Replace exactly one match of `pattern` in `text`, or fail as a drifted site.
fn replace_once(
    file: &str,
    text: &str,
    pattern: &Regex,
    replacement: &str,
    what: &str,
) -> Result<String, ScriptError> {
    let count = pattern.find_iter(text).count();
    if count != 1 {
        return Err(site_missing(
            file,
            format!("{count} occurrence(s) of {what}"),
        ));
    }
    Ok(pattern
        .replace(text, regex::NoExpand(replacement))
        .into_owned())
}

fn marker_error(file: &str, index: usize, actual: &str) -> ScriptError {
    ScriptError::new(
        "ERR_BOOTSTRAP_MARKER",
        format!(
            "{file}:{} has an unbalanced template-only marker; nothing was written",
            index + 1
        ),
        format!("each \"{START_MARKER}\" line closed by a later \"{END_MARKER}\" line"),
        actual,
        format!("balance the markers in {file}, then run the bootstrap again"),
    )
}

fn remove_template_only_blocks(file: &str, text: &str) -> Result<String, ScriptError> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut open: Option<usize> = None;
    let mut blocks = 0;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed == START_MARKER {
            if open.is_some() {
                return Err(marker_error(
                    file,
                    index,
                    "a second start marker inside an open block",
                ));
            }
            open = Some(index);
        } else if trimmed == END_MARKER {
            if open.is_none() {
                return Err(marker_error(
                    file,
                    index,
                    "an end marker with no open block",
                ));
            }
            open = None;
            blocks += 1;
            // One blank line where the block was, not two.
            let next = lines.get(index + 1);
            if kept.last() == Some(&"") && next.is_none_or(|next| next.is_empty()) {
                kept.pop();
            }
        } else if open.is_none() {
            kept.push(line);
        }
    }
    if let Some(index) = open {
        return Err(marker_error(
            file,
            index,
            "a start marker that is never closed",
        ));
    }
    if blocks == 0 {
        return Err(site_missing(file, "no template-only block"));
    }
    Ok(kept.join("\n"))
}

/// Whether a line starts a job or a top-level key: no indentation, or exactly two spaces.
fn starts_key(line: &str) -> bool {
    let rest = line.strip_prefix("  ").unwrap_or(line);
    rest.starts_with(|c: char| !c.is_whitespace())
}

fn remove_ci_job(text: &str) -> Result<String, ScriptError> {
    let lines: Vec<&str> = text.split('\n').collect();
    let Some(start) = lines.iter().position(|line| *line == CI_JOB_KEY) else {
        return Err(site_missing(
            CI_FILE,
            format!("no `{}` job", CI_JOB_KEY.trim()),
        ));
    };
    let end = lines[start + 1..]
        .iter()
        .position(|line| starts_key(line))
        .map_or(lines.len(), |offset| start + 1 + offset);
    let mut result = [&lines[..start], &lines[end..]].concat().join("\n");
    if end >= lines.len() {
        result = format!("{}\n", result.trim_end());
    }
    let documents = yaml_rust2::YamlLoader::load_from_str(&result)
        .map_err(|error| rewrite_failed(CI_FILE, error.to_string()))?;
    let jobs = documents
        .first()
        .and_then(|document| document["jobs"].as_hash())
        .map(|jobs| {
            jobs.iter()
                .map(|(key, job)| {
                    (
                        key.as_str().unwrap_or_default().to_owned(),
                        job["name"].as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if jobs.is_empty()
        || jobs
            .iter()
            .any(|(key, name)| key == "bootstrap-smoke" || name == SMOKE_JOB_NAME)
    {
        let keys: Vec<&str> = jobs.iter().map(|(key, _)| key.as_str()).collect();
        return Err(rewrite_failed(
            CI_FILE,
            format!("the jobs after the edit: {}", keys.join(", ")),
        ));
    }
    Ok(result)
}

fn remove_ruleset_context(text: &str) -> Result<String, ScriptError> {
    let result = replace_once(
        RULESET_FILE,
        text,
        &compile(RULESET_ENTRY)?,
        "",
        &format!("the \"{SMOKE_JOB_NAME}\" context"),
    )?;
    serde_json::from_str::<serde_json::Value>(&result)
        .map_err(|error| rewrite_failed(RULESET_FILE, error.to_string()))?;
    Ok(result)
}

/// Remove the `bootstrap` and `verify-bootstrap` recipes: both run a task the bootstrap
/// deletes.
fn remove_recipes(text: &str) -> Result<String, ScriptError> {
    let mut result = text.to_owned();
    for (name, recipe) in [
        ("bootstrap", JUSTFILE_RECIPE),
        ("verify-bootstrap", JUSTFILE_VERIFY_RECIPE),
    ] {
        let count = result.matches(recipe).count();
        if count != 1 {
            return Err(site_missing(
                "justfile",
                format!("{count} copies of the {name} recipe"),
            ));
        }
        result = result.replacen(recipe, "", 1);
    }
    Ok(result)
}

fn reset_changelog(text: &str) -> Result<String, ScriptError> {
    let lines: Vec<&str> = text.split('\n').collect();
    let unreleased = |line: &&str| {
        line.strip_prefix("##")
            .is_some_and(|rest| rest.trim() == "[Unreleased]")
    };
    let Some(index) = lines.iter().position(unreleased) else {
        return Err(site_missing("CHANGELOG.md", "no `## [Unreleased]` heading"));
    };
    Ok(format!("{}\n", lines[..=index].join("\n")))
}

fn toml_table(text: &str) -> Option<toml::Table> {
    text.parse::<toml::Table>().ok()
}

fn reset_cargo_version(text: &str) -> Result<String, ScriptError> {
    let pattern = compile(CARGO_VERSION)?;
    if !pattern.is_match(text) {
        return Err(site_missing(
            "Cargo.toml",
            "no version under [workspace.package]",
        ));
    }
    let result = pattern
        .replace(text, format!("${{1}}{FIRST_VERSION}${{3}}"))
        .into_owned();
    let version = toml_table(&result).and_then(|table| {
        table
            .get("workspace")?
            .get("package")?
            .get("version")?
            .as_str()
            .map(str::to_owned)
    });
    if version.as_deref() != Some(FIRST_VERSION) {
        return Err(rewrite_failed(
            "Cargo.toml",
            "[workspace.package] version is not 0.1.0 after the edit",
        ));
    }
    Ok(result)
}

fn edit_license(text: &str, answers: &Answers, year: i64) -> Result<String, ScriptError> {
    replace_once(
        "LICENSE",
        text,
        &compile(LICENSE_LINE)?,
        &format!("Copyright (c) {year} {}", answers.copyright),
        "the template's copyright line",
    )
}

/// Every write the bootstrap makes, by path (before the crate rename), computed and
/// checked in memory.
type Plan = BTreeMap<String, String>;

/// The file's current text: the planned one when an earlier edit touched it.
fn planned_text(root: &Path, writes: &Plan, file: &str) -> Result<String, ScriptError> {
    if let Some(text) = writes.get(file) {
        return Ok(text.clone());
    }
    let full = root.join(file);
    match std::fs::read(&full) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(site_missing(file, "the file does not exist"))
        }
        Err(error) => Err(ScriptError::unexpected(
            &format!("reading {}", full.display()),
            &error,
        )),
    }
}

fn structured_edit(
    file: &str,
    text: &str,
    answers: &Answers,
    year: i64,
) -> Result<String, ScriptError> {
    match file {
        "CHANGELOG.md" => reset_changelog(text),
        "Cargo.toml" => reset_cargo_version(text),
        "LICENSE" => edit_license(text, answers, year),
        CI_FILE => remove_ci_job(text),
        RULESET_FILE => remove_ruleset_context(text),
        _ => remove_recipes(text),
    }
}

const STRUCTURED_FILES: [&str; 6] = [
    "CHANGELOG.md",
    "Cargo.toml",
    "LICENSE",
    CI_FILE,
    RULESET_FILE,
    "justfile",
];

/// Compute every edit in memory, failing on any drift before anything is written.
fn plan(root: &Path, answers: &Answers, year: i64) -> Result<Plan, ScriptError> {
    let mut writes = Plan::new();
    for edit in text_edits() {
        let current = planned_text(root, &writes, &edit.file)?;
        let count = current.matches(edit.find).count();
        if count != 1 {
            let start: String = edit.find.chars().take(60).collect();
            return Err(site_missing(
                &edit.file,
                format!(
                    "{count} occurrence(s) of the passage starting {}",
                    quoted(&start)
                ),
            ));
        }
        writes.insert(
            edit.file.clone(),
            current.replacen(edit.find, edit.replace, 1),
        );
    }
    for file in MARKER_FILES {
        let text = remove_template_only_blocks(file, &planned_text(root, &writes, file)?)?;
        writes.insert(file.to_owned(), text);
    }
    for file in STRUCTURED_FILES {
        let text = structured_edit(file, &planned_text(root, &writes, file)?, answers, year)?;
        writes.insert(file.to_owned(), text);
    }

    let names = derive_names(answers);
    for (file, forms) in sites() {
        let mut current = planned_text(root, &writes, &file)?;
        for rule in FORMS.iter().filter(|rule| forms.contains(&rule.form)) {
            if form_matches(&current, rule).is_empty() {
                return Err(site_missing(
                    &file,
                    format!("no {:?} placeholder ({})", rule.form, rule.token),
                ));
            }
            current = replace_form(&current, rule, &form_value(rule.form, answers, &names));
        }
        writes.insert(file, current);
    }

    let tokens = tokens_for(Some(answers));
    let leftovers: Vec<String> = writes
        .iter()
        .flat_map(|(file, content)| leftover_lines(file, content, &tokens))
        .collect();
    if let Some(first) = leftovers.first() {
        let file = first.split(':').next().unwrap_or_default();
        return Err(ScriptError::new(
            "ERR_BOOTSTRAP_SITE_INCOMPLETE",
            format!("{file} would keep a placeholder its site does not list; nothing was written"),
            "no template placeholder in any file the bootstrap rewrites",
            first_few(&leftovers),
            "add the missing form to that file's entry in xtask/src/bootstrap.rs's sites, then run `just verify-bootstrap`",
        ));
    }
    Ok(writes)
}

/// The first five of `items`, joined, and how many more there are.
pub(crate) fn first_few(items: &[String]) -> String {
    let shown = items
        .iter()
        .take(5)
        .cloned()
        .collect::<Vec<_>>()
        .join(" | ");
    if items.len() > 5 {
        format!("{shown} (and {} more)", items.len() - 5)
    } else {
        shown
    }
}

/// The value of the justfile's `bundle_id := "…"` (or single-quoted) line.
fn justfile_bundle_id(justfile: &str) -> Option<String> {
    justfile.lines().find_map(|line| {
        let rest = line.strip_prefix("bundle_id")?.trim_start();
        let rest = rest.strip_prefix(":=")?.trim_start();
        let quote = rest.chars().next().filter(|c| matches!(c, '"' | '\''))?;
        let (value, tail) = rest[1..].split_once(quote)?;
        let tail = tail.trim();
        (tail.is_empty() || tail.starts_with('#')).then(|| value.to_owned())
    })
}

fn assert_template(root: &Path) -> Result<(), ScriptError> {
    let identifier = read_text(&root.join("justfile")).and_then(|text| justfile_bundle_id(&text));
    let missing: Vec<&str> = CRATE_DIRS
        .into_iter()
        .filter(|dir| !root.join(dir).exists())
        .collect();
    if identifier.as_deref() == Some(TEMPLATE_BUNDLE_ID) && missing.is_empty() {
        return Ok(());
    }
    let mut actual = format!(
        "identifier {}",
        identifier
            .as_deref()
            .map_or_else(|| "null".to_owned(), quoted)
    );
    if !missing.is_empty() {
        actual = format!("{actual}; missing {}", missing.join(", "));
    }
    Err(ScriptError::new(
        "ERR_BOOTSTRAP_NOT_TEMPLATE",
        format!(
            "{} is not an un-bootstrapped copy of the template",
            root.display()
        ),
        format!(
            "bundle_id \"{TEMPLATE_BUNDLE_ID}\" in the justfile and {}",
            CRATE_DIRS.join(", ")
        ),
        actual,
        "the bootstrap runs once, on a fresh clone of a repository created from the template; it has nothing to do here",
    ))
}

fn git(context: &Context<'_>, args: &[&str]) -> RunResult {
    context.run(
        "git",
        args,
        &RunOptions {
            cwd: Some(context.root.clone()),
            env: Some(git_env(&context.env)),
            input: None,
        },
    )
}

/// Refuse a work tree with uncommitted or untracked changes; outside git there is
/// nothing to check.
fn assert_clean(context: &Context<'_>) -> Result<(), ScriptError> {
    let inside = git(context, &["rev-parse", "--is-inside-work-tree"]);
    if !inside.success() || inside.stdout_text().trim() == "false" {
        return Ok(());
    }
    let status = git(context, &["status", "--porcelain"]);
    if !status.success() {
        // Inside a work tree a failing status (a held index.lock, say) must not fail open.
        let stderr = status.stderr_text();
        return Err(ScriptError::new(
            "ERR_BOOTSTRAP_DIRTY",
            format!(
                "`git status` failed in {}, so its cleanliness is unknown; nothing was written",
                context.root.display()
            ),
            "`git status --porcelain` to exit 0 inside the work tree",
            format!(
                "exit {}: {}",
                exit_text(&status),
                stderr.trim().lines().next().unwrap_or_default()
            ),
            "run `git status` to see why it fails (a stale .git/index.lock, for example), fix it, then run the bootstrap again",
        ));
    }
    let stdout = status.stdout_text();
    let changes: Vec<String> = stdout
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect();
    if changes.is_empty() {
        return Ok(());
    }
    Err(ScriptError::new(
        "ERR_BOOTSTRAP_DIRTY",
        format!(
            "{} has uncommitted or untracked changes; nothing was written",
            context.root.display()
        ),
        "a clean work tree, so the rewrite is the only change to review",
        first_few(&changes),
        "commit or stash the changes `git status` lists, then run the bootstrap again",
    ))
}

fn exit_text(result: &RunResult) -> String {
    result
        .status
        .map_or_else(|| "none".to_owned(), |status| status.to_string())
}

/// Every package name the workspace resolves (Cargo.lock's packages, and the
/// `[workspace.dependencies]` keys), spelled with hyphens, minus the template's own
/// crates.
pub(crate) fn dependency_names(root: &Path) -> Result<BTreeSet<String>, ScriptError> {
    let manifest = std::fs::read_to_string(root.join("Cargo.toml"))
        .map_err(|error| ScriptError::unexpected("reading Cargo.toml", &error))?;
    let manifest = manifest
        .parse::<toml::Table>()
        .map_err(|error| ScriptError::unexpected("parsing Cargo.toml", &error))?;
    let mut names: Vec<String> = manifest
        .get("workspace")
        .and_then(|workspace| workspace.get("dependencies"))
        .and_then(toml::Value::as_table)
        .map(|table| table.keys().cloned().collect())
        .unwrap_or_default();
    if let Some(lock) = read_text(&root.join("Cargo.lock")) {
        let lock = lock
            .parse::<toml::Table>()
            .map_err(|error| ScriptError::unexpected("parsing Cargo.lock", &error))?;
        if let Some(packages) = lock.get("package").and_then(toml::Value::as_array) {
            names.extend(
                packages
                    .iter()
                    .filter_map(|package| package.get("name")?.as_str().map(str::to_owned)),
            );
        }
    }
    let own: BTreeSet<&str> = CRATE_DIRS
        .iter()
        .map(|dir| dir.trim_start_matches("crates/"))
        .collect();
    Ok(names
        .into_iter()
        .map(|name| name.to_lowercase().replace('_', "-"))
        .filter(|name| !own.contains(name.as_str()))
        .collect())
}

/// Refuse a slug whose crate package name would collide with a dependency.
fn assert_slug_free(root: &Path, slug: &str) -> Result<(), ScriptError> {
    let taken = dependency_names(root)?;
    let packages: Vec<String> = CRATE_DIRS
        .iter()
        .map(|dir| {
            renamed_crate(dir, slug)
                .trim_start_matches("crates/")
                .to_owned()
        })
        .collect();
    let Some(clash) = packages.iter().find(|name| taken.contains(*name)) else {
        return Ok(());
    };
    Err(ScriptError::new(
        "ERR_BOOTSTRAP_INVALID_SLUG",
        format!(
            "{} would name the package {clash}, which a dependency already uses; nothing was written",
            quoted(slug)
        ),
        format!(
            "a slug whose packages ({}) match no package in Cargo.lock or [workspace.dependencies]",
            packages.join(", ")
        ),
        format!("{clash} is already a dependency"),
        "pass --slug again with a name no dependency uses",
    ))
}

fn run_step(
    context: &Context<'_>,
    command: &str,
    args: &[&str],
    code: &str,
    summary: &str,
    next: &str,
) -> TaskResult {
    let result = context.run(
        command,
        args,
        &RunOptions {
            cwd: Some(context.root.clone()),
            env: Some(context.env.clone()),
            input: None,
        },
    );
    if result.success() {
        return Ok(());
    }
    let stderr = result.stderr_text();
    let tail: Vec<&str> = stderr.trim().lines().collect();
    let tail = tail[tail.len().saturating_sub(3)..].join(" ");
    Err(ScriptError::new(
        code,
        summary,
        format!("`{command} {}` to exit 0", args.join(" ")),
        format!("exit {}: {tail}", exit_text(&result)),
        next,
    ))
}

fn io_error(what: &str, path: &Path, error: &std::io::Error) -> ScriptError {
    ScriptError::unexpected(&format!("{what} {}", path.display()), error)
}

/// Remove a file or a directory tree; one that is already gone is fine.
fn remove_path(path: &Path) -> TaskResult {
    let removed = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    };
    removed.map_err(|error| io_error("removing", path, &error))
}

const NEXT_STEPS: [&str; 21] = [
    "The bootstrap and its verifier removed themselves from xtask.",
    "",
    "Next steps:",
    "  1. Review the rewrite (`git status`, `git diff`), and commit it as one commit before",
    "     editing anything.",
    "  2. Fill in AGENTS.md's `## Product` section — what the app is and who it is for, the core",
    "     interaction, the non-goals — and delete every `TODO:` there. `just check-harness`",
    "     (and so `just check`) fails until you do.",
    "  3. Fill in docs/architecture/roadmap.md (Now / Next / Later) with the steering-the-roadmap skill.",
    "  4. just check, then commit the Product section and roadmap and push both commits to",
    "     main (the ruleset is not on yet, so main takes a direct push).",
    "  5. just labels — create the label set from .github/labels.yml on the new repository.",
    "     .github/dependabot.yml names its labels explicitly and Dependabot skips one the",
    "     repository lacks, so add `dependencies` by hand to any Dependabot pull request",
    "     opened before this step.",
    "  6. Turn on the GitHub security settings: secret scanning and push protection, private",
    "     vulnerability reporting, Dependabot alerts and security updates. Install the Renovate",
    "     GitHub App on the repository: without it nothing bumps mise.toml or rust-toolchain.toml.",
    "  7. Once the bootstrap commit is on main: just ruleset (a repository admin's step). It",
    "     applies every .github/rulesets/*.json: the main branch ruleset and the release-tags",
    "     tag ruleset.",
];

/// Rewrite `context.root` from the template into the app `answers` describe.
fn run_bootstrap(context: &Context<'_>, answers: &Answers, year: i64) -> TaskResult {
    let root = context.root.as_path();
    assert_template(root)?;
    assert_slug_free(root, &answers.slug)?;
    let writes = plan(root, answers, year)?;
    assert_clean(context)?;

    run_step(
        context,
        "cargo",
        &["fetch", "--locked"],
        "ERR_BOOTSTRAP_FETCH",
        "cargo could not fetch the locked dependencies; nothing was written",
        "check the network and `cargo fetch --locked`, then run the bootstrap again",
    )?;

    for (file, content) in &writes {
        let path = root.join(file);
        std::fs::write(&path, content).map_err(|error| io_error("writing", &path, &error))?;
    }
    for dir in CRATE_DIRS {
        let from = root.join(dir);
        let to = root.join(renamed_crate(dir, &answers.slug));
        std::fs::rename(&from, &to).map_err(|error| io_error("renaming", &from, &error))?;
    }
    context.log(&format!(
        "bootstrap: rewrote {} files and renamed {} crates",
        writes.len(),
        CRATE_DIRS.len()
    ));

    format(context)?;

    for path in REMOVED_PATHS {
        remove_path(&root.join(path))?;
    }
    warn_about_leftovers(context, answers);

    context.log("");
    context.log(&format!(
        "bootstrap: done. This checkout is now {} ({}, {}).",
        answers.name, answers.slug, answers.bundle_id
    ));
    for line in NEXT_STEPS {
        context.log(line);
    }
    Ok(())
}

/// Update Cargo.lock for the renamed crates and format them.
fn format(context: &Context<'_>) -> TaskResult {
    let partial = "the clone is half-rewritten: `git status` shows what changed; discard it and bootstrap a fresh clone after fixing the cause";
    run_step(
        context,
        "cargo",
        &["update", "--workspace", "--offline"],
        "ERR_BOOTSTRAP_LOCKFILE",
        "Cargo.lock could not be updated offline for the renamed crates",
        partial,
    )?;
    run_step(
        context,
        "cargo",
        &["fmt", "--all"],
        "ERR_BOOTSTRAP_FORMAT",
        "rustfmt failed on the renamed crates",
        partial,
    )
}

/// Warn about any line outside the site list that still names the template.
fn warn_about_leftovers(context: &Context<'_>, answers: &Answers) {
    let listed = git(
        context,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    );
    if !listed.success() {
        context.log(
            "bootstrap: not a git work tree, so the scan for placeholders outside the site list was skipped",
        );
        return;
    }
    let files: Vec<String> = listed
        .stdout_text()
        .split('\0')
        .filter(|file| !file.is_empty())
        .map(str::to_owned)
        .collect();
    let leftovers = find_leftovers(&context.root, &files, Some(answers));
    if leftovers.is_empty() {
        return;
    }
    context.log("");
    context.log("bootstrap: WARNING: these lines outside the site list still name the template:");
    for line in &leftovers {
        context.log(&format!("  {line}"));
    }
    context
        .log("  Rename them by hand, and add each site to xtask/src/bootstrap.rs in the template.");
}

/// The year (UTC) of a day counted from 1970-01-01, by the proleptic Gregorian calendar
/// (Howard Hinnant's `civil_from_days`).
fn year_of_day(days: i64) -> i64 {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    year_of_era + era * 400 + i64::from(month_index >= 10)
}

/// This year, in UTC, for the LICENSE line.
fn current_year() -> i64 {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    year_of_day(i64::try_from(seconds / 86_400).unwrap_or(0))
}

/// The task with its terminal and year given, so a test can fake both.
fn run(context: &Context<'_>, terminal: &mut dyn Terminal, year: i64) -> TaskResult {
    let parsed = parse_args(&context.argv)?;
    if parsed.help {
        context.log(USAGE);
        return Ok(());
    }
    let answers = collect_answers(&parsed, terminal, &|line| context.log(line))?;
    run_bootstrap(context, &answers, year)
}

pub(crate) fn main(context: &Context<'_>) -> TaskResult {
    let stdin = std::io::stdin();
    let interactive = stdin.is_terminal() && std::io::stdout().is_terminal();
    let mut terminal = LineTerminal {
        input: stdin.lock(),
        output: std::io::stdout(),
        interactive,
    };
    run(context, &mut terminal, current_year())
}

#[cfg(test)]
mod tests {
    //! Each run works on a throwaway tree in a temporary directory, synthesized from the
    //! task's own site list, so no test reads or writes this checkout; cargo and git are
    //! stubbed through the context's run function. The whole tree is proven
    //! by `just verify-bootstrap` and CI's Template Bootstrap Smoke.

    use std::cell::RefCell;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};

    use super::{
        Answers, CRATE_DIRS, Field, LineTerminal, MARKER_FILES, REMOVED_PATHS, Terminal,
        collect_answers, current_year, dependency_names, derive_names, find_leftovers, fold,
        justfile_bundle_id, main, parse_args, renamed_crate, run, sites, slug_from, text_edits,
        validate_field, year_of_day,
    };
    use crate::context::{Context, Env, RunOptions, RunResult};
    use crate::fail::{ScriptError, TaskResult};
    use crate::test_support::{Fake, temp_dir, write};

    const YEAR: i64 = 2031;

    fn answers() -> Answers {
        Answers {
            name: "Tide Pool".to_owned(),
            slug: "tide-pool".to_owned(),
            bundle_id: "com.example.tide-pool".to_owned(),
            repo: "ada/tide-pool".to_owned(),
            author: "Ada Lovelace".to_owned(),
            copyright: "Ada Lovelace and contributors".to_owned(),
        }
    }

    fn flags(answers: &Answers) -> Vec<String> {
        [
            ("--name", &answers.name),
            ("--slug", &answers.slug),
            ("--bundle-id", &answers.bundle_id),
            ("--repo", &answers.repo),
            ("--author", &answers.author),
            ("--copyright", &answers.copyright),
        ]
        .into_iter()
        .flat_map(|(flag, value)| [flag.to_owned(), value.clone()])
        .collect()
    }

    fn strings(words: &[&str]) -> Vec<String> {
        words.iter().map(ToString::to_string).collect()
    }

    /// One spelling of each placeholder form, as a site in the template carries it.
    fn sample(form: super::Form) -> &'static str {
        match form {
            super::Form::Name => "Welcome to MyApp.",
            super::Form::Slug => "cargo test -p myapp-core && pkill -x myapp",
            super::Form::SlugSnake => "use myapp_core::Counter; myapp_lib::run();",
            super::Form::SlugUpper => "MYAPP_SMOKE=1",
            super::Form::BundleId => "~/Library/Logs/com.example.myapp/",
            super::Form::Repo => "https://github.com/tomada1114/rust-template/security",
            super::Form::RepoName => "cd rust-template",
            super::Form::Owner => "[@tomada1114](https://github.com/tomada1114)",
        }
    }

    const CARGO_TOML: &str = "[workspace]\nmembers = [\"crates/*\"]\n\n[workspace.package]\nversion = \"0.4.2\" # the version site\nedition = \"2024\"\n\n[workspace.dependencies]\nmyapp-core = { path = \"crates/myapp-core\" }\n";

    const CHANGELOG: &str = "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n## [Unreleased]\n\n### Added\n\n- The template.\n\n## [0.4.2] - 2026-01-01\n\n- Earlier.\n";

    const LICENSE: &str =
        "MIT License\n\nCopyright (c) 2026 tomada1114\n\nPermission is hereby granted.\n";

    const CI_YML: &str = "name: CI\n\non:\n  pull_request:\n\njobs:\n  rust-core:\n    name: Rust Core\n    runs-on: ubuntu-24.04\n    steps:\n      - run: cargo clippy --workspace\n\n  bootstrap-smoke:\n    # Template-only.\n    name: Template Bootstrap Smoke\n    runs-on: ubuntu-24.04\n    steps:\n      - run: cargo xtask bootstrap --yes\n\n  zizmor:\n    name: Workflow Security Lint\n    runs-on: ubuntu-24.04\n    steps:\n      - run: zizmor .\n";

    const RULESET: &str = "{\n  \"rules\": [\n    {\n      \"type\": \"required_status_checks\",\n      \"parameters\": {\n        \"required_status_checks\": [\n          { \"context\": \"Rust Core\", \"integration_id\": 15368 },\n          { \"context\": \"Template Bootstrap Smoke\", \"integration_id\": 15368 },\n          { \"context\": \"Workflow Security Lint\", \"integration_id\": 15368 }\n        ]\n      }\n    }\n  ]\n}\n";

    fn justfile() -> String {
        format!(
            "bundle_id := \"com.example.myapp\"\nlog_prefix := \"myapp\"\n\n# Build\nbuild:\n    cargo build -p myapp\n    cargo install --locked --path crates/myapp\n{}{}",
            super::JUSTFILE_RECIPE,
            super::JUSTFILE_VERIFY_RECIPE
        )
    }

    const README: &str = "# MyApp\n\nIntro for MyApp.\n\n<!-- template-only -->\n**Starting from the template?** See below.\n<!-- /template-only -->\n\n## Quickstart\n\n```bash\ngit clone https://github.com/tomada1114/rust-template.git\ncd rust-template\n```\n\nThe data lives in ~/Library/Application Support/com.example.myapp/, and\nmyapp-core holds the logic.\n\n<!-- template-only -->\n## Using This Template\n\nEverything about `just bootstrap`.\n<!-- /template-only -->\n\n## License\n";

    /// A template tree holding every site the task lists: each listed form, each text
    /// edit's anchor, the marker files, the paths it removes, and the crate directories.
    fn template_tree() -> tempfile::TempDir {
        let dir = temp_dir();
        let root = dir.path();
        let mut contents: std::collections::BTreeMap<String, String> = [
            ("Cargo.toml", CARGO_TOML.to_owned()),
            ("CHANGELOG.md", CHANGELOG.to_owned()),
            ("LICENSE", LICENSE.to_owned()),
            (".github/workflows/ci.yml", CI_YML.to_owned()),
            (".github/rulesets/main.json", RULESET.to_owned()),
            ("justfile", justfile()),
            ("README.md", README.to_owned()),
        ]
        .into_iter()
        .map(|(file, text)| (file.to_owned(), text))
        .collect();
        let overridden: Vec<String> = contents.keys().cloned().collect();
        for (file, forms) in sites() {
            if overridden.contains(&file) {
                continue;
            }
            let lines: Vec<&str> = forms.iter().map(|form| sample(*form)).collect();
            let text = contents.entry(file).or_default();
            text.push_str(&lines.join("\n"));
            text.push('\n');
        }
        for edit in text_edits() {
            let text = contents.entry(edit.file).or_default();
            text.push('\n');
            text.push_str(edit.find);
            text.push('\n');
        }
        for (file, text) in &contents {
            write(root, file, text);
        }
        for removed in REMOVED_PATHS {
            if !root.join(removed).exists() {
                write(root, &format!("{removed}/notes.md"), "template\n");
            }
        }
        for dir in CRATE_DIRS {
            if !root.join(dir).exists() {
                write(root, &format!("{dir}/Cargo.toml"), "[package]\n");
            }
        }
        dir
    }

    fn read(root: &Path, path: &str) -> String {
        std::fs::read_to_string(root.join(path)).expect("read the file")
    }

    /// A terminal that answers from a queue and records every question.
    struct FakeTerminal {
        interactive: bool,
        answers: Vec<Option<&'static str>>,
        questions: Vec<String>,
    }

    fn terminal(answers: &[Option<&'static str>], interactive: bool) -> FakeTerminal {
        FakeTerminal {
            interactive,
            answers: answers.iter().rev().copied().collect(),
            questions: Vec::new(),
        }
    }

    impl Terminal for FakeTerminal {
        fn interactive(&self) -> bool {
            self.interactive
        }

        fn ask(&mut self, question: &str) -> Option<String> {
            self.questions.push(question.to_owned());
            self.answers.pop().flatten().map(str::to_owned)
        }
    }

    /// What one run did: its result, each command line it ran (with its cwd), and its log.
    struct Ran {
        result: TaskResult,
        commands: Vec<String>,
        cwds: Vec<Option<PathBuf>>,
        lines: Vec<String>,
    }

    impl Ran {
        fn code(&self) -> String {
            match &self.result {
                Ok(()) => panic!("expected a failure; the task logged {:?}", self.lines),
                Err(error) => error.details.code.clone(),
            }
        }

        fn error(&self) -> &ScriptError {
            self.result.as_ref().expect_err("a failure")
        }

        fn output(&self) -> String {
            self.lines.join("\n")
        }
    }

    /// Run the task at `root` with `argv`, answering each command line through `answer`.
    fn bootstrap(
        root: &Path,
        argv: &[String],
        terminal: &mut dyn Terminal,
        answer: &dyn Fn(&str) -> RunResult,
    ) -> Ran {
        let calls = RefCell::new(Vec::new());
        let lines = RefCell::new(Vec::new());
        let runner = |command: &str, args: &[&str], options: &RunOptions| {
            let line = std::iter::once(command)
                .chain(args.iter().copied())
                .collect::<Vec<_>>()
                .join(" ");
            calls.borrow_mut().push((line.clone(), options.cwd.clone()));
            answer(&line)
        };
        let log = |line: &str| lines.borrow_mut().push(line.to_owned());
        let context = Context {
            argv: argv.to_vec(),
            env: Env::new(),
            root: root.to_path_buf(),
            run: &runner,
            log: &log,
            stdin: None,
        };
        let result = run(&context, terminal, YEAR);
        drop(context);
        let (commands, cwds) = calls.into_inner().into_iter().unzip();
        Ran {
            result,
            commands,
            cwds,
            lines: lines.into_inner(),
        }
    }

    fn ok(_: &str) -> RunResult {
        RunResult::exited(0, "", "")
    }

    /// The task run with every value as a flag and `--yes`.
    fn with_answers(root: &Path, answers: &Answers, answer: &dyn Fn(&str) -> RunResult) -> Ran {
        let mut argv = flags(answers);
        argv.push("--yes".to_owned());
        bootstrap(root, &argv, &mut terminal(&[], false), answer)
    }

    #[test]
    fn reads_every_value_flag_in_both_spellings_and_yes() {
        let parsed = parse_args(&strings(&[
            "--name",
            "Tide Pool",
            "--slug=tide-pool",
            "--bundle-id",
            "com.example.tide-pool",
            "--repo",
            "ada/tide-pool",
            "--author",
            "Ada",
            "--copyright",
            "Ada",
            "--yes",
        ]))
        .expect("parsed");
        assert!(parsed.yes);
        assert!(!parsed.help);
        assert_eq!(
            parsed.values.get(&Field::Slug).map(String::as_str),
            Some("tide-pool")
        );
        assert_eq!(parsed.values.len(), 6);
        let short = parse_args(&strings(&["-y", "--help"])).expect("parsed");
        assert!(short.yes && short.help && short.values.is_empty());
    }

    #[test]
    fn refuses_unknown_flags_missing_values_repeats_and_stray_words() {
        for argv in [
            &["--colour", "red"][..],
            &["--name"],
            &["--name", "--yes"],
            &["--slug", "a", "--slug", "b"],
            &["--yes=1"],
        ] {
            let error = parse_args(&strings(argv)).expect_err("refused");
            assert_eq!(error.code(), "ERR_BOOTSTRAP_USAGE", "{argv:?}");
        }
        let error = parse_args(&strings(&["--name", "Tide", "Pool"])).expect_err("refused");
        assert_eq!(error.details.summary, "unexpected argument 'Pool'");
    }

    #[test]
    fn accepts_and_trims_valid_values() {
        assert_eq!(
            validate_field(Field::Name, "  Tide Pool ").expect("ok"),
            "Tide Pool"
        );
        assert_eq!(validate_field(Field::Name, "Café 2").expect("ok"), "Café 2");
        assert_eq!(
            validate_field(Field::Slug, "tide-pool").expect("ok"),
            "tide-pool"
        );
        assert_eq!(
            validate_field(Field::BundleId, "com.example.tide-pool").expect("ok"),
            "com.example.tide-pool"
        );
        assert_eq!(
            validate_field(Field::BundleId, "dev.example.x1").expect("ok"),
            "dev.example.x1"
        );
        assert_eq!(
            validate_field(Field::Repo, "ada-l/tide.pool").expect("ok"),
            "ada-l/tide.pool"
        );
        assert_eq!(
            validate_field(Field::Author, " Ada Lovelace ").expect("ok"),
            "Ada Lovelace"
        );
        // A user may legitimately be the template's owner.
        assert_eq!(
            validate_field(Field::Author, "tomada1114").expect("ok"),
            "tomada1114"
        );
    }

    #[test]
    fn refuses_invalid_values_with_the_fields_code() {
        let long_name = "x".repeat(51);
        let cases: Vec<(Field, &str, &str)> = vec![
            (Field::Name, "", "NAME"),
            (Field::Name, "MyApp", "NAME"),
            (Field::Name, "Say \"hi\"", "NAME"),
            (Field::Name, "a/b", "NAME"),
            (Field::Name, "Tide  Pool", "NAME"),
            (Field::Name, &long_name, "NAME"),
            (Field::Name, "MyApp Pro", "NAME"),
            (Field::Slug, "myapp", "SLUG"),
            (Field::Slug, "x-myapp", "SLUG"),
            (Field::Slug, "Tide", "SLUG"),
            (Field::Slug, "tide_pool", "SLUG"),
            (Field::Slug, "-tide", "SLUG"),
            (Field::Slug, "tide--pool", "SLUG"),
            (Field::Slug, "2tide", "SLUG"),
            (Field::Slug, "core", "SLUG"),
            (Field::Slug, "test", "SLUG"),
            (Field::Slug, "fn", "SLUG"),
            (Field::Slug, "build", "SLUG"),
            (Field::Slug, "incremental", "SLUG"),
            (Field::Slug, "con", "SLUG"),
            (Field::BundleId, "com.example.myapp", "BUNDLE_ID"),
            (Field::BundleId, "tidepool", "BUNDLE_ID"),
            (Field::BundleId, "com.example.tide_pool", "BUNDLE_ID"),
            (Field::BundleId, "com..tide", "BUNDLE_ID"),
            (Field::BundleId, "com.example.tide.app", "BUNDLE_ID"),
            (Field::BundleId, "-dev.example.x", "BUNDLE_ID"),
            (Field::BundleId, "dev.example.x-", "BUNDLE_ID"),
            (Field::BundleId, "1.2", "BUNDLE_ID"),
            (Field::BundleId, "dev.-x.y", "BUNDLE_ID"),
            (Field::BundleId, "com.apple.tide", "BUNDLE_ID"),
            (Field::Repo, "tomada1114/rust-template", "REPO"),
            (Field::Repo, "someone/rust-template", "REPO"),
            (Field::Repo, "ada", "REPO"),
            (Field::Repo, "ada/tide/pool", "REPO"),
            (Field::Repo, "-ada/tide", "REPO"),
            (Field::Repo, "ada/..", "REPO"),
            (Field::Repo, "ada/tide.git", "REPO"),
            (Field::Author, "", "AUTHOR"),
            (Field::Author, "Ada\u{7}", "AUTHOR"),
            (Field::Author, "the myapp team", "AUTHOR"),
            (Field::Copyright, " ", "COPYRIGHT"),
            (Field::Copyright, "Rust-Template Inc.", "COPYRIGHT"),
        ];
        for (field, value, code) in cases {
            let error = validate_field(field, value).expect_err(value);
            assert_eq!(
                error.code(),
                format!("ERR_BOOTSTRAP_INVALID_{code}"),
                "{value}"
            );
        }
        let error = validate_field(Field::BundleId, "com.example.tide.app").expect_err("app");
        assert_eq!(
            error.details.summary,
            "\"com.example.tide.app\" is not a valid bundle identifier"
        );
    }

    #[test]
    fn spells_the_slug_for_crates_identifiers_and_environment_variables() {
        let names = derive_names(&answers());
        assert_eq!(names.slug, "tide-pool");
        assert_eq!(names.slug_snake, "tide_pool");
        assert_eq!(names.slug_upper, "TIDE_POOL");
        assert_eq!(names.owner, "ada");
        assert_eq!(names.repo_name, "tide-pool");
    }

    #[test]
    fn moves_only_the_template_crate_directories() {
        for (path, expected) in [
            ("crates/myapp", "crates/tide-pool"),
            ("crates/myapp/src/main.rs", "crates/tide-pool/src/main.rs"),
            ("crates/myapp-core", "crates/tide-pool-core"),
            (
                "crates/myapp-platform/src/paths.rs",
                "crates/tide-pool-platform/src/paths.rs",
            ),
            ("crates/myappish", "crates/myappish"),
            ("justfile", "justfile"),
            ("docs/crates/myapp", "docs/crates/myapp"),
        ] {
            assert_eq!(renamed_crate(path, "tide-pool"), expected);
        }
    }

    #[test]
    fn suggests_a_slug_from_the_display_name() {
        assert_eq!(slug_from("Tide Pool"), "tide-pool");
        assert_eq!(slug_from("  Café Société 2 "), "cafe-societe-2");
        assert_eq!(slug_from("Ünïcödé Žebra"), "unicode-zebra");
        assert_eq!(fold('ŷ'), 'y');
        assert_eq!(fold('京'), '京');
    }

    #[test]
    fn counts_years_from_the_epoch() {
        assert_eq!(year_of_day(0), 1970);
        assert_eq!(year_of_day(20_453), 2025);
        assert_eq!(year_of_day(20_454), 2026);
        assert_eq!(year_of_day(-1), 1969);
        assert!(current_year() >= 2026);
    }

    #[test]
    fn takes_every_value_from_the_flags_without_asking_when_yes_is_given() {
        let mut argv = flags(&answers());
        argv.push("--yes".to_owned());
        let mut fake = terminal(&[], true);
        let collected =
            collect_answers(&parse_args(&argv).expect("parsed"), &mut fake, &|_| {}).expect("ok");
        assert_eq!(collected, answers());
        assert!(fake.questions.is_empty());
    }

    #[test]
    fn fills_the_slug_and_copyright_holder_from_their_defaults_when_not_interactive() {
        let argv = strings(&[
            "--name",
            "Tide Pool",
            "--bundle-id",
            "com.example.tide-pool",
            "--repo",
            "ada/tide-pool",
            "--author",
            "Ada Lovelace",
        ]);
        let collected = collect_answers(
            &parse_args(&argv).expect("parsed"),
            &mut terminal(&[], false),
            &|_| {},
        )
        .expect("ok");
        assert_eq!(
            collected,
            Answers {
                copyright: "Ada Lovelace".to_owned(),
                ..answers()
            }
        );
    }

    #[test]
    fn names_every_missing_flag_when_it_cannot_ask_and_refuses_invalid_flags() {
        let parsed = parse_args(&strings(&["--name", "Tide Pool"])).expect("parsed");
        let error =
            collect_answers(&parsed, &mut terminal(&[], false), &|_| {}).expect_err("missing");
        assert_eq!(error.code(), "ERR_BOOTSTRAP_MISSING_VALUE");
        assert!(
            error
                .details
                .actual
                .contains("--bundle-id, --repo, --author")
        );
        // A name that suggests no slug leaves the slug missing too.
        let parsed = parse_args(&strings(&["--name", "2 Pools"])).expect("parsed");
        let error =
            collect_answers(&parsed, &mut terminal(&[], false), &|_| {}).expect_err("missing");
        assert!(error.details.actual.starts_with("missing: --slug, "));
        let parsed = parse_args(&strings(&["--slug", "Bad"])).expect("parsed");
        let error =
            collect_answers(&parsed, &mut terminal(&[], false), &|_| {}).expect_err("invalid");
        assert_eq!(error.code(), "ERR_BOOTSTRAP_INVALID_SLUG");
    }

    #[test]
    fn asks_for_missing_values_offers_defaults_re_asks_and_confirms() {
        let lines = RefCell::new(Vec::new());
        let mut fake = terminal(
            &[
                Some(""), // slug: take the default
                Some("not a bundle id"),
                Some("com.example.tide-pool"),
                Some("ada/tide-pool"),
                Some("Ada Lovelace"),
                Some("Ada Lovelace and contributors"),
                Some("y"),
            ],
            true,
        );
        let parsed = parse_args(&strings(&["--name", "Tide Pool"])).expect("parsed");
        let collected = collect_answers(&parsed, &mut fake, &|line| {
            lines.borrow_mut().push(line.to_owned());
        })
        .expect("ok");
        assert_eq!(collected, answers());
        assert!(fake.questions[0].contains("[tide-pool]"));
        assert_eq!(
            fake.questions
                .iter()
                .filter(|question| question.starts_with("Bundle identifier"))
                .count(),
            2
        );
        let shown = lines.into_inner().join("\n");
        assert!(shown.contains("ERR_BOOTSTRAP_INVALID_BUNDLE_ID"), "{shown}");
        assert!(shown.contains("  Display name: Tide Pool"), "{shown}");
        assert!(
            fake.questions
                .last()
                .is_some_and(|q| q.contains("Rewrite this checkout"))
        );
    }

    #[test]
    fn stops_when_the_confirmation_is_declined_or_input_ends() {
        let all = parse_args(&flags(&answers())).expect("parsed");
        for reply in [Some("n"), None] {
            let error =
                collect_answers(&all, &mut terminal(&[reply], true), &|_| {}).expect_err("no");
            assert_eq!(error.code(), "ERR_BOOTSTRAP_ABORTED");
        }
        let name = parse_args(&strings(&["--name", "Tide Pool"])).expect("parsed");
        let error = collect_answers(&name, &mut terminal(&[None], true), &|_| {}).expect_err("end");
        assert_eq!(error.code(), "ERR_BOOTSTRAP_ABORTED");
        let error = collect_answers(
            &name,
            &mut terminal(&[Some("Bad"), Some("Bad"), Some("Bad")], true),
            &|_| {},
        )
        .expect_err("three");
        assert_eq!(error.code(), "ERR_BOOTSTRAP_INVALID_SLUG");
    }

    #[test]
    fn asks_a_line_terminal_and_reports_the_end_of_input() {
        let mut shown = Vec::new();
        let mut line = LineTerminal {
            input: Cursor::new("Tide Pool\r\ntide-pool\n"),
            output: &mut shown,
            interactive: false,
        };
        assert!(!line.interactive());
        assert_eq!(line.ask("Name: ").as_deref(), Some("Tide Pool"));
        assert_eq!(line.ask("Slug: ").as_deref(), Some("tide-pool"));
        assert_eq!(line.ask("Bundle: "), None);
        assert_eq!(String::from_utf8_lossy(&shown), "Name: Slug: Bundle: ");
    }

    #[test]
    fn lists_each_site_once_and_keeps_the_skill_trees_in_step() {
        let all = sites();
        let mut files: Vec<&String> = all.iter().map(|(file, _)| file).collect();
        files.dedup();
        assert_eq!(files.len(), all.len());
        for (file, forms) in &all {
            assert!(!forms.is_empty(), "{file}");
            if let Some(rest) = file.strip_prefix(".agents/") {
                let mirror = all
                    .iter()
                    .find(|(other, _)| *other == format!(".claude/{rest}"));
                assert_eq!(mirror.map(|(_, forms)| *forms), Some(*forms), "{file}");
            }
        }
        assert!(REMOVED_PATHS.contains(&"xtask/src/bootstrap.rs"));
        assert!(REMOVED_PATHS.contains(&"xtask/src/verify_bootstrap.rs"));
        assert_eq!(MARKER_FILES, ["README.md"]);
    }

    #[test]
    fn rewrites_every_site_renames_the_crates_and_resets_the_history() {
        let dir = template_tree();
        let root = dir.path();
        let ran = with_answers(root, &answers(), &ok);
        if let Err(error) = &ran.result {
            panic!("{error}");
        }

        let cargo = read(root, "Cargo.toml");
        assert!(cargo.contains("version = \"0.1.0\" # the version site"));
        assert!(cargo.contains("tide-pool-core = { path = \"crates/tide-pool-core\" }"));
        assert!(
            read(root, "LICENSE").contains("Copyright (c) 2031 Ada Lovelace and contributors\n")
        );
        assert_eq!(
            read(root, "CHANGELOG.md"),
            "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n## [Unreleased]\n"
        );

        let agents = read(root, "AGENTS.md");
        assert!(agents.contains("cargo test -p tide-pool-core && pkill -x tide-pool"));
        assert!(agents.contains("use tide_pool_core::Counter; tide_pool_lib::run();"));
        assert!(agents.contains("~/Library/Logs/com.example.tide-pool/"));
        assert!(read(root, ".agents/skills/designing-clis/SKILL.md").contains("TIDE_POOL_SMOKE=1"));
        assert!(read(root, "CODE_OF_CONDUCT.md").contains("[@ada](https://github.com/ada)"));
        assert!(read(root, "SECURITY.md").contains("https://github.com/ada/tide-pool/security"));
        // The Product section's introduction holds no marker of its own in an app.
        assert!(!agents.contains("**TODO:"));
        assert!(agents.contains("fails while one still holds its `TODO` marker"));

        let readme = read(root, "README.md");
        assert!(!readme.contains("template-only"));
        assert!(!readme.contains("just bootstrap"));
        assert!(readme.contains("# Tide Pool\n\nIntro for Tide Pool.\n\n## Quickstart"));
        assert!(readme.contains("git clone https://github.com/ada/tide-pool.git\ncd tide-pool\n"));
        assert!(readme.contains("\n\n## License\n"));
        assert!(!readme.contains("\n\n\n"));

        let ci = read(root, ".github/workflows/ci.yml");
        assert!(!ci.contains("bootstrap"));
        assert!(ci.contains("cargo clippy --workspace\n\n  zizmor:\n"));
        let ruleset = read(root, ".github/rulesets/main.json");
        assert!(!ruleset.contains("Template Bootstrap Smoke"));
        assert!(serde_json::from_str::<serde_json::Value>(&ruleset).is_ok());
        assert_eq!(
            read(root, "justfile"),
            "bundle_id := \"com.example.tide-pool\"\nlog_prefix := \"tide-pool\"\n\n# Build\nbuild:\n    cargo build -p tide-pool\n    cargo install --locked --path crates/tide-pool\n"
        );
        let main_rs = read(root, "xtask/src/main.rs");
        assert!(!main_rs.contains("bootstrap"), "{main_rs}");

        for dir in CRATE_DIRS {
            assert!(!root.join(dir).exists(), "{dir}");
            assert!(root.join(renamed_crate(dir, "tide-pool")).exists(), "{dir}");
        }
        for removed in REMOVED_PATHS {
            assert!(!root.join(removed).exists(), "{removed}");
        }
        for edit in text_edits() {
            let file = renamed_crate(&edit.file, "tide-pool");
            if let Ok(text) = std::fs::read_to_string(root.join(&file)) {
                assert!(!text.contains(edit.find), "{file}: {}", edit.find);
            }
        }

        assert_commands_and_next_steps(root, &ran);
    }

    /// The commands a successful run made, in order, and the next steps it printed.
    fn assert_commands_and_next_steps(root: &Path, ran: &Ran) {
        // cargo fetch before anything is written, then the offline lockfile update and fmt.
        let commands: Vec<&str> = ran.commands.iter().map(String::as_str).collect();
        assert_eq!(
            commands,
            [
                "git rev-parse --is-inside-work-tree",
                "git status --porcelain",
                "cargo fetch --locked",
                "cargo update --workspace --offline",
                "cargo fmt --all",
                "git ls-files -z --cached --others --exclude-standard",
            ]
        );
        assert!(ran.cwds.iter().all(|cwd| cwd.as_deref() == Some(root)));

        let output = ran.output();
        for step in [
            "rewrote",
            "AGENTS.md",
            "docs/architecture/roadmap.md",
            "steering-the-roadmap",
            "commit it as one commit",
            "just labels",
            "add `dependencies` by hand",
            "just ruleset",
            "secret scanning",
            "Renovate",
            "push both commits to",
        ] {
            assert!(output.contains(step), "{step}");
        }
    }

    #[test]
    fn writes_nothing_when_the_tree_is_not_the_template() {
        let dir = template_tree();
        write(
            dir.path(),
            "justfile",
            "bundle_id := 'com.acme.app' # renamed\n",
        );
        let ran = with_answers(dir.path(), &answers(), &ok);
        assert_eq!(ran.code(), "ERR_BOOTSTRAP_NOT_TEMPLATE");
        assert_eq!(ran.error().details.actual, "identifier \"com.acme.app\"");
        assert!(ran.commands.is_empty());

        let dir = template_tree();
        std::fs::remove_dir_all(dir.path().join("crates/myapp-core")).expect("remove");
        write(dir.path(), "justfile", "no identifier here\n");
        let ran = with_answers(dir.path(), &answers(), &ok);
        assert_eq!(ran.code(), "ERR_BOOTSTRAP_NOT_TEMPLATE");
        assert_eq!(
            ran.error().details.actual,
            "identifier null; missing crates/myapp-core"
        );
        assert_eq!(justfile_bundle_id("bundle_id := \"x\" trailing"), None);
    }

    /// The first error code of a run on a template tree that `damage` changed, and
    /// whether it ran no command.
    fn damaged(damage: &dyn Fn(&Path)) -> (String, String, bool) {
        let dir = template_tree();
        damage(dir.path());
        let before = read(dir.path(), "README.md");
        let ran = with_answers(dir.path(), &answers(), &ok);
        assert_eq!(read(dir.path(), "README.md"), before, "README.md changed");
        (
            ran.code(),
            ran.error().details.actual.clone(),
            ran.commands.is_empty(),
        )
    }

    fn replace_in(root: &Path, file: &str, from: &str, to: &str) {
        let text = read(root, file);
        assert!(text.contains(from), "{file} lacks {from}");
        write(root, file, text.replacen(from, to, 1));
    }

    #[test]
    fn writes_nothing_when_a_site_or_an_edit_anchor_drifted() {
        let (code, actual, quiet) =
            damaged(&|root| write(root, "AGENTS.md", "no placeholders here\n"));
        assert_eq!(code, "ERR_BOOTSTRAP_SITE_MISSING");
        assert!(
            actual.starts_with("0 occurrence(s) of the passage starting"),
            "{actual}"
        );
        assert!(quiet);

        let (code, actual, _) = damaged(&|root| {
            let file = "xtask/src/check_harness/core_boundary.rs";
            write(root, file, "nothing\n");
        });
        assert_eq!(code, "ERR_BOOTSTRAP_SITE_MISSING");
        assert_eq!(actual, "no Slug placeholder (myapp)");

        let (code, actual, _) = damaged(&|root| {
            let file = ".claude/rules/testing.md";
            let text = read(root, file);
            write(root, file, format!("{text}MYAPP_LOG=1\n"));
        });
        assert_eq!(code, "ERR_BOOTSTRAP_SITE_INCOMPLETE");
        assert!(actual.contains(".claude/rules/testing.md:"), "{actual}");

        let (code, _, quiet) = damaged(&|root| {
            replace_in(
                root,
                "README.md",
                "<!-- /template-only -->\n\n## Q",
                "\n## Q",
            );
        });
        assert_eq!(code, "ERR_BOOTSTRAP_MARKER");
        assert!(quiet);
        for (text, actual) in [
            (
                "<!-- template-only -->\n<!-- template-only -->\n",
                "a second start marker inside an open block",
            ),
            (
                "<!-- /template-only -->\n",
                "an end marker with no open block",
            ),
        ] {
            let (code, found, _) = damaged(&|root| {
                let readme = read(root, "README.md");
                write(root, "README.md", format!("{text}{readme}"));
            });
            assert_eq!(
                (code.as_str(), found.as_str()),
                ("ERR_BOOTSTRAP_MARKER", actual)
            );
        }
        let (code, actual, _) = damaged(&|root| {
            let readme = read(root, "README.md").replace("template-only", "kept");
            write(root, "README.md", readme);
        });
        assert_eq!(
            (code.as_str(), actual.as_str()),
            ("ERR_BOOTSTRAP_SITE_MISSING", "no template-only block")
        );
    }

    #[test]
    fn writes_nothing_when_a_structured_site_drifted() {
        for (file, from, to, actual) in [
            (
                ".github/workflows/ci.yml",
                "  bootstrap-smoke:",
                "  renamed:",
                "no `bootstrap-smoke:` job",
            ),
            (
                ".github/rulesets/main.json",
                "\"Template Bootstrap Smoke\"",
                "\"renamed\"",
                "0 occurrence(s) of the \"Template Bootstrap Smoke\" context",
            ),
            (
                "justfile",
                "verify-bootstrap *args:",
                "renamed",
                "0 copies of the verify-bootstrap recipe",
            ),
            (
                "CHANGELOG.md",
                "## [Unreleased]",
                "## Next",
                "no `## [Unreleased]` heading",
            ),
            (
                "Cargo.toml",
                "version = \"0.4.2\"",
                "rust-version = \"1.0\"",
                "no version under [workspace.package]",
            ),
            (
                "LICENSE",
                "2026 tomada1114",
                "2026 someone",
                "0 occurrence(s) of the template's copyright line",
            ),
        ] {
            let (code, found, quiet) = damaged(&|root| replace_in(root, file, from, to));
            assert_eq!(
                (code.as_str(), found.as_str()),
                ("ERR_BOOTSTRAP_SITE_MISSING", actual),
                "{file}"
            );
            assert!(quiet, "{file}");
        }
        let (code, actual, _) = damaged(&|root| {
            let text = read(root, "justfile");
            write(
                root,
                "justfile",
                format!("{text}{}", super::JUSTFILE_RECIPE),
            );
        });
        assert_eq!(
            (code.as_str(), actual.as_str()),
            (
                "ERR_BOOTSTRAP_SITE_MISSING",
                "2 copies of the bootstrap recipe"
            )
        );
    }

    #[test]
    fn writes_nothing_when_an_edit_breaks_the_files_shape() {
        for (file, from, to) in [
            // The job is the last one, and the only one left would be the smoke's twin.
            (
                ".github/workflows/ci.yml",
                "  zizmor:\n    name: Workflow Security Lint",
                "  twin:\n    name: Template Bootstrap Smoke",
            ),
            (
                ".github/workflows/ci.yml",
                "      - run: zizmor .\n",
                "      - run: [unclosed\n",
            ),
            (".github/rulesets/main.json", "  ]\n}", "  ]\n"),
            (
                "Cargo.toml",
                "version = \"0.4.2\" # the version site",
                "description = \"\"\"\nversion = \"inside a string\"\n\"\"\"\nversion = \"0.4.2\"",
            ),
        ] {
            let (code, _, quiet) = damaged(&|root| replace_in(root, file, from, to));
            assert_eq!(code, "ERR_BOOTSTRAP_REWRITE", "{file}: {to}");
            assert!(quiet);
        }
        // A smoke job at the end of the file leaves no trailing blank lines behind.
        let dir = template_tree();
        let root = dir.path();
        let ci = read(root, ".github/workflows/ci.yml");
        let (head, tail) = ci.split_once("  bootstrap-smoke:").expect("job");
        let (smoke, rest) = tail.split_once("\n\n  zizmor:").expect("next job");
        write(
            root,
            ".github/workflows/ci.yml",
            format!("{head}  zizmor:{rest}\n  bootstrap-smoke:{smoke}\n\n"),
        );
        let ran = with_answers(root, &answers(), &ok);
        ran.result.as_ref().expect("bootstrapped");
        let ci = read(root, ".github/workflows/ci.yml");
        assert!(ci.ends_with("      - run: zizmor .\n"), "{ci}");
    }

    fn failing(prefix: &'static str, status: i32) -> impl Fn(&str) -> RunResult {
        move |line| {
            if line.starts_with(prefix) || line.contains(prefix) {
                RunResult::exited(status, "", "first\nsecond\nthird\nnetwork down\n")
            } else {
                RunResult::exited(0, "", "")
            }
        }
    }

    #[test]
    fn writes_nothing_when_cargo_cannot_fetch_and_reports_later_steps() {
        let dir = template_tree();
        let before = read(dir.path(), "AGENTS.md");
        let ran = with_answers(dir.path(), &answers(), &failing("cargo fetch", 101));
        assert_eq!(ran.code(), "ERR_BOOTSTRAP_FETCH");
        assert_eq!(
            ran.error().details.actual,
            "exit 101: second third network down"
        );
        assert_eq!(read(dir.path(), "AGENTS.md"), before);

        for (prefix, code) in [
            ("cargo update", "ERR_BOOTSTRAP_LOCKFILE"),
            ("cargo fmt", "ERR_BOOTSTRAP_FORMAT"),
        ] {
            let dir = template_tree();
            let ran = with_answers(dir.path(), &answers(), &failing(prefix, 2));
            assert_eq!(ran.code(), code, "{prefix}");
        }
        let dir = template_tree();
        let ran = with_answers(dir.path(), &answers(), &|line| {
            if line.starts_with("cargo update") {
                RunResult::default()
            } else {
                RunResult::exited(0, "", "")
            }
        });
        assert!(ran.error().details.actual.starts_with("exit none"));
    }

    #[test]
    fn warns_about_a_placeholder_outside_the_site_list_and_skips_the_scan_outside_git() {
        let dir = template_tree();
        write(dir.path(), "docs/new-page.md", "Run MyApp.\n");
        let ran = with_answers(dir.path(), &answers(), &|line| {
            if line.starts_with("git ls-files") {
                RunResult::exited(0, "docs/new-page.md\0AGENTS.md\0", "")
            } else {
                RunResult::exited(0, "", "")
            }
        });
        ran.result.as_ref().expect("bootstrapped");
        assert!(
            ran.output().contains("  docs/new-page.md:1: Run MyApp."),
            "{}",
            ran.output()
        );

        let dir = template_tree();
        let ran = with_answers(dir.path(), &answers(), &|line| {
            if line.starts_with("git") {
                RunResult::exited(128, "", "fatal: not a git repository")
            } else {
                RunResult::exited(0, "", "")
            }
        });
        ran.result.as_ref().expect("bootstrapped");
        assert!(ran.output().contains("not a git work tree"));
    }

    const CARGO_LOCK: &str = "version = 4\n\n[[package]]\nname = \"myapp-core\"\nversion = \"0.4.2\"\n\n[[package]]\nname = \"ratatui\"\nversion = \"0.30.0\"\n\n[[package]]\nname = \"serde_json\"\nversion = \"1.0.0\"\n\n[[package]]\nname = \"serde\"\nversion = \"1.0.0\"\n\n[[package]]\nname = \"clap\"\nversion = \"4.0.0\"\n";

    /// A template tree with a lockfile and a dependency only `[workspace.dependencies]`
    /// names.
    fn tree_with_dependencies() -> tempfile::TempDir {
        let dir = template_tree();
        write(dir.path(), "Cargo.lock", CARGO_LOCK);
        let cargo = CARGO_TOML.replace(
            "\n\n[workspace.dependencies]\n",
            "\n\n[workspace.dependencies]\ntracing = \"0.1\"\n",
        );
        write(dir.path(), "Cargo.toml", cargo);
        dir
    }

    #[test]
    fn refuses_a_slug_that_names_a_dependency_or_whose_crates_would() {
        for slug in ["ratatui", "serde", "clap", "tracing", "serde-json"] {
            let dir = tree_with_dependencies();
            let ran = with_answers(
                dir.path(),
                &Answers {
                    slug: slug.to_owned(),
                    ..answers()
                },
                &ok,
            );
            assert_eq!(ran.code(), "ERR_BOOTSTRAP_INVALID_SLUG", "{slug}");
            assert!(ran.commands.is_empty(), "{slug}");
            assert!(
                CRATE_DIRS
                    .iter()
                    .all(|crate_dir| dir.path().join(crate_dir).exists())
            );
        }
        let dir = tree_with_dependencies();
        let names = dependency_names(dir.path()).expect("names");
        assert!(
            names.contains("ratatui") && names.contains("serde-json") && names.contains("tracing")
        );
        assert!(!names.contains("myapp-core"));
    }

    #[test]
    fn refuses_a_dirty_work_tree_or_a_failing_status_before_cargo_runs() {
        for (stdout, status, summary) in [
            (
                " M README.md\n?? notes.txt\n",
                0,
                "has uncommitted or untracked changes",
            ),
            ("", 128, "so its cleanliness is unknown"),
        ] {
            let dir = tree_with_dependencies();
            let ran = with_answers(dir.path(), &answers(), &|line| {
                if line == "git status --porcelain" {
                    RunResult::exited(
                        status,
                        stdout,
                        "fatal: Unable to create '.git/index.lock'\n",
                    )
                } else {
                    RunResult::exited(0, "", "")
                }
            });
            assert_eq!(ran.code(), "ERR_BOOTSTRAP_DIRTY");
            assert!(ran.error().details.summary.contains(summary));
            assert!(ran.error().details.summary.contains("nothing was written"));
            assert_eq!(
                ran.commands,
                [
                    "git rev-parse --is-inside-work-tree",
                    "git status --porcelain"
                ]
            );
        }
        let many = (0..7)
            .map(|index| format!("?? file{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let dir = template_tree();
        let ran = with_answers(dir.path(), &answers(), &|line| {
            if line == "git status --porcelain" {
                RunResult::exited(0, &many, "")
            } else {
                RunResult::exited(0, "", "")
            }
        });
        assert!(ran.error().details.actual.ends_with("(and 2 more)"));
        // `git rev-parse` answering false (inside .git) counts as no work tree.
        let dir = template_tree();
        let ran = with_answers(dir.path(), &answers(), &|line| {
            if line.starts_with("git rev-parse") {
                RunResult::exited(0, "false\n", "")
            } else {
                RunResult::exited(0, "", "")
            }
        });
        ran.result.as_ref().expect("bootstrapped");
        assert!(
            !ran.commands
                .iter()
                .any(|command| command == "git status --porcelain")
        );
    }

    #[test]
    fn finds_every_placeholder_form_and_skips_binary_and_missing_files() {
        let dir = temp_dir();
        let root = dir.path();
        write(
            root,
            "a.md",
            "MyApp\nfine\nmyapp_core\nMYAPP_SMOKE\ncom.example.myapp\n",
        );
        write(
            root,
            "b.md",
            "https://github.com/tomada1114/rust-template\n",
        );
        write(root, "bin.png", "\0myapp");
        std::fs::create_dir(root.join("dir")).expect("mkdir");
        let files = strings(&["a.md", "b.md", "bin.png", "gone.md", "dir"]);
        assert_eq!(
            find_leftovers(root, &files, None),
            [
                "a.md:1: MyApp",
                "a.md:3: myapp_core",
                "a.md:4: MYAPP_SMOKE",
                "a.md:5: com.example.myapp",
                "b.md:1: https://github.com/tomada1114/rust-template",
            ]
        );
        // The owner's own name is no placeholder for an app the owner cuts.
        let owner = Answers {
            author: "tomada1114".to_owned(),
            ..answers()
        };
        assert_eq!(
            find_leftovers(root, &strings(&["b.md"]), Some(&owner)),
            ["b.md:1: https://github.com/tomada1114/rust-template"]
        );
    }

    #[test]
    fn prints_the_usage_for_help_and_changes_nothing() {
        let dir = template_tree();
        let ran = bootstrap(
            dir.path(),
            &strings(&["--help"]),
            &mut terminal(&[], false),
            &ok,
        );
        ran.result.as_ref().expect("usage");
        assert!(ran.output().starts_with("usage: cargo xtask bootstrap"));
        assert!(ran.commands.is_empty());

        let outcome = Fake::at(dir.path()).argv(&["-h"]).task(main);
        outcome.assert_ok();
        assert!(outcome.lines[0].starts_with("usage: cargo xtask bootstrap"));
        let outcome = Fake::at(dir.path()).argv(&["--bogus"]).task(main);
        assert_eq!(outcome.code(), "ERR_BOOTSTRAP_USAGE");
    }
}
