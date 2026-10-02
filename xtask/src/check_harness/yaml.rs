//! YAML read with a real parser (`yaml-rust2`'s event parser) into a tree whose every node
//! keeps the line it starts on, so a finding can point at `path:line`. Plain scalars
//! resolve by the YAML 1.2 core schema (`null`, `true`, `12`, `1.5`); a quoted or block
//! scalar is a string. A duplicate mapping key is an error unless the caller allows it,
//! and so is a second document. Anchors and aliases resolve to copies.

use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// How a scalar was written; a collection is `Collection`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Style {
    Plain,
    Quoted,
    /// `|`
    Literal,
    /// `>`
    Folded,
    Collection,
}

/// A YAML value.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Yaml {
    Null,
    Bool(bool),
    /// Every number, as JavaScript holds one.
    Number(f64),
    Str(String),
    Seq(Vec<Node>),
    /// Entries in file order; a key is a node too.
    Map(Vec<(Node, Node)>),
}

/// A value and where it starts.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Node {
    pub(crate) value: Yaml,
    /// 1-based.
    pub(crate) line: usize,
    pub(crate) style: Style,
}

/// One step of a key path into a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Key<'a> {
    Name(&'a str),
    Index(usize),
}

/// Where a key path sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Location {
    /// 1-based line of the deepest key (or sequence item) found on the path.
    pub(crate) line: usize,
    /// Whether the value at the full path is a block scalar (`|` or `>`).
    pub(crate) block: bool,
}

const NULL: Node = Node {
    value: Yaml::Null,
    line: 0,
    style: Style::Plain,
};

impl Node {
    /// The value under `key` of a mapping (the first entry, if repeated).
    pub(crate) fn get(&self, key: &str) -> Option<&Node> {
        self.entries()
            .find(|(name, _)| name.as_deref() == Some(key))
            .map(|(_, value)| value)
    }

    /// Whether a mapping has `key`.
    pub(crate) fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// A mapping's entries, each key as text (`None` for a key that is not a scalar).
    pub(crate) fn entries(&self) -> impl Iterator<Item = (Option<String>, &Node)> {
        let pairs: &[(Node, Node)] = match &self.value {
            Yaml::Map(pairs) => pairs,
            _ => &[],
        };
        pairs.iter().map(|(key, value)| (key.scalar_text(), value))
    }

    /// A mapping's entries whose key is a scalar, by key text.
    pub(crate) fn pairs(&self) -> impl Iterator<Item = (String, &Node)> {
        self.entries()
            .filter_map(|(key, value)| key.map(|key| (key, value)))
    }

    /// A sequence's items.
    pub(crate) fn items(&self) -> &[Node] {
        match &self.value {
            Yaml::Seq(items) => items,
            _ => &[],
        }
    }

    pub(crate) fn is_map(&self) -> bool {
        matches!(self.value, Yaml::Map(_))
    }

    pub(crate) fn is_seq(&self) -> bool {
        matches!(self.value, Yaml::Seq(_))
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match &self.value {
            Yaml::Str(text) => Some(text),
            _ => None,
        }
    }

    pub(crate) fn as_number(&self) -> Option<f64> {
        match self.value {
            Yaml::Number(number) => Some(number),
            _ => None,
        }
    }

    pub(crate) fn as_bool(&self) -> Option<bool> {
        match self.value {
            Yaml::Bool(value) => Some(value),
            _ => None,
        }
    }

    /// Whether the node is a scalar written as a block (`|` or `>`).
    pub(crate) fn is_block(&self) -> bool {
        matches!(self.style, Style::Literal | Style::Folded)
    }

    /// The source line a string value's first line comes from. A block scalar's node
    /// starts at its first non-blank content line, below its indicator and any blank
    /// lines the value keeps.
    pub(crate) fn value_start_line(&self) -> usize {
        match (&self.value, self.is_block()) {
            (Yaml::Str(text), true) => self
                .line
                .saturating_sub(text.chars().take_while(|c| *c == '\n').count()),
            _ => self.line,
        }
    }

