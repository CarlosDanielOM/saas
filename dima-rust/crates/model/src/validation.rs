//! Mongoose's document validation, for new documents and saves.
//!
//! Mongoose validates on `create` and `save`, and on an update only when the call asks for it
//! (`runValidators`, [`crate::update_validation`]); read types never validate. Each collection module lists its validators as [`Rule`]s in schema path
//! order, the way `schema.path(p).validators` lists them; the input type runs them on the document
//! it is about to insert ([`validate`]), after defaults and `trim` were applied, exactly where
//! Mongoose runs them, and every save runs them on the whole document after the caller's changes
//! (see `writes.rs` for the scope and order a save has). `tests/schema_drift.rs` compares every
//! rule with Mongoose's own list.
//!
//! What each check accepts is Mongoose 8.24.3's:
//!
//! | check | passes when |
//! |---|---|
//! | `required` | the value is not missing or `null`; a string is not empty |
//! | `enum` | missing, `null`, or one of the values |
//! | `min` / `max` | missing, `null`, or a number in range |
//! | `maxlength` | missing, `null`, or a string of at most that many characters |
//! | user defined | missing, or the validator accepts the value |
//!
//! One error per path: the first validator that fails. Messages are Mongoose's, so a route that
//! returns `error.message` returns the same text. Lengths count Unicode scalar values, not UTF-16
//! units (`MIGRATION.md` section 4, first row: an emoji counts 1), and so does the cut of a long
//! value in a `maxlength` message (Mongoose shows the first 30 units and `...`).

use bson::{Bson, Document};
use dima_store::mongo::schema::{Field, Kind, Schema};
use std::fmt;

/// One validator of a schema path.
#[derive(Clone, Copy, Debug)]
pub struct Rule {
    /// The path, with `$` standing for every element of a document array (`config.$.id`).
    pub path: &'static str,
    /// The check.
    pub check: Check,
}

impl Rule {
    /// `required: true`.
    pub const fn required(path: &'static str) -> Self {
        Self {
            path,
            check: Check::Required,
        }
    }

    /// `required: function () {…}`: required when the function, given the whole document,
    /// returns `true`.
    pub const fn required_when(path: &'static str, when: fn(&Document) -> bool) -> Self {
        Self {
            path,
            check: Check::RequiredWhen(when),
        }
    }

    /// `enum: [...]` (pass the enumeration's `STRINGS`).
    pub const fn one_of(path: &'static str, values: &'static [&'static str]) -> Self {
        Self {
            path,
            check: Check::Enum(values),
        }
    }

    /// `min: n`.
    pub const fn min(path: &'static str, min: f64) -> Self {
        Self {
            path,
            check: Check::Min(min),
        }
    }

    /// `max: n`.
    pub const fn max(path: &'static str, max: f64) -> Self {
        Self {
            path,
            check: Check::Max(max),
        }
    }

    /// `maxlength: n`.
    pub const fn max_length(path: &'static str, max: usize) -> Self {
        Self {
            path,
            check: Check::MaxLength(max),
        }
    }

    /// `validate: { validator, message }`.
    pub const fn custom(
        path: &'static str,
        message: &'static str,
        valid: fn(&Bson) -> bool,
    ) -> Self {
        Self {
            path,
            check: Check::Custom { message, valid },
        }
    }

    /// `validate: { validator, message: (props) => ... }`: a message built from the value
    /// (`message` gets it as JavaScript's template literal shows it). `declared` is the message
    /// function's text as Mongoose reports it (`String(validator.message)`), for the drift test.
    pub const fn custom_with(
        path: &'static str,
        declared: &'static str,
        message: fn(&str) -> String,
        valid: fn(&Bson) -> bool,
    ) -> Self {
        Self {
            path,
            check: Check::CustomWith {
                declared,
                message,
                valid,
            },
        }
    }
}

/// What a [`Rule`] checks.
#[derive(Clone, Copy, Debug)]
pub enum Check {
    /// `required: true`.
    Required,
    /// `required: function`, evaluated on the whole document.
    RequiredWhen(fn(&Document) -> bool),
    /// `enum`.
    Enum(&'static [&'static str]),
    /// `min`.
    Min(f64),
    /// `max`.
    Max(f64),
    /// `maxlength`.
    MaxLength(usize),
    /// A user-defined validator with its message.
    Custom {
        /// The message (Mongoose's `{PATH}`/`{VALUE}` placeholders are not used by the schemas).
        message: &'static str,
        /// The validator; it is not called for a missing value.
        valid: fn(&Bson) -> bool,
    },
    /// A user-defined validator whose message is a function of the value.
    CustomWith {
        /// The message function's text as Mongoose reports it (for the drift test).
        declared: &'static str,
        /// The message, given the value as text.
        message: fn(&str) -> String,
        /// The validator; it is not called for a missing value.
        valid: fn(&Bson) -> bool,
    },
}

