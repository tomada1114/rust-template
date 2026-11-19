//! The four sub-agent tiers under `.claude/agents/` exist and load: a skill or session
//! hands a step to one by `subagent_type`, and a tier file that is missing, misnamed, or
//! has no model would leave that hand-off running on whatever default the host picks.
//!
//! For each tier in [`TIERS`], `.claude/agents/<tier>.md` exists, opens with a `---`
//! line closed by a later `---` line, and its block parses as YAML (duplicate keys
//! rejected) into a mapping whose `name` is `<tier>` and whose `model` and `effort` are
//! non-empty strings. Structure only: which model and effort a tier carries is the
//! file's own decision, made in review.
//!
//! Errors: `ERR_CHECK_AGENT_TIER` (one per fault).

use super::yaml::{self, Keys, Node};
use super::{Input, finding, read_file};
use crate::fail::FailureDetails;

/// The tiers every skill and AGENTS.md may name.
pub(super) const TIERS: [&str; 4] = ["executor", "architect", "scout", "worker"];

const DIR: &str = ".claude/agents";

fn violation(tier: &str, actual: impl Into<String>) -> FailureDetails {
    finding(
        "ERR_CHECK_AGENT_TIER",
        format!("{DIR}/{tier}.md is not a loadable `{tier}` tier"),
        format!(
            "{DIR}/{tier}.md with a `---` frontmatter block whose `name` is `{tier}` and whose `model` and `effort` are set"
        ),
        actual,
        format!("fix {DIR}/{tier}.md (AGENTS.md › Sub-agents)"),
    )
}

/// The frontmatter block of `text`, without its `---` lines.
fn block(text: &str) -> Result<String, &'static str> {
    let mut lines = text.split('\n');
    if lines.next() != Some("---") {
        return Err("the file does not start with a `---` line");
    }
    let mut inside = Vec::new();
    for line in lines {
        if line == "---" {
            return Ok(inside.join("\n"));
        }
        inside.push(line);
    }
    Err("the frontmatter block is never closed with a `---` line")
}

fn non_empty(node: Option<&Node>) -> bool {
    node.and_then(Node::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn tier_violations(tier: &str, text: &str) -> Vec<FailureDetails> {
    let block = match block(text) {
        Ok(block) => block,
        Err(problem) => return vec![violation(tier, problem)],
    };
    let root = match yaml::parse(&block, Keys::Unique) {
        Ok(document) => document.root,
        Err(error) => {
            return vec![violation(
                tier,
                format!("the block does not parse as YAML: {}", error.message),
            )];
        }
    };
    if !root.is_map() {
        return vec![violation(tier, "the block is not a mapping")];
    }
    let mut violations = Vec::new();
    let name = root.get("name").and_then(Node::as_str);
    if name != Some(tier) {
        violations.push(violation(
            tier,
            format!(
                "name: {}",
                name.map_or_else(|| "none".to_owned(), |n| format!("`{n}`"))
            ),
        ));
    }
    for key in ["model", "effort"] {
        if !non_empty(root.get(key)) {
            violations.push(violation(tier, format!("no `{key}`")));
        }
    }
    violations
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    TIERS
        .iter()
        .flat_map(
            |tier| match read_file(input.root, &format!("{DIR}/{tier}.md")) {
                Some(text) => tier_violations(tier, &text),
                None => vec![violation(tier, "no such file")],
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{TIERS, run};
    use crate::check_harness::test_support::{codes, run_at};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    fn tier(name: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: >\n  The {name} tier.\nmodel: opus\neffort: medium\n---\n\nBody.\n"
        )
    }

    fn check(overrides: &[(&str, Option<&str>)]) -> Vec<FailureDetails> {
        let dir = temp_dir();
        for name in TIERS {
            let path = format!(".claude/agents/{name}.md");
            let content = overrides
                .iter()
                .find(|(tier, _)| *tier == name)
                .map_or_else(
                    || Some(tier(name)),
                    |(_, content)| content.map(str::to_owned),
                );
            if let Some(content) = content {
                write(dir.path(), &path, &content);
            }
        }
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_four_well_formed_tiers() {
        assert_eq!(check(&[]), []);
    }

    #[test]
    fn fails_on_a_missing_file() {
        let found = check(&[("scout", None)]);
        assert_eq!(codes(&found), ["ERR_CHECK_AGENT_TIER"]);
        assert!(
            found[0].summary.contains(".claude/agents/scout.md"),
            "{found:?}"
        );
        assert_eq!(found[0].actual, "no such file");
    }

    #[test]
    fn fails_on_a_name_mismatch() {
        let found = check(&[("worker", Some(&tier("helper")))]);
        assert_eq!(codes(&found), ["ERR_CHECK_AGENT_TIER"]);
        assert_eq!(found[0].actual, "name: `helper`");
    }

    #[test]
    fn fails_on_a_missing_model_or_effort() {
        let no_model = tier("executor").replace("model: opus\n", "");
        let blank_effort = tier("architect").replace("effort: medium", "effort: ''");
        let found = check(&[
            ("executor", Some(&no_model)),
            ("architect", Some(&blank_effort)),
        ]);
        let actual: Vec<&str> = found.iter().map(|f| f.actual.as_str()).collect();
        assert_eq!(actual, ["no `model`", "no `effort`"]);
    }

    #[test]
    fn fails_on_a_frontmatter_that_does_not_load() {
        for (content, actual) in [
            ("name: scout\n", "the file does not start with a `---` line"),
            (
                "---\nname: scout\n",
                "the frontmatter block is never closed with a `---` line",
            ),
            ("---\n- a\n---\n", "the block is not a mapping"),
        ] {
            let found = check(&[("scout", Some(content))]);
            assert_eq!(codes(&found), ["ERR_CHECK_AGENT_TIER"], "{content}");
            assert_eq!(found[0].actual, actual, "{content}");
        }
        let duplicate = "---\nname: scout\nname: scout\nmodel: x\neffort: y\n---\n";
        let found = check(&[("scout", Some(duplicate))]);
        assert!(
            found[0]
                .actual
                .starts_with("the block does not parse as YAML"),
            "{found:?}"
        );
        let unnamed = "---\nmodel: x\neffort: y\n---\n";
        assert_eq!(check(&[("scout", Some(unnamed))])[0].actual, "name: none");
    }
}
