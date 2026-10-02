//! A committed `.claude/settings.json`, if one is added, has an `allow` list that admits
//! none of the recipes that need a human or write beyond the working tree (AGENTS.md ›
//! "Enforcement layers"), so adding one to `allow` fails here instead of relying on
//! review to notice it.
//!
//! An `allow` rule admits a recipe when it names `just <recipe>` anywhere, with any global
//! flags (each with up to two values) between `just` and the recipe (so
//! `Bash(mise exec -- just labels)` and `Bash(just --justfile justfile labels)` count), or
//! when its pattern, matched the way Claude Code matches a Bash rule, covers one of the
//! candidate commands `just <recipe>`, `mise exec -- just <recipe>`, or `x just <recipe>`,
//! each also followed by an argument: a bare `Bash`, `Bash(*)`, `Bash(just:*)`,
//! `Bash(mise exec -- just:*)`, and `Bash(* just labels)` all count. In a pattern `*`
//! stands for any text, a trailing `:*` is a trailing ` *`, and a trailing ` *` that is
//! the only wildcard also matches the bare command. Only `allow` is read: `ask` and `deny`
//! are where these recipes belong. `clean` and `prune-temp` are absent on purpose: they
//! delete only build output and known-safe temporary directories. The file is optional.
//!
//! Errors: `ERR_CHECK_INPUT_UNREADABLE` (`.claude/settings.json` is not JSON),
//! `ERR_CHECK_ALLOW_HUMAN_RECIPE` (an `allow` rule admits one of the recipes).

use super::{Input, finding, read_file};
use crate::fail::FailureDetails;

/// The recipes AGENTS.md keeps out of `allow`: they need a human or write beyond the tree.
pub(super) const HUMAN_RECIPES: [&str; 7] = [
    "test-local",
    "logs-follow",
    "install-cli",
    "install",
    "labels",
    "ruleset",
    "bootstrap",
];

const PATH: &str = ".claude/settings.json";

/// Commands a rule may wrap `just <recipe>` in: bare, under `mise exec --`, or after any prefix.
const PREFIXES: [&str; 3] = ["", "mise exec -- ", "x "];

/// How a Bash rule matches a command.
enum Matcher {
    Everything,
    /// The command, or the command followed by a space and anything.
    CommandOrArguments(String),
    /// Literal parts with any text between them, anchored at both ends.
    Wildcard(Vec<String>),
}

impl Matcher {
    fn matches(&self, command: &str) -> bool {
        match self {
            Self::Everything => true,
            Self::CommandOrArguments(prefix) => {
                command == prefix
                    || command
                        .strip_prefix(prefix.as_str())
                        .is_some_and(|rest| rest.starts_with(' '))
            }
            Self::Wildcard(parts) => wildcard(parts, command),
        }
    }
}

/// Whether `text` is `parts` joined by any text, start and end anchored.
fn wildcard(parts: &[String], text: &str) -> bool {
    let Some((first, rest)) = parts.split_first() else {
        return text.is_empty();
    };
    let Some(mut remaining) = text.strip_prefix(first.as_str()) else {
        return false;
    };
    let Some((last, middle)) = rest.split_last() else {
        return remaining.is_empty();
    };
    for part in middle {
        let Some(at) = remaining.find(part.as_str()) else {
            return false;
        };
        remaining = &remaining[at + part.len()..];
    }
    remaining.ends_with(last.as_str())
}

/// The command texts a Bash rule matches; `None` for a rule of another tool.
fn bash_rule(rule: &str) -> Option<Matcher> {
    if rule == "Bash" {
        return Some(Matcher::Everything);
    }
    let inner = rule.strip_prefix("Bash(")?.strip_suffix(')')?;
    let pattern = match inner.strip_suffix(":*") {
        Some(command) => format!("{command} *"),
        None => inner.to_owned(),
    };
    let parts: Vec<String> = pattern.split('*').map(str::to_owned).collect();
    if parts.len() == 2 && pattern.ends_with(" *") {
        return Some(Matcher::CommandOrArguments(
            pattern[..pattern.len() - 2].to_owned(),
        ));
    }
    Some(Matcher::Wildcard(parts))
}

fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Whether `words` (what follows `just`) reach `recipe` past flags, each flag taking up to
/// two values.
fn reaches(words: &[&str], recipe: &str) -> bool {
    let Some((word, rest)) = words.split_first() else {
        return false;
    };
    if word
        .strip_prefix(recipe)
        .is_some_and(|after| !after.starts_with(name_char))
    {
        return true;
    }
    if !word.starts_with('-') {
        return false;
    }
    (0..=2).any(|values| {
        values <= rest.len()
            && rest[..values].iter().all(|value| !value.starts_with('-'))
            && reaches(&rest[values..], recipe)
    })
}

/// Whether `rule` names `just <recipe>` with only flags (and their values) between.
fn names_recipe(rule: &str, recipe: &str) -> bool {
    rule.match_indices("just").any(|(at, _)| {
        let before_ok = !rule[..at].ends_with(name_char);
        let rest = &rule[at + "just".len()..];
        before_ok
            && rest.starts_with(char::is_whitespace)
            && reaches(&rest.split_whitespace().collect::<Vec<_>>(), recipe)
    })
}

/// The recipes of [`HUMAN_RECIPES`] that one `allow` rule admits.
fn admitted(rule: &str) -> Vec<&'static str> {
    let Some(matcher) = bash_rule(rule) else {
        return Vec::new();
    };
    HUMAN_RECIPES
        .into_iter()
        .filter(|recipe| {
            PREFIXES.iter().any(|prefix| {
                matcher.matches(&format!("{prefix}just {recipe}"))
                    || matcher.matches(&format!("{prefix}just {recipe} x"))
            }) || names_recipe(rule, recipe)
        })
        .collect()
}

/// The 1-based line of the first line holding `needle`, 0 when none does.
pub(super) fn line_holding(text: &str, needle: &str) -> usize {
    text.split('\n')
        .position(|line| line.contains(needle))
        .map_or(0, |index| index + 1)
}

pub(super) fn run(input: &Input<'_>) -> Vec<FailureDetails> {
    let Some(text) = read_file(input.root, PATH) else {
        return Vec::new();
    };
    let settings: serde_json::Value = match serde_json::from_str(&text) {
        Ok(settings) => settings,
        Err(error) => {
            return vec![finding(
                "ERR_CHECK_INPUT_UNREADABLE",
                format!("{PATH} is not JSON"),
                "a JSON object whose `permissions.allow` list holds the allow rules",
                error.to_string(),
                format!("fix the JSON in {PATH}"),
            )];
        }
    };
    let Some(allow) = settings
        .pointer("/permissions/allow")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let mut violations = Vec::new();
    for rule in allow.iter().filter_map(serde_json::Value::as_str) {
        let recipes = admitted(rule);
        if recipes.is_empty() {
            continue;
        }
        let quoted = super::yaml::json_string(rule);
        let line = line_holding(&text, &quoted);
        let named = recipes
            .iter()
            .map(|recipe| format!("`just {recipe}`"))
            .collect::<Vec<_>>()
            .join(", ");
        violations.push(finding(
            "ERR_CHECK_ALLOW_HUMAN_RECIPE",
            format!("{PATH}:{line} allows {quoted}, which admits {named}"),
            format!(
                "no `allow` rule in {PATH} admitting a recipe that needs a human or writes beyond the working tree ({})",
                HUMAN_RECIPES.join(", ")
            ),
            format!("the rule {quoted} runs {named} without a prompt"),
            format!("remove the rule from `allow` in {PATH} (or narrow its wildcard) so the recipe stops for a human"),
        ));
    }
    violations
}

#[cfg(test)]
mod tests {
    use super::{HUMAN_RECIPES, admitted, run};
    use crate::check_harness::test_support::{codes, run_at};
    use crate::fail::FailureDetails;
    use crate::test_support::{temp_dir, write};

    const ROUTINE: [&str; 7] = [
        "Bash(just check)",
        "Bash(just test-fast:*)",
        "Bash(just logs)",
        "Bash(just agents-sync)",
        "Bash(gh pr view:*)",
        "Bash(gh api -X GET:*)",
        "Read(./just labels)",
    ];

    fn settings(allow: &[serde_json::Value]) -> String {
        let value = serde_json::json!({
            "permissions": {
                "allow": allow,
                "ask": ["Bash(just test-local)", "Bash(just labels)"],
                "deny": ["Bash(just bootstrap:*)", "Bash(git push --force:*)"],
            },
            "hooks": { "PostToolUse": [{ "hooks": [{ "type": "command", "command": "just install" }] }] },
        });
        format!("{}\n", serde_json::to_string_pretty(&value).expect("json"))
    }

