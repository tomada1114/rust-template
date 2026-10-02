//! A GitHub Actions expression (`${{ … }}`) evaluated as it would be for one event, a
//! `push` or a `pull_request`, so a concurrency rule can ask what a group or a
//! `cancel-in-progress` value becomes on a push run, and a ruleset rule whether a job's
//! `if:` or `name:` is fixed on a pull request, instead of grepping for a token. Reads
//! literals, context paths, `!`, `==`, `!=`, `&&`, `||`, and parentheses — the forms a
//! concurrency block, a job condition, or a job name uses. Anything else (a function call,
//! `<`, an index) makes the whole value unreadable, and a caller treats unreadable as
//! unproven, never as safe.
//!
//! On a push, `github.event_name` is `'push'`, `github.head_ref` and `github.base_ref` are
//! empty, and `github.event.pull_request` is null. On a pull request, `github.event_name`
//! is `'pull_request'`, and `github.head_ref`, `github.base_ref`, and
//! `github.event.pull_request` are set. Every other context path stays symbolic: its
//! truthiness is known only for the never-empty paths of that event, so `!x` or `x && y`
//! over any other path is unknown rather than guessed.

use super::yaml::{Node, Yaml, number_text};

/// The events an expression can be evaluated for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Event {
    Push,
    PullRequest,
}

impl Event {
    fn name(self) -> &'static str {
        match self {
            Self::Push => "push",
            Self::PullRequest => "pull_request",
        }
    }
}

/// A literal value.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Literal {
    Str(String),
    Number(f64),
    Bool(bool),
    Null,
}

impl Literal {
    /// The text the value has inside a string, as GitHub writes it into a name.
    pub(super) fn text(&self) -> String {
        match self {
            Self::Str(text) => text.clone(),
            Self::Number(number) => number_text(*number),
            Self::Bool(value) => value.to_string(),
            Self::Null => String::new(),
        }
    }
}

/// What an expression is on a run of one event: a literal, a symbolic context path, or
/// unknown.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Value {
    Literal(Literal),
    Context(String),
    Unknown,
}

/// Context paths that are never empty on a run of any event.
const ALWAYS_SET: [&str; 9] = [
    "github.sha",
    "github.ref",
    "github.ref_name",
    "github.workflow",
    "github.run_id",
    "github.run_number",
    "github.run_attempt",
    "github.repository",
    "github.actor",
];

/// Context paths a pull request run also never leaves empty.
const PULL_REQUEST_SET: [&str; 5] = [
    "github.head_ref",
    "github.base_ref",
    "github.event.number",
    "github.event.pull_request",
    "github.event.pull_request.number",
];

fn non_empty(event: Event, path: &str) -> bool {
    ALWAYS_SET.contains(&path) || (event == Event::PullRequest && PULL_REQUEST_SET.contains(&path))
}

/// What a caller knows about a context path (given lowercased) on the run it asks about,
/// such as one matrix combination's `matrix.*` values, or `None` to leave it symbolic.
pub(super) type Resolve<'a> = &'a mut dyn FnMut(&str) -> Option<Value>;

fn context_on(event: Event, path: &str, resolve: &mut Option<Resolve<'_>>) -> Value {
    let lower = path.to_lowercase();
    if let Some(known) = resolve.as_mut().and_then(|resolve| resolve(&lower)) {
        return known;
    }
    if lower == "github.event_name" {
        return Value::Literal(Literal::Str(event.name().to_owned()));
    }
    if event == Event::Push {
        if lower == "github.head_ref" || lower == "github.base_ref" {
            return Value::Literal(Literal::Str(String::new()));
        }
        if lower == "github.event.number" || lower.starts_with("github.event.pull_request") {
            return Value::Literal(Literal::Null);
        }
    }
    Value::Context(lower)
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Op(&'static str),
    Value(Value),
}

const OPERATORS: [&str; 7] = ["==", "!=", "&&", "||", "!", "(", ")"];

fn is_word_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// `[A-Za-z_][A-Za-z0-9_-]*(\.([A-Za-z_][A-Za-z0-9_-]*|\*))*` at the start of `text`.
fn path_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let word_run = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|byte| is_word(char::from(**byte)))
            .count()
    };
    if !bytes
        .first()
        .is_some_and(|byte| is_word_start(char::from(*byte)))
    {
        return None;
    }
    let mut at = 1 + word_run(1);
    while bytes.get(at) == Some(&b'.') {
        match bytes.get(at + 1) {
            Some(b'*') => at += 2,
            Some(byte) if is_word_start(char::from(*byte)) => at += 2 + word_run(at + 2),
            _ => break,
        }
    }
    Some(at)
}