    /// A scalar as the text JavaScript's `String()` gives it; `None` for a collection.
    pub(crate) fn scalar_text(&self) -> Option<String> {
        match &self.value {
            Yaml::Null => Some("null".to_owned()),
            Yaml::Bool(value) => Some(value.to_string()),
            Yaml::Number(number) => Some(number_text(*number)),
            Yaml::Str(text) => Some(text.clone()),
            Yaml::Seq(_) | Yaml::Map(_) => None,
        }
    }

    /// The value as `JSON.stringify` writes it.
    pub(crate) fn to_json(&self) -> String {
        match &self.value {
            Yaml::Bool(value) => value.to_string(),
            Yaml::Number(number) if number.is_finite() => number_text(*number),
            Yaml::Null | Yaml::Number(_) => "null".to_owned(),
            Yaml::Str(text) => json_string(text),
            Yaml::Seq(items) => format!(
                "[{}]",
                items
                    .iter()
                    .map(Node::to_json)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Yaml::Map(_) => format!(
                "{{{}}}",
                self.entries()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        json_string(&key.unwrap_or_default()),
                        value.to_json()
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }

    /// Where a key path sits, as the deepest key found on it.
    pub(crate) fn locate(&self, keys: &[Key<'_>]) -> Location {
        let mut node = self;
        let mut line = 1;
        let mut complete = true;
        for key in keys {
            let next = match (key, &node.value) {
                (Key::Name(name), Yaml::Map(pairs)) => pairs
                    .iter()
                    .find(|(candidate, _)| candidate.scalar_text().as_deref() == Some(name))
                    .map(|(candidate, value)| (candidate.line, value)),
                (Key::Index(index), Yaml::Seq(items)) => {
                    items.get(*index).map(|item| (item.line, item))
                }
                _ => None,
            };
            let Some((at, value)) = next else {
                complete = false;
                break;
            };
            line = at;
            node = value;
        }
        Location {
            line,
            block: complete && node.is_block(),
        }
    }
}

/// A number as JavaScript's `String()` writes it, for the values a config holds.
pub(crate) fn number_text(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{number:.0}")
    } else {
        number.to_string()
    }
}

/// A string as `JSON.stringify` quotes it.
pub(crate) fn json_string(text: &str) -> String {
    serde_json::Value::String(text.to_owned()).to_string()
}

/// A parsed document: its root, null when the text is empty.
#[derive(Debug, Clone)]
pub(crate) struct Document {
    pub(crate) root: Node,
}

/// Whether a mapping may repeat a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Keys {
    Unique,
    MayRepeat,
}

/// Why a text is not YAML: a message and its 1-based line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct YamlError {
    pub(crate) line: usize,
    pub(crate) message: String,
}

enum Frame {
    Seq {
        items: Vec<Node>,
        line: usize,
        anchor: usize,
    },
    Map {
        pairs: Vec<(Node, Node)>,
        key: Option<Node>,
        line: usize,
        anchor: usize,
    },
}

struct Builder {
    keys: Keys,
    stack: Vec<Frame>,
    documents: Vec<Node>,
    anchors: Vec<(usize, Node)>,
    error: Option<YamlError>,
}

impl Builder {
    fn remember(&mut self, anchor: usize, node: &Node) {
        if anchor > 0 {
            self.anchors.push((anchor, node.clone()));
        }
    }

