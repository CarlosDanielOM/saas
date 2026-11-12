use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, sync::Arc};

/// A half-open range of **byte offsets** into the original source text.
///
/// Every position inside this crate is a byte offset. JavaScript clients index strings in UTF-16
/// units; [`Span::to_utf16`] is the single place that converts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Span {
    /// First byte.
    pub start: usize,
    /// One past the last byte.
    pub end: usize,
}

/// A span in UTF-16 code units, the unit a JavaScript string index uses.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Utf16Span {
    /// First unit.
    pub start: usize,
    /// One past the last unit (exclusive, like `String.prototype.slice`).
    pub end: usize,
}

impl Span {
    pub(crate) fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    /// The same range in UTF-16 units of `source`, for a JavaScript client.
    ///
    /// Contract edge (`MIGRATION.md` section 4, "a position sent to a client"): this is the only
    /// conversion of a position. No API route sends one today: the block editor receives messages
    /// and block ids, and the reference returns no positions at all.
    pub fn to_utf16(self, source: &str) -> Utf16Span {
        Utf16Span {
            start: dima_text::utf16_offset(source, self.start),
            end: dima_text::utf16_offset(source, self.end),
        }
    }
}

/// What went wrong; the first group mirrors the reference's error strings, the second group is
/// this port's resource limits (the reference has none).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DiagnosticCode {
    /// `Unexpected closing "…"`.
    UnexpectedClosing,
    /// `Unclosed "…"`.
    UnclosedDelimiter,
    /// `Unclosed array literal`.
    UnclosedArray,
    /// `Unclosed quoted string`.
    UnclosedQuote,
    /// `Unclosed expression` (a template segment with no matching `)`).
    UnclosedExpression,
    /// `Missing variable name`: `%(`, `^(` or `%del(` at the very end of an array item. The
    /// reference throws a `TypeError` there; this port reports it instead.
    MissingVariableName,
    /// `Missing user selector`: `%(##x(`, `^(##x(` or `%del(##x(` at the very end of an array
    /// item. The reference throws a `TypeError` there (`unescapeLiteral(undefined)`); this port
    /// reports it instead. Inside an interpolation both show `[Parse error: …]` with the
    /// interpolation's text, because the reference catches the throw there.
    MissingUserSelector,
    /// A stored command text has more characters than [`Limits::source_chars`]
    /// ([`SyntaxEngine::check_source`](super::SyntaxEngine::check_source)).
    SourceLimit,
    /// The text to parse has more characters than [`Limits::input_chars`].
    InputLimit,
    /// More tokens than [`Limits::tokens`] or the program's derived token budget.
    TokenLimit,
    /// More AST nodes than [`Limits::nodes`] or the program's derived node budget.
    NodeLimit,
    /// Deeper than [`Limits::nesting`], or (only from
    /// [`CompiledProgram::check_json_depth`]) deeper than the JSON reader's ceiling.
    NestingLimit,
    /// The lexer visited more bytes than the program's work budget ([`WORK_BASE`],
    /// [`WORK_PER_INPUT_BYTE`]): quoted templates nested in each other are lexed once per level.
    WorkLimit,
    /// A grammar extension that the lexer cannot support.
    InvalidGrammar,
}

impl DiagnosticCode {
    /// The code's stable name (`UNCLOSED_QUOTE`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnexpectedClosing => "UNEXPECTED_CLOSING",
            Self::UnclosedDelimiter => "UNCLOSED_DELIMITER",
            Self::UnclosedArray => "UNCLOSED_ARRAY",
            Self::UnclosedQuote => "UNCLOSED_QUOTE",
            Self::UnclosedExpression => "UNCLOSED_EXPRESSION",
            Self::MissingVariableName => "MISSING_VARIABLE_NAME",
            Self::MissingUserSelector => "MISSING_USER_SELECTOR",
            Self::SourceLimit => "SOURCE_LIMIT",
            Self::InputLimit => "INPUT_LIMIT",
            Self::TokenLimit => "TOKEN_LIMIT",
            Self::NodeLimit => "NODE_LIMIT",
            Self::NestingLimit => "NESTING_LIMIT",
            Self::WorkLimit => "WORK_LIMIT",
            Self::InvalidGrammar => "INVALID_GRAMMAR",
        }
    }
}