/// The kind of a failed validator, as Mongoose names it (`ValidatorError.kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidatorKind {
    /// `required`.
    Required,
    /// `enum`.
    Enum,
    /// `min`.
    Min,
    /// `max`.
    Max,
    /// `maxlength`.
    MaxLength,
    /// `user defined`.
    UserDefined,
    /// Not Mongoose's: a value of the wrong BSON type for its path (`dima-model` refuses what
    /// the store would send uncast; see `shape.rs`).
    Type,
    /// Not Mongoose's: `null` where the read type has no null.
    Null,
    /// Not Mongoose's: a path the read type needs, removed or left out.
    Missing,
}

impl ValidatorKind {
    /// Mongoose's name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::Enum => "enum",
            Self::Min => "min",
            Self::Max => "max",
            Self::MaxLength => "maxlength",
            Self::UserDefined => "user defined",
            Self::Type => "type",
            Self::Null => "null",
            Self::Missing => "missing",
        }
    }
}

/// One failed validator (`ValidatorError`).
#[derive(Clone, Debug, PartialEq)]
pub struct ValidatorError {
    /// The path, array positions included (`config.0.id`).
    pub path: String,
    /// Which validator failed.
    pub kind: ValidatorKind,
    /// Mongoose's message.
    pub message: String,
}

/// A document Mongoose would refuse to insert (`ValidationError`).
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub struct ValidationError {
    /// The Mongoose model name (the message of a document's validation starts with it).
    pub model: &'static str,
    /// Raised by update validators (`runValidators`): Mongoose's message then names no model
    /// (`Validation failed: …`, `ValidationError(null)`).
    pub on_update: bool,
    /// The failed validators, in the order Mongoose reports them.
    pub errors: Vec<ValidatorError>,
}

impl fmt::Display for ValidationError {
    /// `Commands validation failed: channelID: Path \`channelID\` is required.`
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.on_update {
            formatter.write_str("Validation failed: ")?;
        } else {
            write!(formatter, "{} validation failed: ", self.model)?;
        }
        for (i, error) in self.errors.iter().enumerate() {
            if i > 0 {
                formatter.write_str(", ")?;
            }
            write!(formatter, "{}: {}", error.path, error.message)?;
        }
        Ok(())
    }
}

/// Runs `rules` on `document` (the document as it will be inserted), in Mongoose's order.
///
/// `schema` tells plain nested objects (whose required children are simply missing when the
/// object is) from sub-documents (whose validators do not run when the sub-document is absent,
/// and whose messages name the path inside the sub-document: key `free_credit_reset.status`,
/// message ``... for path `status`.``).
///
/// The order is Mongoose's (`_getPathsToValidate`): at each level, first the required paths that
/// are missing, in reverse schema order (`Schema.requiredPaths()` walks the paths backwards), then
/// the paths that hold a value, in schema order; the errors of single nested sub-documents and
/// document array elements come after those of their parent, in schema order.
pub fn validate(
    model: &'static str,
    schema: &Schema,
    rules: &[Rule],
    document: &Document,
) -> Result<(), ValidationError> {
    validate_given(model, schema, rules, document, None)
}

/// [`validate`] for a document about to be created from `given` (the values the caller gave,
/// before defaults). Mongoose validates before `minimize` removes empty objects, so a required
/// path given `{}` passes and is then stored without the field: such a path counts as present.
pub fn validate_given(
    model: &'static str,
    schema: &Schema,
    rules: &[Rule],
    document: &Document,
    given: Option<&Document>,
) -> Result<(), ValidationError> {
    validate_ordered(model, schema, rules, document, given, None)
}

