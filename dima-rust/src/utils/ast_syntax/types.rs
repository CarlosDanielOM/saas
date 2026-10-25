use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, sync::Arc};

/// Half-open offsets in JavaScript UTF16 code units, in the original source.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiagnosticCode {
    UnexpectedClosing,
    UnclosedDelimiter,
    UnclosedArray,
    UnclosedQuote,
    UnclosedExpression,
    UnexpectedToken,
    MissingVariableName,
    SourceLimit,
    TokenLimit,
    NodeLimit,
    NestingLimit,
    InvalidGrammar,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub message: String,
    pub span: SourceSpan,
}
impl Diagnostic {
    pub(crate) fn new(code: DiagnosticCode, message: impl Into<String>, span: SourceSpan) -> Self {
        Self {
            code,
            message: message.into(),
            span,
        }
    }
    pub fn is_resource_limit(&self) -> bool {
        matches!(
            self.code,
            DiagnosticCode::SourceLimit
                | DiagnosticCode::TokenLimit
                | DiagnosticCode::NodeLimit
                | DiagnosticCode::NestingLimit
        )
    }
}
impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Diagnostic {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum VariableStorage {
    #[serde(rename = "memory")]
    Memory,
    #[serde(rename = "cache")]
    Cache,
    #[serde(rename = "cacheUser")]
    CacheUser,
    #[serde(rename = "db")]
    Db,
    #[serde(rename = "dbUser")]
    DbUser,
}

/// Persisted syntax data. No source metadata is inserted into this JSON shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AstNode {
    #[serde(rename = "root")]
    Root { children: Vec<AstNode> },
    #[serde(rename = "literal")]
    Literal { value: String },
    #[serde(rename = "function")]
    Function { name: String, args: Vec<AstNode> },
    #[serde(rename = "commandRef")]
    CommandRef {
        #[serde(rename = "commandName")]
        command_name: String,
        args: Vec<AstNode>,
    },
    #[serde(rename = "setVar")]
    SetVar {
        name: String,
        storage: VariableStorage,
        value: Box<AstNode>,
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<ArrayAccessor>,
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<AstNode>>,
    },
    #[serde(rename = "getVar")]
    GetVar {
        name: String,
        storage: VariableStorage,
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<ArrayAccessor>,
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<AstNode>>,
    },
    #[serde(rename = "exists")]
    Exists {
        name: String,
        storage: VariableStorage,
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<ArrayAccessor>,
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<AstNode>>,
    },
    #[serde(rename = "deleteVar")]
    DeleteVar {
        name: String,
        storage: VariableStorage,
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<ArrayAccessor>,
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<AstNode>>,
    },
    #[serde(rename = "binary")]
    Binary {
        operator: String,
        left: Box<AstNode>,
        right: Box<AstNode>,
    },
    #[serde(rename = "unary")]
    Unary {
        operator: String,
        argument: Box<AstNode>,
    },
    #[serde(rename = "ternary")]
    Ternary {
        test: Box<AstNode>,
        consequent: Box<AstNode>,
        alternate: Box<AstNode>,
    },
    #[serde(rename = "template")]
    Template { segments: Vec<TemplateSegment> },
    #[serde(rename = "arrayLiteral")]
    ArrayLiteral {
        items: Vec<AstNode>,
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<ArrayAccessor>,
    },
    #[serde(rename = "loopVar")]
    LoopVar { name: String },
    #[serde(rename = "loopAssign")]
    LoopAssign {
        name: String,
        operator: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Box<AstNode>>,
    },
    #[serde(rename = "forLoop")]
    ForLoop {
        #[serde(rename = "loopVar")]
        loop_var: String,
        mode: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        init: Option<Box<AstNode>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        condition: Option<Box<AstNode>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        update: Option<Box<AstNode>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        iterable: Option<Box<AstNode>>,
        body: Vec<AstNode>,
    },
    #[serde(rename = "custom")]
    Custom {
        #[serde(rename = "customType")]
        custom_type: String,
        data: Value,
    },
}
impl AstNode {
    pub fn to_value(&self) -> Value {
        // These enums contain only JSON-representable fields; no fallible map keys/floats.
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
    pub(crate) fn is_empty(&self) -> bool {
        matches!(self, Self::Literal { value } if value.is_empty())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ArrayAccessor {
    #[serde(rename = "array")]
    Array,
    #[serde(rename = "index")]
    Index { index: Box<AstNode> },
    #[serde(rename = "random")]
    Random,
    #[serde(rename = "length")]
    Length,
    #[serde(rename = "append")]
    Append,
    #[serde(rename = "setIndex")]
    SetIndex { index: Box<AstNode> },
    #[serde(rename = "remove")]
    Remove { index: Box<AstNode> },
    #[serde(rename = "clear")]
    Clear,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TemplateSegment {
    #[serde(rename = "text")]
    Text { value: String },
    #[serde(rename = "expr")]
    Expr { node: AstNode },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum SourceSegment {
    #[serde(rename = "text")]
    Text { text: String, span: SourceSpan },
    #[serde(rename = "expr")]
    Expr { source: String, span: SourceSpan },
    #[serde(rename = "unclosed")]
    Unclosed { source: String, span: SourceSpan },
}
impl SourceSegment {
    pub fn raw_text(&self) -> &str {
        match self {
            Self::Text { text, .. } => text,
            Self::Expr { source, .. } | Self::Unclosed { source, .. } => source,
        }
    }
    pub fn span(&self) -> SourceSpan {
        match self {
            Self::Text { span, .. } | Self::Expr { span, .. } | Self::Unclosed { span, .. } => {
                *span
            }
        }
    }
}

/// Defaults are deliberately independent of any worker or runtime configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub source_utf16: usize,
    pub tokens: usize,
    pub nodes: usize,
    pub nesting: usize,
}
/// Also bounds constructed AST depth, keeping Serde traversal and destruction safe.
pub const HARD_NESTING_CEILING: usize = 128;
/// Independent, exclusive ceiling for persisted JSON object/array nesting.
/// The standard serde_json reader rejects entering its 128th container, so
/// parser-produced ASTs stay below this depth, counting field arrays and
/// template/accessor objects. This does not change configured AST nesting.
/// Violations use `NESTING_LIMIT` and the message
/// `AST JSON serialization nesting limit exceeded`.
pub const HARD_JSON_NESTING_CEILING: usize = 128;
impl Default for Limits {
    fn default() -> Self {
        Self {
            source_utf16: 10_000,
            tokens: 20_000,
            nodes: 4_000,
            nesting: 128,
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SyntaxProfile {
    #[default]
    Improved,
    TypeScriptCompatible,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParseStats {
    /// Tokens emitted into arenas, including nested items and interpolations.
    pub tokens: usize,
    /// Constructed AST nodes, including discarded empty/error-path nodes.
    pub nodes: usize,
    /// Array layouts completed by indexing passes. A compiled chat plan indexes
    /// arrays once for scanner boundaries and again for expression tokenization;
    /// this is work accounting, not a count of unique AST arrays.
    pub arrays: usize,
    /// Bytes visited by complete structural array-index passes. Nested arrays
    /// within one indexed region do not cause ancestor text to be counted again.
    pub array_indexed_bytes: usize,
    /// Directly consumed lexer bytes: array introducer/closer count as three
    /// bytes, with descendant bytes counted by their own lexical calls. This
    /// excludes the separately recorded array-index pass and scanner plain text.
    pub lexed_bytes: usize,
}

impl ParseStats {
    pub(crate) fn since(self, previous: Self) -> Self {
        Self {
            tokens: self.tokens.saturating_sub(previous.tokens),
            nodes: self.nodes.saturating_sub(previous.nodes),
            arrays: self.arrays.saturating_sub(previous.arrays),
            array_indexed_bytes: self
                .array_indexed_bytes
                .saturating_sub(previous.array_indexed_bytes),
            lexed_bytes: self.lexed_bytes.saturating_sub(previous.lexed_bytes),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CompiledProgram {
    pub(crate) source: Arc<str>,
    pub(crate) bytes: std::ops::Range<usize>,
    pub(crate) root: AstNode,
    pub(crate) stats: ParseStats,
}
impl CompiledProgram {
    pub fn source(&self) -> &str {
        &self.source[self.bytes.clone()]
    }
    pub fn root(&self) -> &AstNode {
        &self.root
    }
    pub fn to_value(&self) -> Value {
        self.root.to_value()
    }
    pub fn stats(&self) -> ParseStats {
        self.stats
    }
}

#[derive(Clone, Debug)]
pub struct SegmentPlan {
    pub(crate) segment: SourceSegment,
    pub(crate) program: Option<Result<CompiledProgram, Diagnostic>>,
    pub(crate) diagnostic: Option<Diagnostic>,
}
impl SegmentPlan {
    pub fn source_segment(&self) -> &SourceSegment {
        &self.segment
    }
    pub fn program(&self) -> Option<&Result<CompiledProgram, Diagnostic>> {
        self.program.as_ref()
    }
    pub fn diagnostic(&self) -> Option<&Diagnostic> {
        self.diagnostic.as_ref()
    }
}