/// A syntax error: the reference's message text, a code, and where it is (bytes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    /// What kind of error.
    pub code: DiagnosticCode,
    /// The reference's message (`[Parse error: {message}]` is what chat shows).
    pub message: String,
    /// Where, in bytes of the original source.
    pub span: Span,
}

impl Diagnostic {
    pub(crate) fn new(code: DiagnosticCode, message: impl Into<String>, span: Span) -> Self {
        Self {
            code,
            message: message.into(),
            span,
        }
    }

    /// A resource limit of this port, as opposed to an error the reference reports too.
    pub fn is_resource_limit(&self) -> bool {
        matches!(
            self.code,
            DiagnosticCode::SourceLimit
                | DiagnosticCode::InputLimit
                | DiagnosticCode::TokenLimit
                | DiagnosticCode::NodeLimit
                | DiagnosticCode::NestingLimit
                | DiagnosticCode::WorkLimit
        )
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Diagnostic {}

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name { $($(#[$vmeta])* #[serde(rename = $text)] $variant),+ }
        impl $name {
            /// The spelling in command text and in the JSON shape.
            pub fn as_str(self) -> &'static str { match self { $(Self::$variant => $text),+ } }
            /// The value spelled `text`.
            pub fn parse(text: &str) -> Option<Self> { match text { $($text => Some(Self::$variant)),+, _ => None } }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.as_str()) }
        }
    };
}
string_enum!(
    /// Where a variable lives, from its name prefix: none, `#`, `##`, `*`, `**`.
    VariableStorage {
        /// No prefix: this run only.
        Memory => "memory",
        /// `#`: channel cache.
        Cache => "cache",
        /// `##`: per-viewer cache.
        CacheUser => "cacheUser",
        /// `*`: channel database.
        Db => "db",
        /// `**`: per-viewer database.
        DbUser => "dbUser",
    }
);

impl VariableStorage {
    /// The name prefix that selects this storage.
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Memory => "",
            Self::Cache => "#",
            Self::CacheUser => "##",
            Self::Db => "*",
            Self::DbUser => "**",
        }
    }

    /// Per-viewer storages accept a user selector: `%(**points($(touser)))`.
    pub fn is_user_scoped(self) -> bool {
        matches!(self, Self::CacheUser | Self::DbUser)
    }

    /// The storage a raw variable name selects (`parseVarName` in `registry.ts`).
    pub fn from_name(raw: &str) -> Self {
        if raw.starts_with("**") {
            Self::DbUser
        } else if raw.starts_with('*') {
            Self::Db
        } else if raw.starts_with("##") {
            Self::CacheUser
        } else if raw.starts_with('#') {
            Self::Cache
        } else {
            Self::Memory
        }
    }
}

string_enum!(
    /// Binary operators: comparisons, then arithmetic.
    BinaryOp {
        /// `==`
        Equal => "==",
        /// `!=`
        NotEqual => "!=",
        /// `>=`
        GreaterEqual => ">=",
        /// `<=`
        LessEqual => "<=",
        /// `~=`
        Match => "~=",
        /// `<>`
        AlternateNotEqual => "<>",
        /// `>`
        Greater => ">",
        /// `<`
        Less => "<",
        /// `=` (a comparison here, not an assignment)
        Assign => "=",
        /// `*`
        Multiply => "*",
        /// `/`
        Divide => "/",
        /// `%`
        Modulo => "%",
        /// `+`
        Add => "+",
        /// `-`
        Subtract => "-",
    }
);

impl BinaryOp {
    /// Binding strength in `parseStarExpression`: comparisons 2, `+ -` 3, `* / %` 4.
    pub fn precedence(self) -> u8 {
        match self {
            Self::Add | Self::Subtract => 3,
            Self::Multiply | Self::Divide | Self::Modulo => 4,
            _ => 2,
        }
    }
}