/// Where an error of the top level goes in Mongoose's report, for a save: the key the errors of
/// the top level's own paths are sorted by (the errors of sub-documents and array elements still
/// come after them, in schema order). Given the local path, whether it holds a value, and its
/// schema position.
pub(crate) type ErrorOrder<'o> = &'o dyn Fn(&str, bool, &[usize]) -> (u8, Vec<usize>);

/// [`validate_given`] with the top level's errors in the order `order` gives (saves), or in the
/// order of a new document (`None`).
pub(crate) fn validate_ordered(
    model: &'static str,
    schema: &Schema,
    rules: &[Rule],
    document: &Document,
    given: Option<&Document>,
    order: Option<ErrorOrder<'_>>,
) -> Result<(), ValidationError> {
    let split: Vec<(Vec<&'static str>, Check)> = rules
        .iter()
        .map(|rule| (rule.path.split('.').collect(), rule.check))
        .collect();
    let level: Vec<LevelRule<'_>> = split
        .iter()
        .map(|(segments, check)| LevelRule {
            segments,
            check: *check,
        })
        .collect();
    let mut errors = Vec::new();
    validate_level(
        schema.fields,
        document,
        given,
        &level,
        "",
        document,
        order,
        &mut errors,
    );
    if errors.is_empty() {
        Ok(())
    } else {
        Err(ValidationError {
            model,
            on_update: false,
            errors,
        })
    }
}

/// A rule, relative to the (sub-)document being validated.
#[derive(Clone, Copy)]
pub(crate) struct LevelRule<'r> {
    pub(crate) segments: &'r [&'static str],
    pub(crate) check: Check,
}

/// Where a rule path lands inside one level.
enum Located<'r> {
    /// A path of this level (plain nested objects included), at a schema position.
    Leaf {
        local: String,
        position: Vec<usize>,
        field: &'static Field,
    },
    /// A path inside a sub-document or document array element of this level.
    Child {
        local: String,
        position: Vec<usize>,
        kind: Kind,
        rest: &'r [&'static str],
    },
}

fn locate<'r>(fields: &'static [Field], segments: &'r [&'static str]) -> Option<Located<'r>> {
    let mut fields = fields;
    let mut position = Vec::new();
    let mut local: Vec<&str> = Vec::new();
    for (i, segment) in segments.iter().enumerate() {
        let (index, field) = fields
            .iter()
            .enumerate()
            .find(|(_, f)| f.name == *segment)?;
        position.push(index);
        local.push(segment);
        let rest = segments.get(i + 1..).unwrap_or_default();
        if rest.is_empty() {
            return Some(Located::Leaf {
                local: local.join("."),
                position,
                field,
            });
        }
        match field.kind {
            Kind::Nested(children) => fields = children,
            Kind::Subdocument(_) => {
                return Some(Located::Child {
                    local: local.join("."),
                    position,
                    kind: field.kind,
                    rest,
                });
            }
            Kind::DocumentArray(_) => {
                let (dollar, deeper) = rest.split_first()?;
                return (*dollar == "$").then(|| Located::Child {
                    local: local.join("."),
                    position,
                    kind: field.kind,
                    rest: deeper,
                });
            }
            _ => return None,
        }
    }
    None
}

/// The value at a dotted path of plain nested objects.
fn value_at<'a>(document: &'a Document, path: &str) -> Option<&'a Bson> {
    let mut current = document;
    let mut parts = path.split('.').peekable();
    while let Some(part) = parts.next() {
        let value = current.get(part)?;
        if parts.peek().is_none() {
            return Some(value);
        }
        match value {
            Bson::Document(inner) => current = inner,
            _ => return None,
        }
    }
    None
}

/// The value Mongoose validates at `path`: the document's, or, when `minimize` removed it, the
/// object the caller gave there (Mongoose validates before minimizing).
fn effective_value<'a>(
    document: &'a Document,
    given: Option<&'a Document>,
    path: &str,
) -> Option<&'a Bson> {
    value_at(document, path).or_else(|| {
        given
            .and_then(|g| value_at(g, path))
            .filter(|v| matches!(v, Bson::Document(_)))
    })
}

