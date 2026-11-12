use crate::syntax::{BinaryOp, LoopAssignOp, LoopMode, UnaryOp, VariableStorage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// `commands.blocks.v`.
pub const BLOCKS_VERSION: u8 = 1;
/// Most blocks in one tree, the root excluded.
pub const MAX_BLOCK_NODES: usize = 4_000;
/// Deepest block nesting; root children are at depth 1.
pub const MAX_BLOCK_DEPTH: usize = 48;
/// Longest command text the website saves (text or compiled blocks), in characters.
pub const MAX_COMMAND_TEXT: usize = 10_000;

/// One block: an editor id and what it is. The JSON shape is the reference's
/// (`{ "id": …, "type": …, …fields }`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BlockNode {
    /// Editor id (`[\w-]{1,64}` after reading).
    pub id: String,
    /// The block.
    #[serde(flatten)]
    pub kind: BlockKind,
}

impl BlockNode {
    /// A block.
    pub fn new(id: impl Into<String>, kind: BlockKind) -> Self {
        Self {
            id: id.into(),
            kind,
        }
    }

    /// A text block.
    pub fn literal(id: impl Into<String>, value: impl Into<String>) -> Self {
        Self::new(
            id,
            BlockKind::Literal {
                value: value.into(),
            },
        )
    }

    /// The block as JSON.
    pub fn to_value(&self) -> Value {
        // Strings, arrays and objects only.
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    pub(crate) fn error(&self, message: impl Into<String>) -> BlocksError {
        BlocksError::new(message, Some(self.id.clone()))
    }
}

/// The block kinds (`BlockNode` in `ast_blocks/types.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BlockKind {
    /// Text: chat text at the top level, a value elsewhere.
    Literal {
        /// The text.
        value: String,
    },
    /// An expression blocks cannot show, kept byte for byte (top level only).
    Raw {
        /// Its exact source.
        source: String,
    },
    /// `$(name args…)`.
    Function {
        /// Dotted name.
        name: String,
        /// Arguments.
        args: Vec<BlockNode>,
    },
    /// `#(command args…)`.
    CommandRef {
        /// The command, without `!`.
        #[serde(rename = "commandName")]
        command_name: String,
        /// Arguments.
        args: Vec<BlockNode>,
    },
    /// Read a variable.
    GetVar {
        /// Name without the storage prefix.
        name: String,
        /// Where it lives.
        storage: VariableStorage,
        /// `array`, `index`, `random` or `length`.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<BlockAccessor>,
        /// Per-viewer selector.
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<BlockNode>>,
    },
    /// Write a variable.
    SetVar {
        /// Name without the storage prefix.
        name: String,
        /// Where it lives.
        storage: VariableStorage,
        /// The value.
        value: Box<BlockNode>,
        /// `append` or `setIndex`.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<BlockAccessor>,
        /// Per-viewer selector.
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<BlockNode>>,
    },
    /// Does a variable exist.
    Exists {
        /// Name without the storage prefix.
        name: String,
        /// Where it lives.
        storage: VariableStorage,
        /// `array`, `index`, `random` or `length`.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<BlockAccessor>,
        /// Per-viewer selector.
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<BlockNode>>,
    },
    /// Delete a variable.
    DeleteVar {
        /// Name without the storage prefix.
        name: String,
        /// Where it lives.
        storage: VariableStorage,
        /// `clear` or `remove`.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<BlockAccessor>,
        /// Per-viewer selector.
        #[serde(rename = "userSelector", skip_serializing_if = "Option::is_none")]
        user_selector: Option<Box<BlockNode>>,
    },
    /// A check or math.
    Binary {
        /// The sign.
        operator: BinaryOp,
        /// Left side.
        left: Box<BlockNode>,
        /// Right side.
        right: Box<BlockNode>,
    },
    /// `+x`, `-x`.
    Unary {
        /// The sign.
        operator: UnaryOp,
        /// The value.
        argument: Box<BlockNode>,
    },
    /// If / else.
    Ternary {
        /// The check.
        test: Box<BlockNode>,
        /// When true.
        consequent: Box<BlockNode>,
        /// When false.
        alternate: Box<BlockNode>,
    },
    /// Quoted text with `${…}` pieces.
    Template {
        /// The pieces.
        parts: Vec<BlockNode>,
    },
    /// `%[…]`.
    ArrayLiteral {
        /// The items.
        items: Vec<BlockNode>,
        /// `index`, `random` or `length`.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessor: Option<BlockAccessor>,
    },
    /// A loop counter.
    LoopVar {
        /// Its name.
        name: String,
    },
    /// Change a loop counter.
    LoopAssign {
        /// Its name.
        name: String,
        /// How.
        operator: LoopAssignOp,
        /// The value (none for `++` and `--`).
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Box<BlockNode>>,
    },
    /// A repeat.
    ForLoop {
        /// The counter's name.
        #[serde(rename = "loopVar")]
        loop_var: String,
        /// Range or foreach.
        mode: LoopMode,
        /// Range start.
        #[serde(skip_serializing_if = "Option::is_none")]
        init: Option<Box<BlockNode>>,
        /// Range condition.
        #[serde(skip_serializing_if = "Option::is_none")]
        condition: Option<Box<BlockNode>>,
        /// Range step.
        #[serde(skip_serializing_if = "Option::is_none")]
        update: Option<Box<BlockNode>>,
        /// Foreach list.
        #[serde(skip_serializing_if = "Option::is_none")]
        iterable: Option<Box<BlockNode>>,
        /// The body.
        body: Vec<BlockNode>,
    },
    /// Editor convenience: several blocks used as one value; saved as a template.
    Group {
        /// The blocks.
        children: Vec<BlockNode>,
    },
}