string_enum!(
    /// Unary operators.
    UnaryOp {
        /// `+`
        Plus => "+",
        /// `-`
        Minus => "-",
    }
);

string_enum!(
    /// Loop counter assignments.
    LoopAssignOp {
        /// `=`
        Assign => "=",
        /// `+=`
        Add => "+=",
        /// `-=`
        Subtract => "-=",
        /// `*=`
        Multiply => "*=",
        /// `/=`
        Divide => "/=",
        /// `%=`
        Modulo => "%=",
        /// `++`
        Increment => "++",
        /// `--`
        Decrement => "--",
    }
);

impl LoopAssignOp {
    /// `++` and `--` take no value.
    pub fn takes_value(self) -> bool {
        !matches!(self, Self::Increment | Self::Decrement)
    }
}

string_enum!(
    /// The two loop forms.
    LoopMode {
        /// `for #i = 0; #i < 3; #i++ { … }`
        Range => "range",
        /// `for #x in %(list[]) { … }`
        Foreach => "foreach",
    }
);

/// A parsed program, in the JSON shape the reference's `AstNode` has (`type` tags, camelCase
/// fields, absent optional fields omitted).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AstNode {
    /// The program, or several nodes where one was expected (loop headers).
    #[serde(rename = "root")]
    Root {
        /// The nodes in order.
        children: Vec<AstNode>,
    },
    /// Text.
    #[serde(rename = "literal")]
    Literal {
        /// Its value, escapes resolved.
        value: String,
    },
    /// `$(name args…)`.
    #[serde(rename = "function")]
    Function {
        /// Dotted name (`raid.channel`); empty when the call has no valid name.
        name: String,
        /// Arguments.
        args: Vec<AstNode>,
    },
    /// `#(command args…)`.
    #[serde(rename = "commandRef")]
    CommandRef {
        /// The token after `#(`, as written.
        #[serde(rename = "commandName")]
        command_name: String,
        /// Arguments.
        args: Vec<AstNode>,
    },
    /// `%(name value)`, `%(list[] value)`, `%(list[i] value)`.
    #[serde(rename = "setVar")]
    SetVar {
        /// Raw name, storage prefix included (`*deaths`).
        name: String,
        /// Storage from the prefix.
        storage: VariableStorage,
        /// The value.
        value: Box<AstNode>,
        /// `append` or `setIndex`.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<ArrayAccessor>,
        /// Per-viewer selector.
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<AstNode>>,
    },
    /// `%(name)`, `%(list[i])`, `%(list[].length)`.
    #[serde(rename = "getVar")]
    GetVar {
        /// Raw name, storage prefix included.
        name: String,
        /// Storage from the prefix.
        storage: VariableStorage,
        /// List access.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<ArrayAccessor>,
        /// Per-viewer selector.
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<AstNode>>,
    },
    /// `^(name)`.
    #[serde(rename = "exists")]
    Exists {
        /// Raw name, storage prefix included.
        name: String,
        /// Storage from the prefix.
        storage: VariableStorage,
        /// List access.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<ArrayAccessor>,
        /// Per-viewer selector.
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<AstNode>>,
    },
    /// `%del(name)`, `%del(list[])`, `%del(list[i])`.
    #[serde(rename = "deleteVar")]
    DeleteVar {
        /// Raw name, storage prefix included.
        name: String,
        /// Storage from the prefix.
        storage: VariableStorage,
        /// `clear` or `remove`.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<ArrayAccessor>,
        /// Per-viewer selector.
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<AstNode>>,
    },
    /// `left op right`.
    #[serde(rename = "binary")]
    Binary {
        /// The operator.
        operator: BinaryOp,
        /// Left side.
        left: Box<AstNode>,
        /// Right side.
        right: Box<AstNode>,
    },
    /// `-x`, `+x`.
    #[serde(rename = "unary")]
    Unary {
        /// The operator.
        operator: UnaryOp,
        /// The operand.
        argument: Box<AstNode>,
    },
    /// `test ? consequent : alternate` (missing parts are empty literals).
    #[serde(rename = "ternary")]
    Ternary {
        /// The condition.
        test: Box<AstNode>,
        /// When true.
        consequent: Box<AstNode>,
        /// When false.
        alternate: Box<AstNode>,
    },
    /// A double-quoted string with `${…}` interpolations.
    #[serde(rename = "template")]
    Template {
        /// Text and expression pieces.
        segments: Vec<TemplateSegment>,
    },
    /// `%[a, b, c]` with an optional accessor.
    #[serde(rename = "arrayLiteral")]
    ArrayLiteral {
        /// The items.
        items: Vec<AstNode>,
        /// `[i]`, `[random]` or `[].length`.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<ArrayAccessor>,
    },
    /// `#i` inside a loop.
    #[serde(rename = "loopVar")]
    LoopVar {
        /// The name without `#`.
        name: String,
    },
    /// `#i = …`, `#i++`.
    #[serde(rename = "loopAssign")]
    LoopAssign {
        /// The name without `#`.
        name: String,
        /// The assignment.
        operator: LoopAssignOp,
        /// The value (absent for `++` and `--`).
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Box<AstNode>>,
    },
    /// `*(for … { … })`.
    #[serde(rename = "forLoop")]
    ForLoop {
        /// The counter's name without `#`.
        #[serde(rename = "loopVar")]
        loop_var: String,
        /// Range or foreach.
        mode: LoopMode,
        /// Range start.
        #[serde(skip_serializing_if = "Option::is_none")]
        init: Option<Box<AstNode>>,
        /// Range condition.
        #[serde(skip_serializing_if = "Option::is_none")]
        condition: Option<Box<AstNode>>,
        /// Range step.
        #[serde(skip_serializing_if = "Option::is_none")]
        update: Option<Box<AstNode>>,
        /// Foreach list.
        #[serde(skip_serializing_if = "Option::is_none")]
        iterable: Option<Box<AstNode>>,
        /// The body.
        body: Vec<AstNode>,
    },
    /// An extension node; the parser never builds one.
    #[serde(rename = "custom")]
    Custom {
        /// Extension name.
        #[serde(rename = "customType")]
        custom_type: String,
        /// Extension payload.
        data: Value,
    },
}