    fn rules(extra: &[&str]) -> Vec<serde_json::Value> {
        ROUTINE
            .iter()
            .chain(extra)
            .map(|rule| serde_json::Value::from(*rule))
            .collect()
    }

    fn check(content: Option<&str>) -> Vec<FailureDetails> {
        let dir = temp_dir();
        if let Some(content) = content {
            write(dir.path(), ".claude/settings.json", content);
        }
        run_at(dir.path(), run)
    }

    #[test]
    fn passes_routine_rules_and_a_missing_file() {
        assert_eq!(check(Some(&settings(&rules(&[])))), []);
        assert_eq!(check(None), []);
    }

    #[test]
    fn reports_each_human_recipe_in_allow() {
        for recipe in HUMAN_RECIPES {
            assert_eq!(
                admitted(&format!("Bash(just {recipe})")),
                [recipe],
                "{recipe}"
            );
        }
    }

    #[test]
    fn reports_every_spelling_that_reaches_a_recipe() {
        for rule in [
            "Bash(just labels)",
            "Bash(just labels:*)",
            "Bash(just labels *)",
            "Bash(just labels*)",
            "Bash(just labels --dry-run)",
            "Bash(mise exec -- just labels)",
            "Bash(* just labels)",
            "Bash(*just labels*)",
            "Bash(just --justfile justfile labels)",
            "Bash(just -v labels)",
            "Bash(just --dotenv-load --set x y labels:*)",
        ] {
            assert_eq!(admitted(rule), ["labels"], "{rule}");
        }
        for rule in [
            "Bash",
            "Bash(*)",
            "Bash(just:*)",
            "Bash(just *)",
            "Bash(just*)",
            "Bash(mise exec -- just:*)",
            "Bash(mise exec -- just *)",
            "Bash(* just *)",
        ] {
            assert_eq!(admitted(rule), HUMAN_RECIPES, "{rule}");
        }
        assert_eq!(admitted("Bash(just l*)"), ["logs-follow", "labels"]);
        assert_eq!(admitted("Bash(just install*)"), ["install-cli", "install"]);
        for (rule, recipe) in [
            ("Bash(just install:*)", "install"),
            ("Bash(just install-cli)", "install-cli"),
            ("Bash(just logs-follow)", "logs-follow"),
            ("Bash(just test-local:*)", "test-local"),
        ] {
            assert_eq!(admitted(rule), [recipe], "{rule}");
        }
        for rule in [
            "Bash(just runner)",
            "Bash(just test-fast run)",
            "Bash(just clean-cache)",
            "Bash(just lint)",
            "Bash(mise exec -- just test-fast:*)",
            "Bash(adjust labels)",
            "Bash(just --x -y labels-old)",
            "Bash(just a b labels)",
        ] {
            assert_eq!(admitted(rule), Vec::<&str>::new(), "{rule}");
        }
    }

    #[test]
    fn reports_the_rule_line_once_per_rule() {
        let content = settings(&rules(&["Bash(just install)", "Bash(just ruleset:*)"]));
        let violations = check(Some(&content));
        assert_eq!(
            codes(&violations),
            [
                "ERR_CHECK_ALLOW_HUMAN_RECIPE",
                "ERR_CHECK_ALLOW_HUMAN_RECIPE"
            ]
        );
        let line = content
            .split('\n')
            .position(|l| l.contains("\"Bash(just install)\""))
            .expect("line")
            + 1;
        assert_eq!(
            violations[0].summary,
            format!(
                ".claude/settings.json:{line} allows \"Bash(just install)\", which admits `just install`"
            )
        );
    }

    #[test]
    fn fails_on_text_that_is_not_json_and_reads_no_rule_from_other_shapes() {
        assert_eq!(
            codes(&check(Some("{ nope"))),
            ["ERR_CHECK_INPUT_UNREADABLE"]
        );
        for content in [
            r#"{ "permissions": ["Bash(just run)"] }"#,
            r#"{ "permissions": { "deny": ["Bash(just labels)"] } }"#,
            r#"{ "permissions": { "allow": "Bash(just labels)" } }"#,
            "null",
            r#"{ "permissions": { "allow": [42, { "rule": "Bash(just labels)" }] } }"#,
        ] {
            assert_eq!(check(Some(content)), [], "{content}");
        }
    }
}