/// List access.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BlockAccessor {
    /// The whole list.
    Array,
    /// Add to the end.
    Append,
    /// A random item.
    Random,
    /// The length.
    Length,
    /// Empty the list.
    Clear,
    /// The item at a position.
    Index {
        /// The position.
        index: Box<BlockNode>,
    },
    /// Replace the item at a position.
    SetIndex {
        /// The position.
        index: Box<BlockNode>,
    },
    /// Remove the item at a position.
    Remove {
        /// The position.
        index: Box<BlockNode>,
    },
}

impl BlockAccessor {
    /// The `type` name.
    pub fn name(&self) -> &'static str {
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

/// The `type` tag of a root.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum RootTag {
    /// `"root"`.
    #[default]
    #[serde(rename = "root")]
    Root,
}

/// A block tree. Root children are what the bot's renderer sees.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BlockRoot {
    /// Editor id.
    pub id: String,
    /// Always `root`.
    #[serde(rename = "type")]
    pub tag: RootTag,
    /// The top-level blocks.
    pub children: Vec<BlockNode>,
}

impl BlockRoot {
    /// A root.
    pub fn new(id: impl Into<String>, children: Vec<BlockNode>) -> Self {
        Self {
            id: id.into(),
            tag: RootTag::Root,
            children,
        }
    }

    /// The tree as JSON.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Stored on the command document (`commands.blocks`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredBlocks {
    /// [`BLOCKS_VERSION`].
    pub v: u8,
    /// The tree.
    pub root: BlockRoot,
}

/// `compileBlocks`' result.
#[derive(Clone, Debug, PartialEq)]
pub struct CompiledBlocks {
    /// The normalized tree to store and send back to the editor.
    pub root: BlockRoot,
    /// The command text the bot runs (`commands.message`).
    pub text: String,
}

/// `importCommandText`'s result.
#[derive(Clone, Debug, PartialEq)]
pub struct ImportedText {
    /// The tree.
    pub root: BlockRoot,
    /// Expressions kept as advanced pieces because blocks cannot show them.
    pub advanced_count: usize,
}

/// A save or import problem the editor can point at (the API sends `message` and `blockId`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlocksError {
    /// Shown to the streamer.
    pub message: String,
    /// The block to highlight, when there is one.
    pub block_id: Option<String>,
}

impl BlocksError {
    pub(crate) fn new(message: impl Into<String>, block_id: Option<String>) -> Self {
        Self {
            message: message.into(),
            block_id,
        }
    }

    pub(crate) fn plain(message: impl Into<String>) -> Self {
        Self::new(message, None)
    }
}

impl fmt::Display for BlocksError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BlocksError {}