impl AstNode {
    /// The node as JSON, in the reference's shape.
    pub fn to_value(&self) -> Value {
        // Only strings, arrays, objects and `custom` payloads that are already JSON.
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    pub(crate) fn is_empty_literal(&self) -> bool {
        matches!(self, Self::Literal { value } if value.is_empty())
    }
}

/// List access on a variable or array literal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ArrayAccessor {
    /// `[]`: the whole list.
    #[serde(rename = "array")]
    Array,
    /// `[i]`.
    #[serde(rename = "index")]
    Index {
        /// The position.
        index: Box<AstNode>,
    },
    /// `[random]`.
    #[serde(rename = "random")]
    Random,
    /// `.length` / `[].length`.
    #[serde(rename = "length")]
    Length,
    /// `%(list[] value)`.
    #[serde(rename = "append")]
    Append,
    /// `%(list[i] value)`.
    #[serde(rename = "setIndex")]
    SetIndex {
        /// The position.
        index: Box<AstNode>,
    },
    /// `%del(list[i])`.
    #[serde(rename = "remove")]
    Remove {
        /// The position.
        index: Box<AstNode>,
    },
    /// `%del(list[])`.
    #[serde(rename = "clear")]
    Clear,
}

/// A piece of a quoted template.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TemplateSegment {
    /// Text, including `[Parse error: …]` for an interpolation that does not tokenize.
    #[serde(rename = "text")]
    Text {
        /// The text.
        value: String,
    },
    /// `${…}`.
    #[serde(rename = "expr")]
    Expr {
        /// The expression.
        node: AstNode,
    },
}

/// What a piece of command text is, as the chat renderer splits it (`scanSourceSegments`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SegmentKind {
    /// Plain text, copied as is.
    Text,
    /// One top-level expression: `$(…)`, `%(…)`, `*(…)`, `^(…)`, `%del(…)`, `#(…)`.
    Expr,
    /// A start token with no matching `)`; rendering stops here.
    Unclosed,
}