/// `-?\d+(\.\d+)?` at the start of `text`.
fn number_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut at = usize::from(bytes.first() == Some(&b'-'));
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let whole = digits(at);
    if whole == 0 {
        return None;
    }
    at += whole;
    if bytes.get(at) == Some(&b'.') {
        let fraction = digits(at + 1);
        if fraction > 0 {
            at += 1 + fraction;
        }
    }
    Some(at)
}

fn tokenize(source: &str, event: Event, resolve: &mut Option<Resolve<'_>>) -> Option<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut rest = source.trim();
    while !rest.is_empty() {
        if let Some(op) = OPERATORS.iter().find(|op| rest.starts_with(**op)) {
            tokens.push(Token::Op(op));
            rest = rest[op.len()..].trim_start();
            continue;
        }
        if let Some(body) = rest.strip_prefix('\'') {
            // `'…'` with `''` for a quote inside.
            let mut text = String::new();
            let mut chars = body.char_indices();
            let mut end = None;
            while let Some((at, c)) = chars.next() {
                if c != '\'' {
                    text.push(c);
                    continue;
                }
                if body[at + 1..].starts_with('\'') {
                    text.push('\'');
                    chars.next();
                    continue;
                }
                end = Some(at + 1);
                break;
            }
            let end = end?;
            tokens.push(Token::Value(Value::Literal(Literal::Str(text))));
            rest = body[end..].trim_start();
            continue;
        }
        if let Some(length) = number_len(rest) {
            let number = rest[..length].parse::<f64>().ok()?;
            tokens.push(Token::Value(Value::Literal(Literal::Number(number))));
            rest = rest[length..].trim_start();
            continue;
        }
        let length = path_len(rest)?;
        let word = &rest[..length];
        rest = rest[length..].trim_start();
        // A function call or an index is outside what this reads.
        if rest.starts_with('(') || rest.starts_with('[') {
            return None;
        }
        let value = match word {
            "true" => Value::Literal(Literal::Bool(true)),
            "false" => Value::Literal(Literal::Bool(false)),
            "null" => Value::Literal(Literal::Null),
            _ => context_on(event, word, resolve),
        };
        tokens.push(Token::Value(value));
    }
    Some(tokens)
}

/// Whether a value is truthy on a run of `event`, or `None` when that is not known.
pub(super) fn truthy(value: &Value, event: Event) -> Option<bool> {
    match value {
        Value::Literal(literal) => Some(match literal {
            Literal::Str(text) => !text.is_empty(),
            Literal::Number(number) => *number != 0.0 && !number.is_nan(),
            Literal::Bool(value) => *value,
            Literal::Null => false,
        }),
        Value::Context(path) => non_empty(event, path).then_some(true),
        Value::Unknown => None,
    }
}