fn joined(prefix: &str, local: &str) -> String {
    if prefix.is_empty() {
        local.to_owned()
    } else {
        format!("{prefix}.{local}")
    }
}

struct ChildRules<'r> {
    local: String,
    position: Vec<usize>,
    kind: Kind,
    rules: Vec<LevelRule<'r>>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn validate_level(
    fields: &'static [Field],
    document: &Document,
    given: Option<&Document>,
    rules: &[LevelRule<'_>],
    prefix: &str,
    root: &Document,
    order: Option<ErrorOrder<'_>>,
    errors: &mut Vec<ValidatorError>,
) {
    let mut missing: Vec<(Vec<usize>, ValidatorError)> = Vec::new();
    // With an order: the same errors with their sort keys.
    let mut ordered: Vec<((u8, Vec<usize>), ValidatorError)> = Vec::new();
    // (sort key, schema position, error).
    let mut present: Vec<(Vec<usize>, Vec<usize>, ValidatorError)> = Vec::new();
    let mut children: Vec<ChildRules<'_>> = Vec::new();
    // An empty-object default (`default: () => ({})`) is present when Mongoose validates, and
    // removed by `minimize` afterwards.
    let empty = Bson::Document(Document::new());
    for rule in rules {
        match locate(fields, rule.segments) {
            Some(Located::Leaf {
                local,
                position,
                field,
            }) => {
                if missing.iter().any(|(p, _)| *p == position)
                    || present.iter().any(|(_, p, _)| *p == position)
                {
                    continue;
                }
                let value = effective_value(document, given, &local).or_else(|| {
                    field
                        .default
                        .is_some_and(|d| d.value.build(0) == empty)
                        .then_some(&empty)
                });
                if let Some((kind, message)) = check(rule.check, &local, value, root) {
                    let error = ValidatorError {
                        path: joined(prefix, &local),
                        kind,
                        message,
                    };
                    if let Some(order) = order {
                        let key = order(&local, value.is_some(), &position);
                        ordered.push((key, error.clone()));
                    }
                    if value.is_none() {
                        missing.push((position, error));
                    } else {
                        // A new document's paths a default filled come after the given ones
                        // (Mongoose validates its `modify` state before its `default` state).
                        let defaulted =
                            given.is_some_and(|g| value_at(g, &local).is_none()) && order.is_none();
                        let mut key = vec![usize::from(defaulted)];
                        key.extend(position.iter().copied());
                        present.push((key, position, error));
                    }
                }
            }
            Some(Located::Child {
                local,
                position,
                kind,
                rest,
            }) => {
                let rule = LevelRule {
                    segments: rest,
                    check: rule.check,
                };
                match children.iter_mut().find(|c| c.local == local) {
                    Some(child) => child.rules.push(rule),
                    None => children.push(ChildRules {
                        local,
                        position,
                        kind,
                        rules: vec![rule],
                    }),
                }
            }
            None => {}
        }
    }
    // A sub-document whose own path failed (a user-defined validator on it) is not validated.
    let failed: Vec<Vec<usize>> = missing
        .iter()
        .map(|(position, _)| position)
        .chain(present.iter().map(|(_, position, _)| position))
        .cloned()
        .collect();
    if order.is_some() {
        // The sort is stable: errors with equal keys keep the order they were found in.
        ordered.sort_by(|a, b| a.0.cmp(&b.0));
        errors.extend(ordered.into_iter().map(|(_, e)| e));
    } else {
        missing.sort_by(|a, b| b.0.cmp(&a.0));
        present.sort_by(|a, b| a.0.cmp(&b.0));
        errors.extend(missing.into_iter().map(|(_, e)| e));
        errors.extend(present.into_iter().map(|(_, _, e)| e));
    }
    // Mongoose runs a path's validators one after the other, each asynchronously, and a
    // sub-document's own errors come from its last one: those of a `required` sub-document
    // arrive after those of the others (recorded: `channelaimemories/validate_enums`).
    let required_here: Vec<Vec<usize>> = rules
        .iter()
        .filter(|rule| matches!(rule.check, Check::Required | Check::RequiredWhen(_)))
        .filter_map(|rule| match locate(fields, rule.segments) {
            Some(Located::Leaf { position, .. }) => Some(position),
            _ => None,
        })
        .collect();
    children.sort_by_key(|child| {
        (
            required_here.contains(&child.position),
            child.position.clone(),
        )
    });
    for child in children {
        if failed.contains(&child.position) {
            continue;
        }
        let path = joined(prefix, &child.local);
        let given_child = given.and_then(|g| value_at(g, &child.local));
        match (child.kind, effective_value(document, given, &child.local)) {
            (Kind::Subdocument(schema), Some(Bson::Document(inner))) => {
                let given_inner = match given_child {
                    Some(Bson::Document(g)) => Some(g),
                    _ => None,
                };
                validate_level(
                    schema.fields,
                    inner,
                    given_inner,
                    &child.rules,
                    &path,
                    root,
                    None,
                    errors,
                );
            }
            (Kind::DocumentArray(schema), Some(Bson::Array(items))) => {
                for (i, item) in items.iter().enumerate() {
                    if let Bson::Document(element) = item {
                        let given_element = match given_child {
                            Some(Bson::Array(g)) => match g.get(i) {
                                Some(Bson::Document(g)) => Some(g),
                                _ => None,
                            },
                            _ => None,
                        };
                        let at = format!("{path}.{i}");
                        validate_level(
                            schema.fields,
                            element,
                            given_element,
                            &child.rules,
                            &at,
                            root,
                            None,
                            errors,
                        );
                    }
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn check(
    rule: Check,
    path: &str,
    value: Option<&Bson>,
    document: &Document,
) -> Option<(ValidatorKind, String)> {
    let present = value.filter(|v| !matches!(v, Bson::Null));
    match rule {
        Check::Required => (!required_ok(value)).then(|| required(path)),
        Check::RequiredWhen(when) => {
            (when(document) && !required_ok(value)).then(|| required(path))
        }
        Check::Enum(values) => match present {
            Some(Bson::String(text)) if values.contains(&text.as_str()) => None,
            Some(other) => Some((
                ValidatorKind::Enum,
                format!(
                    "`{}` is not a valid enum value for path `{path}`.",
                    js_string(other)
                ),
            )),
            None => None,
        },
        Check::Min(min) => match present.and_then(dima_store::mongo::number::read_number) {
            Some(n) if n < min => Some((
                ValidatorKind::Min,
                format!(
                    "Path `{path}` ({}) is less than minimum allowed value ({}).",
                    dima_text::number_to_string(n),
                    dima_text::number_to_string(min)
                ),
            )),
            _ => None,
        },
        Check::Max(max) => match present.and_then(dima_store::mongo::number::read_number) {
            Some(n) if n > max => Some((
                ValidatorKind::Max,
                format!(
                    "Path `{path}` ({}) is more than maximum allowed value ({}).",
                    dima_text::number_to_string(n),
                    dima_text::number_to_string(max)
                ),
            )),
            _ => None,
        },
        Check::MaxLength(max) => match present {
            Some(Bson::String(text)) if text.chars().count() > max => {
                // Mongoose shows at most 30 units of the value, then `...` (counted here in
                // characters, like the length itself).
                let length = text.chars().count();
                let shown = if length > 30 {
                    format!("{}...", dima_text::truncate_chars(text, 30))
                } else {
                    text.clone()
                };
                Some((
                    ValidatorKind::MaxLength,
                    format!(
                        "Path `{path}` (`{shown}`, length {length}) is longer than the maximum allowed length ({max})."
                    ),
                ))
            }
            _ => None,
        },
        Check::Custom { message, valid } => match value {
            Some(v) if !valid(v) => Some((ValidatorKind::UserDefined, message.to_owned())),
            _ => None,
        },
        Check::CustomWith { message, valid, .. } => match value {
            Some(v) if !valid(v) => Some((ValidatorKind::UserDefined, message(&js_string(v)))),
            _ => None,
        },
    }
}

fn required_ok(value: Option<&Bson>) -> bool {
    match value {
        None | Some(Bson::Null) => false,
        Some(Bson::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn required(path: &str) -> (ValidatorKind, String) {
    (
        ValidatorKind::Required,
        format!("Path `{path}` is required."),
    )
}

/// `String(value)` for the values the messages show.
fn js_string(value: &Bson) -> String {
    match value {
        Bson::String(text) => text.clone(),
        Bson::Boolean(b) => b.to_string(),
        other => match dima_store::mongo::number::read_number(other) {
            Some(n) => dima_text::number_to_string(n),
            None => other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;
    use dima_store::mongo::schema::ValueType;

    static ITEM: Schema = Schema::subdocument(&[Field::string("id")]);
    static SUB: Schema = Schema::subdocument(&[Field::string("k")]).no_id();
    static S: Schema = Schema::new(&[
        Field::string("name"),
        Field::string("tier"),
        Field::number("n"),
        Field::document_array("items", &ITEM),
        Field::string("ch"),
        Field::nested("nested", &[Field::string("a")]),
        Field::subdocument("sub", &SUB),
        Field::array("tags", ValueType::String),
    ]);

    const RULES: &[Rule] = &[
        Rule::required("name"),
        Rule::max_length("name", 3),
        Rule::one_of("tier", &["free", "pro"]),
        Rule::min("n", 1.0),
        Rule::max("n", 10.0),
        Rule::custom("n", "whole numbers only", |v| {
            dima_store::mongo::number::read_number(v).is_some_and(|n| n.fract() == 0.0)
        }),
        Rule::required("items.$.id"),
        Rule::required_when("ch", |d| d.get_str("tier").is_ok_and(|t| t == "pro")),
    ];
    const NESTED: &[Rule] = &[
        Rule::required("nested.a"),
        Rule::required("sub.k"),
        Rule::required("tags"),
    ];

    #[test]
    fn mongoose_messages_and_order() {
        let ok = validate(
            "M",
            &S,
            RULES,
            &doc! { "name": "a👋b", "tier": "free", "n": 2, "items": [{ "id": "x" }] },
        );
        assert_eq!(ok, Ok(()));
        let Err(error) = validate(
            "M",
            &S,
            RULES,
            &doc! { "name": "", "tier": "gold", "n": 0.5, "items": [{ "id": "x" }, {}], "ch": Bson::Null },
        ) else {
            panic!("must fail");
        };
        assert_eq!(
            error.to_string(),
            "M validation failed: name: Path `name` is required., tier: `gold` is not a valid enum value for path `tier`., \
             n: Path `n` (0.5) is less than minimum allowed value (1)., items.1.id: Path `id` is required."
        );
        let Err(error) = validate(
            "M",
            &S,
            RULES,
            &doc! { "name": "abcd", "n": 11, "tier": "pro" },
        ) else {
            panic!("must fail");
        };
        let kinds: Vec<_> = error
            .errors
            .iter()
            .map(|e| (e.path.as_str(), e.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                ("ch", ValidatorKind::Required),
                ("name", ValidatorKind::MaxLength),
                ("n", ValidatorKind::Max),
            ]
        );
        assert_eq!(
            error.errors[1].message,
            "Path `name` (`abcd`, length 4) is longer than the maximum allowed length (3)."
        );
        // Enum, min, max and maxlength accept null and missing values.
        assert_eq!(
            validate("M", &S, &RULES[2..6], &doc! { "tier": Bson::Null }),
            Ok(())
        );
        // A missing nested object's required child is missing; an absent sub-document is not
        // validated; an empty array satisfies `required`.
        let Err(error) = validate("M", &S, NESTED, &doc! { "tags": [] }) else {
            panic!("must fail");
        };
        assert_eq!(
            error.to_string(),
            "M validation failed: nested.a: Path `nested.a` is required."
        );
        let Err(error) = validate("M", &S, NESTED, &doc! { "nested": { "a": "x" }, "sub": {} })
        else {
            panic!("must fail");
        };
        assert_eq!(
            error.to_string(),
            "M validation failed: tags: Path `tags` is required., sub.k: Path `k` is required."
        );
        // Missing required paths come first, in reverse schema order.
        let Err(error) = validate(
            "M",
            &S,
            &[
                Rule::required("name"),
                Rule::required("tier"),
                Rule::required("n"),
            ],
            &doc! { "tier": "" },
        ) else {
            panic!("must fail");
        };
        let paths: Vec<_> = error.errors.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["n", "name", "tier"]);
    }
}