impl SegmentKind {
    /// `text`, `expr` or `unclosed`, as the reference names them.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Expr => "expr",
            Self::Unclosed => "unclosed",
        }
    }
}

/// One piece of command text: a kind and a byte range of the source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SourceSegment {
    /// What it is.
    pub kind: SegmentKind,
    /// Where, in bytes.
    pub span: Span,
}

impl SourceSegment {
    /// The segment's text in `source` (the text the scanner ran on).
    pub fn text<'a>(&self, source: &'a str) -> &'a str {
        source
            .get(self.span.start..self.span.end)
            .unwrap_or_default()
    }
}

/// Resource limits. The reference has none; these keep hostile input bounded. Defaults are
/// independent of any caller's configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Limits {
    /// Longest stored command text, in characters (Unicode scalar values). Checked where a
    /// command is saved ([`SyntaxEngine::check_source`](super::SyntaxEngine::check_source)),
    /// not by parsing: viewer arguments are substituted into the text before it is parsed.
    pub source_chars: usize,
    /// Longest text that parsing, scanning and compiling accept, in characters: a stored text
    /// with its placeholders substituted ([`MAX_INPUT_CHARS`]).
    pub input_chars: usize,
    /// Tokens per program (a parse, or one template segment), nested arrays and interpolations
    /// included. A fixed cap on top of the budget derived from the program's length
    /// ([`TOKENS_PER_INPUT_BYTE`]); by default there is none.
    pub tokens: usize,
    /// AST nodes per program, discarded nodes included. A fixed cap on top of the budget
    /// derived from the program's length ([`NODES_PER_INPUT_BYTE`]); by default there is none.
    pub nodes: usize,
    /// Nesting depth (recursion levels and AST height); never above [`MAX_NESTING`].
    pub nesting: usize,
}

/// The longest stored command text, in characters (the commands API enforces it on save).
pub const MAX_SOURCE_CHARS: usize = 10_000;

/// The longest viewer argument, in characters: a Twitch chat message is at most 500 characters,
/// and a command's argument is that message without the command name.
pub const MAX_ARGUMENT_CHARS: usize = 500;

/// The longest text the parser can be given: a stored text with every placeholder substituted.
///
/// `resolveArgumentPlaceholders` (`dimabot/src/handlers/special_parser.handler.ts`) replaces each
/// `&pN` by one word of the argument and each `&t` by the rest of the argument; other text is
/// kept. The shortest placeholder is `&t` (2 characters) and its replacement is at most the
/// whole argument, so the longest result is a stored text made only of `&t`: 10,000 / 2 × 500 =
/// 2,500,000 characters. With literal arguments (commands, goals, cheers) each placeholder
/// becomes `%(cmd_arg_<32 hex digits>_<n>)` instead, at most 48 characters, which is shorter.
pub const MAX_INPUT_CHARS: usize = MAX_SOURCE_CHARS / 2 * MAX_ARGUMENT_CHARS;

/// The nesting a program is parsed with on the caller's stack. A deeper program is parsed again
/// on a dedicated thread whose stack fits [`Limits::nesting`] (see [`MAX_NESTING`]). The block
/// editor parses with this limit, so its recursive conversions stay on an ordinary stack.
pub const HARD_NESTING_CEILING: usize = 128;

/// The deepest nesting any configuration may allow, and the default.
///
/// The reference has no limit of its own: it fails where V8's call stack ends. Measured with
/// Node 24's default stack (`node:24-alpine`, the production image), it parses at most 11,264
/// nested unary operators (the cheapest nesting, one frame per level), 5,632 parentheses,
/// 7,673 ternary branches and 2,048 nested arrays, and it evaluates far less of most of them
/// (767 unary operators). This is above all of those, so nothing the reference can parse is
/// refused for its depth, and it is above the depth of any text within the source limit
/// (every level of nesting needs at least one character). A program this deep is parsed on a
/// thread with a stack sized for it, and its tree is freed without recursion.
pub const MAX_NESTING: usize = 16_384;