    fn insert(&mut self, node: Node) {
        match self.stack.last_mut() {
            None => self.documents.push(node),
            Some(Frame::Seq { items, .. }) => items.push(node),
            Some(Frame::Map { pairs, key, .. }) => match key.take() {
                None => {
                    let text = node.scalar_text();
                    let repeated = text.is_some()
                        && pairs
                            .iter()
                            .any(|(existing, _)| existing.scalar_text() == text);
                    if repeated && self.keys == Keys::Unique && self.error.is_none() {
                        self.error = Some(YamlError {
                            line: node.line,
                            message: format!(
                                "Map keys must be unique (`{}` is repeated)",
                                text.unwrap_or_default()
                            ),
                        });
                    }
                    *key = Some(node);
                }
                Some(name) => pairs.push((name, node)),
            },
        }
    }
}

/// A plain scalar resolved by the YAML 1.2 core schema.
fn resolve_plain(text: &str) -> Yaml {
    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Yaml::Null,
        "true" | "True" | "TRUE" => return Yaml::Bool(true),
        "false" | "False" | "FALSE" => return Yaml::Bool(false),
        ".nan" | ".NaN" | ".NAN" => return Yaml::Number(f64::NAN),
        _ => {}
    }
    let (sign, unsigned) = match text.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, text.strip_prefix('+').unwrap_or(text)),
    };
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") {
        return Yaml::Number(sign * f64::INFINITY);
    }
    let radix = |digits: &str, base: u32| {
        if digits.is_empty() {
            return None;
        }
        digits.chars().try_fold(0.0, |total: f64, digit| {
            digit
                .to_digit(base)
                .map(|value| total * f64::from(base) + f64::from(value))
        })
    };
    if text == unsigned {
        let prefixed = [("0o", 8), ("0x", 16)]
            .into_iter()
            .find_map(|(prefix, base)| {
                text.strip_prefix(prefix)
                    .and_then(|digits| radix(digits, base))
            });
        if let Some(value) = prefixed {
            return Yaml::Number(value);
        }
    }
    if is_core_number(unsigned)
        && let Ok(value) = unsigned.parse::<f64>()
    {
        return Yaml::Number(sign * value);
    }
    Yaml::Str(text.to_owned())
}

/// `[0-9]+`, `.5`, `1.`, `1.5`, each with an optional `e[-+]?[0-9]+`.
fn is_core_number(text: &str) -> bool {
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(at) => (&text[..at], Some(&text[at + 1..])),
        None => (text, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    let mantissa_ok = match mantissa.split_once('.') {
        Some((whole, fraction)) => {
            (digits(whole) && (fraction.is_empty() || digits(fraction)))
                || (whole.is_empty() && digits(fraction))
        }
        None => digits(mantissa),
    };
    let exponent_ok =
        exponent.is_none_or(|power| digits(power.strip_prefix(['-', '+']).unwrap_or(power)));
    mantissa_ok && exponent_ok
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, event: Event, mark: Marker) {
        let line = mark.line();
        match event {
            Event::Scalar(text, style, anchor, tag) => {
                let explicit_string = tag.as_ref().is_some_and(|tag| {
                    tag.suffix == "str"
                        && (tag.handle == "!!" || tag.handle == "tag:yaml.org,2002:")
                });
                let (value, style) = match style {
                    TScalarStyle::Plain if !explicit_string => (resolve_plain(&text), Style::Plain),
                    TScalarStyle::Plain => (Yaml::Str(text), Style::Plain),
                    TScalarStyle::SingleQuoted | TScalarStyle::DoubleQuoted => {
                        (Yaml::Str(text), Style::Quoted)
                    }
                    TScalarStyle::Literal => (Yaml::Str(text), Style::Literal),
                    TScalarStyle::Folded => (Yaml::Str(text), Style::Folded),
                };
                let node = Node { value, line, style };
                self.remember(anchor, &node);
                self.insert(node);
            }
            Event::Alias(anchor) => {
                let node = self
                    .anchors
                    .iter()
                    .rev()
                    .find(|(id, _)| *id == anchor)
                    .map_or(NULL, |(_, node)| node.clone());
                self.insert(Node { line, ..node });
            }
            Event::SequenceStart(anchor, _) => self.stack.push(Frame::Seq {
                items: Vec::new(),
                line,
                anchor,
            }),
            Event::MappingStart(anchor, _) => self.stack.push(Frame::Map {
                pairs: Vec::new(),
                key: None,
                line,
                anchor,
            }),
            Event::SequenceEnd | Event::MappingEnd => {
                let (value, line, anchor) = match self.stack.pop() {
                    Some(Frame::Seq {
                        items,
                        line,
                        anchor,
                    }) => (Yaml::Seq(items), line, anchor),
                    Some(Frame::Map {
                        pairs,
                        line,
                        anchor,
                        ..
                    }) => (Yaml::Map(pairs), line, anchor),
                    None => return,
                };
                let node = Node {
                    value,
                    line,
                    style: Style::Collection,
                };
                self.remember(anchor, &node);
                self.insert(node);
            }
            Event::Nothing
            | Event::StreamStart
            | Event::StreamEnd
            | Event::DocumentStart
            | Event::DocumentEnd => {}
        }
    }
}

