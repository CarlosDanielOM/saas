use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, sync::Arc};

pub const BLOCKS_VERSION: u8 = 1;
pub const MAX_BLOCK_NODES: usize = 7_500;
pub const MAX_BLOCK_DEPTH: usize = 48;
pub const MAX_COMMAND_TEXT: usize = 10_000;

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name { $(#[serde(rename = $text)] $variant),+ }
        impl $name {
            pub fn as_str(self) -> &'static str { match self { $(Self::$variant => $text),+ } }
            pub(crate) fn parse(text: &str) -> Option<Self> { match text { $($text => Some(Self::$variant)),+, _ => None } }
        }
    };
}
string_enum!(BlockStorage { Memory => "memory", Cache => "cache", CacheUser => "cacheUser", Db => "db", DbUser => "dbUser" });
impl BlockStorage {
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Memory => "",
            Self::Cache => "#",
            Self::CacheUser => "##",
            Self::Db => "*",
            Self::DbUser => "**",
        }
    }
    pub(crate) fn user_scoped(self) -> bool {
        matches!(self, Self::CacheUser | Self::DbUser)
    }
}
string_enum!(BlockBinaryOp { Add => "+", Subtract => "-", Multiply => "*", Divide => "/", Modulo => "%", Equal => "==", NotEqual => "!=", GreaterEqual => ">=", LessEqual => "<=", Greater => ">", Less => "<", Assign => "=", Match => "~=", AlternateNotEqual => "<>" });
string_enum!(BlockUnaryOp { Plus => "+", Minus => "-" });
string_enum!(BlockLoopAssignOp { Assign => "=", Add => "+=", Subtract => "-=", Multiply => "*=", Divide => "/=", Modulo => "%=", Increment => "++", Decrement => "--" });
impl BlockLoopAssignOp {
    pub(crate) fn increment(self) -> bool {
        matches!(self, Self::Increment | Self::Decrement)
    }
}
string_enum!(BlockLoopMode { Range => "range", Foreach => "foreach" });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BlockAccessor {
    Array,
    Append,
    Random,
    Length,
    Clear,
    Index { index: Box<BlockNode> },
    SetIndex { index: Box<BlockNode> },
    Remove { index: Box<BlockNode> },
}
impl BlockAccessor {
    pub(crate) fn index(&self) -> Option<&BlockNode> {
        match self {
            Self::Index { index } | Self::SetIndex { index } | Self::Remove { index } => {
                Some(index)
            }
            _ => None,
        }
    }
    pub(crate) fn index_mut(&mut self) -> Option<&mut BlockNode> {
        match self {
            Self::Index { index } | Self::SetIndex { index } | Self::Remove { index } => {
                Some(index)
            }
            _ => None,
        }
    }
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Array => "array",
            Self::Append => "append",
            Self::Random => "random",
            Self::Length => "length",
            Self::Clear => "clear",
            Self::Index { .. } => "index",
            Self::SetIndex { .. } => "setIndex",
            Self::Remove { .. } => "remove",
        }
    }
}