/// Exclusive ceiling for the persisted JSON shape's container depth: `serde_json` refuses to
/// enter its 128th container. Parsing does not apply it (the reference never stores a tree); a
/// caller that stores a tree as JSON checks it with [`CompiledProgram::check_json_depth`].
pub const HARD_JSON_NESTING_CEILING: usize = 128;

/// Tokens a program can have per byte of its text, at most: a token starts at a byte no other
/// token of the same program starts at (an array's items and a template's interpolations lie
/// after the `%[` or `"` that starts it), so a program never has more tokens than bytes.
pub const TOKENS_PER_INPUT_BYTE: usize = 1;

/// AST nodes a program can make per byte of its text, at most. Every node is made for a token
/// or for an empty part next to one, and the most a single token makes is three: a `?` whose
/// branches are both empty (`*(1?)` makes the ternary and two empty literals). The robustness
/// tests check the bound on random and adversarial input.
pub const NODES_PER_INPUT_BYTE: usize = 3;

/// Added to the derived token and node budgets: the root of a program and the empty literal
/// of an empty one have no byte of their own.
pub const BUDGET_BASE: usize = 64;

/// Bytes the lexer may visit per byte of a program's text (nested arrays and quoted templates
/// are visited once per enclosing level) for programs longer than [`WORK_BASE`] allows.
pub const WORK_PER_INPUT_BYTE: usize = 32;

/// The work budget of every program, however short. Quoted templates nested in each other are
/// lexed once per level, like the reference re-tokenizes them, which is quadratic in the depth:
/// the worst text within the 10,000-character source limit (about 950 levels around 4,300 emoji)
/// visits about 19 million bytes; this is 64 Mi. Longer, substituted text gets
/// [`WORK_PER_INPUT_BYTE`] per byte, so the work stays linear in the input.
pub const WORK_BASE: usize = 1 << 26;

impl Default for Limits {
    fn default() -> Self {
        Self {
            source_chars: MAX_SOURCE_CHARS,
            input_chars: MAX_INPUT_CHARS,
            tokens: usize::MAX,
            nodes: usize::MAX,
            nesting: MAX_NESTING,
        }
    }
}

/// Work counters of one compilation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ParseStats {
    /// Tokens emitted, nested items and interpolations included.
    pub tokens: usize,
    /// AST nodes built, discarded empty and error-path nodes included.
    pub nodes: usize,
    /// Array layouts indexed.
    pub arrays: usize,
    /// Bytes visited by array index passes (nested arrays are not counted again).
    pub array_indexed_bytes: usize,
    /// Bytes consumed by the lexer (an array token counts its `%[` and `]` as three).
    pub lexed_bytes: usize,
}

impl ParseStats {
    pub(crate) fn plus(self, other: Self) -> Self {
        Self {
            tokens: self.tokens + other.tokens,
            nodes: self.nodes + other.nodes,
            arrays: self.arrays + other.arrays,
            array_indexed_bytes: self.array_indexed_bytes + other.array_indexed_bytes,
            lexed_bytes: self.lexed_bytes + other.lexed_bytes,
        }
    }
}

/// A parsed program and the source it came from. Cloning it shares the tree; dropping the
/// last clone frees the tree without recursion, however deep it is ([`MAX_NESTING`]).
#[derive(Clone, Debug)]
pub struct CompiledProgram {
    pub(crate) source: Arc<str>,
    pub(crate) span: Span,
    pub(crate) root: Arc<AstNode>,
    pub(crate) stats: ParseStats,
}

impl Drop for CompiledProgram {
    fn drop(&mut self) {
        if let Some(root) = Arc::get_mut(&mut self.root) {
            free(std::mem::replace(
                root,
                AstNode::Root {
                    children: Vec::new(),
                },
            ));
        }
    }
}