/// Parse one YAML document. An empty text is a null document.
pub(crate) fn parse(text: &str, keys: Keys) -> Result<Document, YamlError> {
    let mut builder = Builder {
        keys,
        stack: Vec::new(),
        documents: Vec::new(),
        anchors: Vec::new(),
        error: None,
    };
    let mut parser = Parser::new_from_str(text);
    parser.load(&mut builder, true).map_err(|error| YamlError {
        line: error.marker().line(),
        message: error.info().to_owned(),
    })?;
    if let Some(error) = builder.error {
        return Err(error);
    }
    let mut documents = builder.documents.into_iter();
    let root = documents.next().unwrap_or(Node { line: 1, ..NULL });
    if let Some(second) = documents.next() {
        return Err(YamlError {
            line: second.line,
            message: "Source contains multiple documents".to_owned(),
        });
    }
    Ok(Document { root })
}

#[cfg(test)]
mod tests {
    use super::{Key, Keys, Location, Style, Yaml, parse};

    fn root(text: &str) -> super::Node {
        parse(text, Keys::Unique).expect("parses").root
    }

    #[test]
    fn resolves_plain_scalars_by_the_core_schema() {
        let doc = root(
            "a: ~\nb: null\nc: true\nd: False\ne: 12\nf: -1.5\ng: 0x1f\nh: 0o17\ni: .inf\nj: on\nk: '12'\nl: 1e3\nm: 1.2.3\nn:\no: -.INF\np: .NaN\nq: !!str 12\nr: 1.\ns: .5\nt: 0x\n",
        );
        let value = |key: &str| doc.get(key).expect(key).value.clone();
        assert_eq!(value("a"), Yaml::Null);
        assert_eq!(value("b"), Yaml::Null);
        assert_eq!(value("c"), Yaml::Bool(true));
        assert_eq!(value("d"), Yaml::Bool(false));
        assert_eq!(value("e"), Yaml::Number(12.0));
        assert_eq!(value("f"), Yaml::Number(-1.5));
        assert_eq!(value("g"), Yaml::Number(31.0));
        assert_eq!(value("h"), Yaml::Number(15.0));
        assert_eq!(value("i"), Yaml::Number(f64::INFINITY));
        assert_eq!(value("j"), Yaml::Str("on".to_owned()));
        assert_eq!(value("k"), Yaml::Str("12".to_owned()));
        assert_eq!(value("l"), Yaml::Number(1000.0));
        assert_eq!(value("m"), Yaml::Str("1.2.3".to_owned()));
        assert_eq!(value("n"), Yaml::Null);
        assert_eq!(value("o"), Yaml::Number(f64::NEG_INFINITY));
        assert!(matches!(value("p"), Yaml::Number(n) if n.is_nan()));
        assert_eq!(value("q"), Yaml::Str("12".to_owned()));
        assert_eq!(value("r"), Yaml::Number(1.0));
        assert_eq!(value("s"), Yaml::Number(0.5));
        assert_eq!(value("t"), Yaml::Str("0x".to_owned()));
    }