fn to_number(literal: &Literal) -> f64 {
    match literal {
        Literal::Null => 0.0,
        Literal::Bool(value) => f64::from(u8::from(*value)),
        Literal::Number(number) => *number,
        Literal::Str(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
    }
}

fn equal(left: &Value, right: &Value) -> Option<bool> {
    let (Value::Literal(a), Value::Literal(b)) = (left, right) else {
        return None;
    };
    let same_number = |x: f64, y: f64| x.partial_cmp(&y) == Some(std::cmp::Ordering::Equal);
    Some(match (a, b) {
        (Literal::Str(a), Literal::Str(b)) => a.to_lowercase() == b.to_lowercase(),
        (Literal::Number(a), Literal::Number(b)) => same_number(*a, *b),
        (Literal::Bool(a), Literal::Bool(b)) => a == b,
        (Literal::Null, Literal::Null) => true,
        _ => same_number(to_number(a), to_number(b)),
    })
}

/// A recursive-descent parse over the tokens, by GitHub's precedence: `!`, `==`/`!=`,
/// `&&`, `||`.
struct Parser<'a> {
    tokens: &'a [Token],
    index: usize,
    event: Event,
}

impl Parser<'_> {
    fn peek(&self, op: &str) -> bool {
        matches!(self.tokens.get(self.index), Some(Token::Op(found)) if *found == op)
    }

    fn primary(&mut self) -> Option<Value> {
        let token = self.tokens.get(self.index)?;
        self.index += 1;
        match token {
            Token::Value(value) => Some(value.clone()),
            Token::Op("(") => {
                let inner = self.or()?;
                if !self.peek(")") {
                    return None;
                }
                self.index += 1;
                Some(inner)
            }
            Token::Op(_) => None,
        }
    }

    fn unary(&mut self) -> Option<Value> {
        if !self.peek("!") {
            return self.primary();
        }
        self.index += 1;
        let operand = self.unary()?;
        Some(
            truthy(&operand, self.event)
                .map_or(Value::Unknown, |test| Value::Literal(Literal::Bool(!test))),
        )
    }

    fn equality(&mut self) -> Option<Value> {
        let mut left = self.unary()?;
        while self.peek("==") || self.peek("!=") {
            let negate = self.peek("!=");
            self.index += 1;
            let right = self.unary()?;
            left = equal(&left, &right).map_or(Value::Unknown, |same| {
                Value::Literal(Literal::Bool(same != negate))
            });
        }
        Some(left)
    }

    fn and(&mut self) -> Option<Value> {
        let mut left = self.equality()?;
        while self.peek("&&") {
            self.index += 1;
            let right = self.equality()?;
            left = match truthy(&left, self.event) {
                None => Value::Unknown,
                Some(true) => right,
                Some(false) => left,
            };
        }
        Some(left)
    }

    fn or(&mut self) -> Option<Value> {
        let mut left = self.and()?;
        while self.peek("||") {
            self.index += 1;
            let right = self.and()?;
            left = match truthy(&left, self.event) {
                None => Value::Unknown,
                Some(true) => left,
                Some(false) => right,
            };
        }
        Some(left)
    }
}

/// One expression's value on a run of `event`, or `None` when it cannot be read. A
/// `resolve` function supplies the context paths the caller knows beyond the event's own.
pub(super) fn evaluate_on(
    event: Event,
    expression: &str,
    resolve: Option<Resolve<'_>>,
) -> Option<Value> {
    let mut resolve = resolve;
    let tokens = tokenize(expression, event, &mut resolve)?;
    let mut parser = Parser {
        tokens: &tokens,
        index: 0,
        event,
    };
    let value = parser.or()?;
    (parser.index == tokens.len()).then_some(value)
}

/// Each `${{ … }}` in `text`: its byte range and its inner source.
pub(super) fn embedded(text: &str) -> Vec<(usize, usize, &str)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(open) = text[from..].find("${{").map(|at| at + from) {
        let Some(close) = text[open + 3..].find("}}").map(|at| at + open + 3) else {
            break;
        };
        found.push((open, close + 2, &text[open + 3..close]));
        from = close + 2;
    }
    found
}