/// Frees a tree node by node: each node is dropped after its children were moved out.
fn free(node: AstNode) {
    fn index(accessor: Option<ArrayAccessor>) -> Option<AstNode> {
        match accessor? {
            ArrayAccessor::Index { index }
            | ArrayAccessor::SetIndex { index }
            | ArrayAccessor::Remove { index } => Some(*index),
            _ => None,
        }
    }
    let mut pending = vec![node];
    while let Some(node) = pending.pop() {
        match node {
            AstNode::Root { children }
            | AstNode::Function { args: children, .. }
            | AstNode::CommandRef { args: children, .. } => pending.extend(children),
            AstNode::SetVar {
                value,
                accessor,
                user_selector,
                ..
            } => {
                pending.push(*value);
                pending.extend(index(accessor));
                pending.extend(user_selector.map(|node| *node));
            }
            AstNode::GetVar {
                accessor,
                user_selector,
                ..
            }
            | AstNode::Exists {
                accessor,
                user_selector,
                ..
            }
            | AstNode::DeleteVar {
                accessor,
                user_selector,
                ..
            } => {
                pending.extend(index(accessor));
                pending.extend(user_selector.map(|node| *node));
            }
            AstNode::Binary { left, right, .. } => pending.extend([*left, *right]),
            AstNode::Unary { argument, .. } => pending.push(*argument),
            AstNode::Ternary {
                test,
                consequent,
                alternate,
            } => pending.extend([*test, *consequent, *alternate]),
            AstNode::Template { segments } => {
                pending.extend(segments.into_iter().filter_map(|segment| match segment {
                    TemplateSegment::Expr { node } => Some(node),
                    TemplateSegment::Text { .. } => None,
                }));
            }
            AstNode::ArrayLiteral { items, accessor } => {
                pending.extend(items);
                pending.extend(index(accessor));
            }
            AstNode::LoopAssign { value, .. } => pending.extend(value.map(|node| *node)),
            AstNode::ForLoop {
                init,
                condition,
                update,
                iterable,
                body,
                ..
            } => {
                pending.extend(
                    [init, condition, update, iterable]
                        .into_iter()
                        .flatten()
                        .map(|node| *node),
                );
                pending.extend(body);
            }
            AstNode::Literal { .. } | AstNode::LoopVar { .. } | AstNode::Custom { .. } => {}
        }
    }
}

impl CompiledProgram {
    /// The program's source text.
    pub fn source(&self) -> &str {
        self.source
            .get(self.span.start..self.span.end)
            .unwrap_or_default()
    }

    /// Where the program sits in the text that was compiled (a template segment's span).
    pub fn span(&self) -> Span {
        self.span
    }

    /// The `root` node.
    pub fn root(&self) -> &AstNode {
        &self.root
    }

    /// The root's children.
    pub fn children(&self) -> &[AstNode] {
        match &*self.root {
            AstNode::Root { children } => children,
            _ => &[],
        }
    }

    /// The AST as JSON. Serializing recurses: a caller with a deep tree (above
    /// [`HARD_NESTING_CEILING`]) checks [`Self::check_json_depth`] first.
    pub fn to_value(&self) -> Value {
        self.root.to_value()
    }

    /// Whether the tree's JSON shape stays below [`HARD_JSON_NESTING_CEILING`], for a caller that
    /// stores it and reads it back with `serde_json` (counted without recursion).
    pub fn check_json_depth(&self) -> Result<(), Diagnostic> {
        super::persistence::validate(&self.root, self.span)
    }

    /// Work counters.
    pub fn stats(&self) -> ParseStats {
        self.stats
    }
}

/// One segment of a compiled template and what the renderer does with it.
#[derive(Clone, Debug)]
pub struct SegmentPlan {
    pub(crate) segment: SourceSegment,
    pub(crate) step: SegmentStep,
}

/// What the renderer does with a segment.
#[derive(Clone, Debug)]
pub enum SegmentStep {
    /// Copy the text.
    Text,
    /// Evaluate the program.
    Program(CompiledProgram),
    /// Write `[Parse error: {message}]` and go on.
    ParseError(Diagnostic),
    /// Write `[Parse error: Unclosed expression]` and stop.
    Unclosed(Diagnostic),
}

impl SegmentPlan {
    /// The segment.
    pub fn segment(&self) -> SourceSegment {
        self.segment
    }

    /// What to do with it.
    pub fn step(&self) -> &SegmentStep {
        &self.step
    }
}