    #[test]
    fn keeps_each_node_line_and_style() {
        let doc = root(
            "jobs:\n  build:\n    steps:\n      - run: |\n          echo\n      - uses: x\n        with: {a: 1}\n",
        );
        assert_eq!(
            doc.locate(&[
                Key::Name("jobs"),
                Key::Name("build"),
                Key::Name("steps"),
                Key::Index(0),
                Key::Name("run")
            ]),
            Location {
                line: 4,
                block: true
            }
        );
        assert_eq!(
            doc.locate(&[
                Key::Name("jobs"),
                Key::Name("build"),
                Key::Name("steps"),
                Key::Index(1)
            ]),
            Location {
                line: 6,
                block: false
            }
        );
        assert_eq!(
            doc.locate(&[Key::Name("jobs"), Key::Name("nope"), Key::Name("x")]),
            Location {
                line: 1,
                block: false
            }
        );
        assert_eq!(doc.locate(&[]).line, 1);
        let step = doc
            .get("jobs")
            .and_then(|jobs| jobs.get("build"))
            .and_then(|build| build.get("steps"))
            .and_then(|steps| steps.items().first())
            .expect("a step");
        assert_eq!(step.get("run").map(|run| run.style), Some(Style::Literal));
        assert_eq!(step.get("run").and_then(|run| run.as_str()), Some("echo\n"));
        assert_eq!(
            root("a: >\n  folded\n  text\n").get("a").map(|a| a.style),
            Some(Style::Folded)
        );
        let blank = root("a: |\n\n  text\nb: x\n");
        assert_eq!(blank.get("a").map(super::Node::value_start_line), Some(2));
        assert_eq!(blank.get("b").map(super::Node::value_start_line), Some(4));
    }

    #[test]
    fn writes_values_as_json() {
        let doc = root("a: [1, 'x\"y', null, true, 1.5]\nb: {c: d}\nc: .nan\n");
        assert_eq!(
            doc.to_json(),
            r#"{"a":[1,"x\"y",null,true,1.5],"b":{"c":"d"},"c":null}"#
        );
        assert_eq!(root("1: x\n").get("1").and_then(|x| x.as_str()), Some("x"));
        assert_eq!(root("x").scalar_text().as_deref(), Some("x"));
        assert_eq!(root("[x]").scalar_text(), None);
        assert_eq!(root("~").scalar_text().as_deref(), Some("null"));
        assert_eq!(root("true").scalar_text().as_deref(), Some("true"));
    }

    #[test]
    fn rejects_duplicate_keys_unless_allowed() {
        let error = parse("a: 1\nb: 2\na: 3\n", Keys::Unique).expect_err("duplicate");
        assert_eq!(error.line, 3);
        assert!(error.message.contains("unique"), "{}", error.message);
        let doc = parse("a: 1\na: 3\n", Keys::MayRepeat)
            .expect("allowed")
            .root;
        assert_eq!(doc.get("a").and_then(super::Node::as_number), Some(1.0));
    }

    #[test]
    fn rejects_bad_syntax_and_a_second_document() {
        let error = parse("a: [1\nb: 2\n", Keys::Unique).expect_err("unclosed");
        assert!(error.line >= 1);
        let error = parse("a: 1\n---\nb: 2\n", Keys::Unique).expect_err("two documents");
        assert!(error.message.contains("multiple documents"));
        assert!(matches!(
            parse("", Keys::Unique).expect("empty").root.value,
            Yaml::Null
        ));
    }

    #[test]
    fn resolves_aliases_to_copies() {
        let doc = root("base: &b {x: 1}\ncopy: *b\nmissing: *b\n");
        assert_eq!(
            doc.get("copy").map(super::Node::to_json).as_deref(),
            Some(r#"{"x":1}"#)
        );
        assert_eq!(doc.get("copy").map(|copy| copy.line), Some(2));
    }
}