/// A string that may embed `${{ … }}` expressions, as the parts it is made of on a run of
/// `event` (the text between expressions as literals), or `None` when one expression
/// cannot be read.
pub(super) fn template_on(event: Event, text: &str) -> Option<Vec<Value>> {
    let mut parts = Vec::new();
    let mut last = 0;
    for (start, end, source) in embedded(text) {
        if start > last {
            parts.push(Value::Literal(Literal::Str(text[last..start].to_owned())));
        }
        parts.push(evaluate_on(event, source, None)?);
        last = end;
    }
    if last < text.len() {
        parts.push(Value::Literal(Literal::Str(text[last..].to_owned())));
    }
    Some(parts)
}

/// Whether a string is exactly one `${{ … }}` expression and nothing else.
pub(super) fn is_whole_expression(text: &str) -> bool {
    let trimmed = text.trim();
    let found = embedded(trimmed);
    found.len() == 1 && found[0].0 == 0 && found[0].1 == trimmed.len()
}

/// Whether an `if:` value is true on a run of `event`, or `None` when that is not known.
/// An `if:` is an expression with or without its `${{ }}` wrapper; a YAML boolean is
/// itself; text mixing an expression with other text is not read.
pub(super) fn condition_on(event: Event, value: &Node) -> Option<bool> {
    let text = match &value.value {
        Yaml::Bool(value) => return Some(*value),
        Yaml::Str(text) => text,
        Yaml::Null | Yaml::Number(_) | Yaml::Seq(_) | Yaml::Map(_) => return None,
    };
    let source = if is_whole_expression(text) {
        let trimmed = text.trim();
        &trimmed[3..trimmed.len() - 2]
    } else if text.contains("${{") {
        return None;
    } else {
        text.as_str()
    };
    truthy(&evaluate_on(event, source, None)?, event)
}

#[cfg(test)]
mod tests {
    use super::{
        Event, Literal, Value, condition_on, evaluate_on, is_whole_expression, template_on, truthy,
    };
    use crate::check_harness::yaml::{Keys, parse};

    fn push(expression: &str) -> Option<Value> {
        evaluate_on(Event::Push, expression, None)
    }

    fn string(text: &str) -> Value {
        Value::Literal(Literal::Str(text.to_owned()))
    }

    fn boolean(value: bool) -> Value {
        Value::Literal(Literal::Bool(value))
    }

    #[test]
    fn evaluates_the_ci_concurrency_group_per_event() {
        let group = "github.event_name == 'pull_request' && github.ref || github.sha";
        assert_eq!(push(group), Some(Value::Context("github.sha".to_owned())));
        assert_eq!(
            evaluate_on(Event::PullRequest, group, None),
            Some(Value::Context("github.ref".to_owned()))
        );
        assert_eq!(
            push("github.event_name == 'pull_request'"),
            Some(boolean(false))
        );
        assert_eq!(push("GITHUB.EVENT_NAME == 'PUSH'"), Some(boolean(true)));
    }

    #[test]
    fn reads_literals_operators_and_parentheses() {
        assert_eq!(push("'it''s'"), Some(string("it's")));
        assert_eq!(push("!(1 == 1.0)"), Some(boolean(false)));
        assert_eq!(push("-2"), Some(Value::Literal(Literal::Number(-2.0))));
        assert_eq!(push("null == false"), Some(boolean(true)));
        assert_eq!(push("'1' == 1"), Some(boolean(true)));
        assert_eq!(push("'' == 0"), Some(boolean(true)));
        assert_eq!(push("'x' == 0"), Some(boolean(false)));
        assert_eq!(push("true != false"), Some(boolean(true)));
        assert_eq!(push("null == null"), Some(boolean(true)));
        assert_eq!(push("1 == 2"), Some(boolean(false)));
        assert_eq!(push("github.head_ref"), Some(string("")));
        assert_eq!(
            push("github.event.pull_request.number"),
            Some(Value::Literal(Literal::Null))
        );
        assert_eq!(
            push("matrix.*"),
            Some(Value::Context("matrix.*".to_owned()))
        );
        assert_eq!(push("a.*.b"), Some(Value::Context("a.*.b".to_owned())));
        assert_eq!(push("a.*b"), None);
        assert_eq!(push("a."), None);
        assert_eq!(push("github.foo || 'x'"), Some(Value::Unknown));
        assert_eq!(
            push("false || github.foo"),
            Some(Value::Context("github.foo".to_owned()))
        );
        assert_eq!(push("github.foo && 'x'"), Some(Value::Unknown));
        assert_eq!(push("!github.foo"), Some(Value::Unknown));
        assert_eq!(push("github.foo == 'x'"), Some(Value::Unknown));
        assert_eq!(push("github.sha && 'x'"), Some(string("x")));
        assert_eq!(push("0 && 'x'"), Some(Value::Literal(Literal::Number(0.0))));
    }