/// Linked provenance shares prefixes. JSON pointers are allocated only for errors.
#[derive(Clone, Debug, Default)]
pub(crate) struct Origin(Option<Arc<OriginLink>>);
#[derive(Debug)]
struct OriginLink {
    parent: Origin,
    slot: String,
}
impl Origin {
    pub(crate) fn child(&self, slot: impl Into<String>) -> Self {
        Self(Some(Arc::new(OriginLink {
            parent: self.clone(),
            slot: slot.into(),
        })))
    }
    pub(crate) fn source_index(&self) -> Option<usize> {
        let mut cursor = self;
        while let Some(link) = &cursor.0 {
            if let Some(parent) = &link.parent.0
                && parent.slot == "children"
                && parent.parent.0.is_none()
            {
                return link.slot.parse().ok();
            }
            cursor = &link.parent;
        }
        None
    }
    pub(crate) fn pointer(&self) -> String {
        let mut slots = Vec::new();
        let mut cursor = self;
        while let Some(link) = &cursor.0 {
            slots.push(link.slot.as_str());
            cursor = &link.parent;
        }
        let mut out = String::new();
        for slot in slots.into_iter().rev() {
            out.push('/');
            out.push_str(&slot.replace('~', "~0").replace('/', "~1"));
        }
        out
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockNode {
    pub id: String,
    #[serde(flatten)]
    pub kind: BlockKind,
    #[serde(skip)]
    pub(crate) origin: Origin,
    #[serde(skip)]
    pub(crate) diagnostic_id: Option<String>,
    #[serde(skip)]
    pub(crate) text_pieces: Vec<TextPiece>,
}
impl BlockNode {
    pub fn new(id: impl Into<String>, kind: BlockKind) -> Self {
        Self {
            id: id.into(),
            kind,
            origin: Origin::default(),
            diagnostic_id: None,
            text_pieces: Vec::new(),
        }
    }
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("block fields are JSON representable")
    }
    pub(crate) fn error(
        &self,
        code: BlocksErrorCode,
        message: impl Into<String>,
        field: Option<&str>,
    ) -> BlocksError {
        BlocksError::at(
            code,
            message,
            Some(self.diagnostic_id.as_ref().unwrap_or(&self.id).clone()),
            &field.map_or_else(|| self.origin.clone(), |f| self.origin.child(f)),
        )
    }
}
#[derive(Clone, Debug)]
pub(crate) struct TextPiece {
    pub start: usize,
    pub end: usize,
    pub id: String,
    pub origin: Origin,
}
impl BlockNode {
    pub(crate) fn pieces(&self, length: usize) -> Vec<TextPiece> {
        if !self.text_pieces.is_empty() {
            return self.text_pieces.clone();
        }
        vec![TextPiece {
            start: 0,
            end: length,
            id: self.diagnostic_id.as_ref().unwrap_or(&self.id).clone(),
            origin: self.origin.clone(),
        }]
    }
    pub(crate) fn text_origin(&self, offset: usize) -> Option<&TextPiece> {
        let at = self
            .text_pieces
            .partition_point(|piece| piece.start <= offset);
        self.text_pieces[..at]
            .iter()
            .rev()
            .find(|piece| offset < piece.end)
    }
    pub(crate) fn text_error(
        &self,
        code: BlocksErrorCode,
        message: impl Into<String>,
        offset: usize,
    ) -> BlocksError {
        if let Some(piece) = self.text_origin(offset) {
            return BlocksError::at(
                code,
                message,
                Some(piece.id.clone()),
                &piece.origin.child("value"),
            );
        }
        self.error(code, message, Some("value"))
    }
}
/// Structural equality deliberately excludes editor IDs and transient provenance.
impl PartialEq for BlockNode {
    fn eq(&self, other: &Self) -> bool {
        self.kind == other.kind
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BlockKind {
    Literal {
        value: String,
    },
    Raw {
        source: String,
    },
    Function {
        name: String,
        args: Vec<BlockNode>,
    },
    CommandRef {
        #[serde(rename = "commandName")]
        command_name: String,
        args: Vec<BlockNode>,
    },
    GetVar {
        name: String,
        storage: BlockStorage,
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<BlockAccessor>,
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<BlockNode>>,
    },
    SetVar {
        name: String,
        storage: BlockStorage,
        value: Box<BlockNode>,
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<BlockAccessor>,
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<BlockNode>>,
    },
    Exists {
        name: String,
        storage: BlockStorage,
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<BlockAccessor>,
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<BlockNode>>,
    },
    DeleteVar {
        name: String,
        storage: BlockStorage,
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<BlockAccessor>,
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<BlockNode>>,
    },
    Binary {
        operator: BlockBinaryOp,
        left: Box<BlockNode>,
        right: Box<BlockNode>,
    },
    Unary {
        operator: BlockUnaryOp,
        argument: Box<BlockNode>,
    },
    Ternary {
        test: Box<BlockNode>,
        consequent: Box<BlockNode>,
        alternate: Box<BlockNode>,
    },
    Template {
        parts: Vec<BlockNode>,
    },
    ArrayLiteral {
        items: Vec<BlockNode>,
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<BlockAccessor>,
    },
    LoopVar {
        name: String,
    },
    LoopAssign {
        name: String,
        operator: BlockLoopAssignOp,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Box<BlockNode>>,
    },
    ForLoop {
        #[serde(rename = "loopVar")]
        loop_var: String,
        mode: BlockLoopMode,
        #[serde(skip_serializing_if = "Option::is_none")]
        init: Option<Box<BlockNode>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        condition: Option<Box<BlockNode>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        update: Option<Box<BlockNode>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        iterable: Option<Box<BlockNode>>,
        body: Vec<BlockNode>,
    },
    Group {
        children: Vec<BlockNode>,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RootTag {
    #[serde(rename = "root")]
    Root,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockRoot {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: RootTag,
    pub children: Vec<BlockNode>,
}
impl BlockRoot {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("block fields are JSON representable")
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredBlocks {
    pub v: u8,
    pub root: BlockRoot,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct BlocksStats {
    pub parse_calls: usize,
    pub cache_hits: usize,
    pub structural_comparisons: usize,
    pub retained_output_units: usize,
    pub output_units: usize,
    pub syntax_nodes_charged: usize,
    pub syntax_tokens_charged: usize,
    pub syntax_source_units_charged: usize,
    pub validated_nodes: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompiledBlocks {
    pub root: BlockRoot,
    pub text: String,
    pub stats: BlocksStats,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportedText {
    pub root: BlockRoot,
    #[serde(rename = "advancedCount")]
    pub advanced_count: usize,
    pub stats: BlocksStats,
    pub diagnostics: Vec<BlocksError>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlocksErrorCode {
    BrokenRoot,
    BrokenBlock,
    DepthLimit,
    NodeLimit,
    MissingField,
    StringLimit,
    BrokenList,
    InvalidStorage,
    InvalidName,
    InvalidAccessor,
    InvalidOperator,
    InvalidMode,
    UnknownType,
    RawNotTopLevel,
    EmptyRoot,
    OutputLimit,
    TextLimit,
    RoundTripMismatch,
    LiteralEscape,
    InvalidRaw,
    SyntaxLimit,
    InvalidNamespace,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlocksError {
    pub code: BlocksErrorCode,
    pub message: String,
    #[serde(rename = "blockId", skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    pub path: String,
}
impl BlocksError {
    pub(crate) fn at(
        code: BlocksErrorCode,
        message: impl Into<String>,
        block_id: Option<String>,
        origin: &Origin,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            block_id,
            path: origin.pointer(),
        }
    }
}
impl fmt::Display for BlocksError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for BlocksError {}