    #[test]
    fn refuses_what_it_does_not_read() {
        for source in [
            "contains(github.ref, 'x')",
            "github.event.commits[0]",
            "a < b",
            "'open",
            "(true",
            "true)",
            "",
            "== 1",
            "!",
            "1 ==",
            "true &&",
            "false ||",
        ] {
            assert_eq!(push(source), None, "{source}");
        }
    }

    #[test]
    fn resolves_paths_the_caller_knows() {
        let mut resolve = |path: &str| (path == "matrix.os").then(|| string("linux"));
        assert_eq!(
            evaluate_on(Event::PullRequest, "matrix.OS", Some(&mut resolve)),
            Some(string("linux"))
        );
    }

    #[test]
    fn splits_a_template_and_spots_a_whole_expression() {
        assert_eq!(
            template_on(Event::Push, "a-${{ github.sha }}-b"),
            Some(vec![
                string("a-"),
                Value::Context("github.sha".to_owned()),
                string("-b")
            ])
        );
        assert_eq!(template_on(Event::Push, "${{ f(x) }}"), None);
        assert_eq!(
            template_on(Event::Push, "${{ open"),
            Some(vec![string("${{ open")])
        );
        assert!(is_whole_expression(" ${{ x }} "));
        assert!(!is_whole_expression("${{ x }}-${{ y }}"));
        assert!(!is_whole_expression("a ${{ x }}"));
    }

    #[test]
    fn judges_truth_per_event() {
        assert_eq!(
            truthy(
                &Value::Context("github.head_ref".to_owned()),
                Event::PullRequest
            ),
            Some(true)
        );
        assert_eq!(
            truthy(&Value::Context("github.head_ref".to_owned()), Event::Push),
            None
        );
        assert_eq!(truthy(&Value::Unknown, Event::Push), None);
        assert_eq!(
            truthy(&Value::Literal(Literal::Number(f64::NAN)), Event::Push),
            Some(false)
        );
        let node = |text: &str| parse(text, Keys::Unique).expect("yaml").root;
        assert_eq!(condition_on(Event::PullRequest, &node("true")), Some(true));
        assert_eq!(
            condition_on(
                Event::PullRequest,
                &node("${{ github.event_name == 'pull_request' }}")
            ),
            Some(true)
        );
        assert_eq!(
            condition_on(Event::PullRequest, &node("github.event_name == 'push'")),
            Some(false)
        );
        assert_eq!(
            condition_on(Event::PullRequest, &node("x ${{ true }}")),
            None
        );
        assert_eq!(condition_on(Event::PullRequest, &node("1")), None);
        assert_eq!(condition_on(Event::PullRequest, &node("f()")), None);
    }

    #[test]
    fn writes_a_literal_as_text() {
        assert_eq!(Literal::Number(3.0).text(), "3");
        assert_eq!(Literal::Bool(true).text(), "true");
        assert_eq!(Literal::Null.text(), "");
        assert_eq!(Literal::Str("x".to_owned()).text(), "x");
    }
}
