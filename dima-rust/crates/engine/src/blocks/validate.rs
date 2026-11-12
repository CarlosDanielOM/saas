//! `readBlockRoot` (`ast_blocks/validate.ts`): checks an untrusted block tree from the browser
//! and returns a typed copy. Unknown fields are dropped; missing or duplicate ids are replaced.
//!
//! Every check runs in the reference's order, so the first error and the repaired ids are the
//! same. String limits count characters (the reference counts UTF-16 units).

use super::{BlockAccessor, BlockKind, BlockNode, BlockRoot, BlocksError, MAX_BLOCK_DEPTH};
use super::{MAX_BLOCK_NODES, MAX_COMMAND_TEXT, names};
use crate::syntax::{BinaryOp, LoopAssignOp, LoopMode, UnaryOp, VariableStorage};
use serde_json::{Map, Value};
use std::collections::HashSet;

type Object = Map<String, Value>;

/// The accessors each block kind accepts.
const READ_ACCESSORS: &[&str] = &["array", "index", "random", "length"];
const DELETE_ACCESSORS: &[&str] = &["clear", "remove"];
const SET_ACCESSORS: &[&str] = &["append", "setIndex"];
const ARRAY_ACCESSORS: &[&str] = &["index", "random", "length"];

/// Reads and checks a block tree.
pub fn read_block_root(input: &Value) -> Result<BlockRoot, BlocksError> {
    let Some(object) = input.as_object() else {
        return Err(broken_tree());
    };
    let Some(children) = object.get("children").and_then(Value::as_array) else {
        return Err(broken_tree());
    };
    if object.get("type").and_then(Value::as_str) != Some("root") {
        return Err(broken_tree());
    }
    let mut reader = Reader {
        nodes: 0,
        ids: HashSet::new(),
        seq: 0,
    };
    let id = reader.fresh_id(object.get("id"));
    let children = children
        .iter()
        .map(|item| reader.node(item, 1, true))
        .collect::<Result<_, _>>()?;
    Ok(BlockRoot::new(id, children))
}

fn broken_tree() -> BlocksError {
    BlocksError::plain("The block tree is missing or broken.")
}

struct Reader {
    nodes: usize,
    ids: HashSet<String>,
    seq: u64,
}

/// The fields of one block while it is read.
struct Fields<'a> {
    value: &'a Object,
    id: String,
    depth: usize,
}

impl Fields<'_> {
    fn get(&self, key: &str) -> Option<&Value> {
        self.value.get(key).filter(|value| !value.is_null())
    }

    fn error(&self, message: impl Into<String>) -> BlocksError {
        BlocksError::new(message, Some(self.id.clone()))
    }

    /// `str(value, label, id, max)`: a string of at most `max` characters.
    fn string(&self, key: &str, label: &str, max: usize) -> Result<String, BlocksError> {
        let Some(text) = self.value.get(key).and_then(Value::as_str) else {
            return Err(self.error(format!("{label} is missing.")));
        };
        too_long(text, max, || self.error(format!("{label} is too long.")))?;
        Ok(text.to_owned())
    }

    fn storage(&self) -> Result<VariableStorage, BlocksError> {
        self.value
            .get("storage")
            .and_then(Value::as_str)
            .and_then(VariableStorage::parse)
            .ok_or_else(|| self.error("Pick how long the variable is kept."))
    }

    fn var_name(&self) -> Result<String, BlocksError> {
        let name = self.string("name", "The variable name", 64)?;
        if !names::var_name(&name) {
            return Err(self.error("Variable names use only letters, numbers and _."));
        }
        Ok(name)
    }

    fn counter_name(&self, key: &str) -> Result<String, BlocksError> {
        let name = self.string(key, "The counter name", 32)?;
        if !names::loop_name(&name) {
            return Err(self.error("Counter names start with a letter."));
        }
        Ok(name)
    }
}

/// `value.length > max`, in characters.
fn too_long(
    text: &str,
    max: usize,
    error: impl FnOnce() -> BlocksError,
) -> Result<(), BlocksError> {
    // A character is at least one byte: short strings need no count.
    if text.len() > max && dima_text::char_len(text) > max {
        return Err(error());
    }
    Ok(())
}

impl Reader {
    fn fresh_id(&mut self, candidate: Option<&Value>) -> String {
        if let Some(candidate) = candidate.and_then(Value::as_str)
            && names::block_id(candidate)
            && !self.ids.contains(candidate)
        {
            self.ids.insert(candidate.to_owned());
            return candidate.to_owned();
        }
        loop {
            self.seq += 1;
            let id = format!("s{}", names::base36(self.seq));
            if self.ids.insert(id.clone()) {
                return id;
            }
        }
    }

    fn node(&mut self, value: &Value, depth: usize, at_root: bool) -> Result<BlockNode, BlocksError> {
        let Some(object) = value.as_object() else {
            return Err(BlocksError::plain("A block is broken."));
        };
        let Some(kind) = object.get("type").and_then(Value::as_str) else {
            return Err(BlocksError::plain("A block is broken."));
        };
        if depth > MAX_BLOCK_DEPTH {
            return Err(BlocksError::plain("Blocks are nested too deeply."));
        }
        self.nodes += 1;
        if self.nodes > MAX_BLOCK_NODES {
            return Err(BlocksError::plain(format!(
                "Too many blocks (limit {MAX_BLOCK_NODES})."
            )));
        }
        let id = self.fresh_id(object.get("id"));
        let f = Fields {
            value: object,
            id,
            depth,
        };
        let kind = self.kind(&f, kind, at_root)?;
        Ok(BlockNode::new(f.id, kind))
    }

    /// `child(slot, label, optional)` for a required slot.
    fn child(&mut self, f: &Fields<'_>, key: &str, label: &str) -> Result<Box<BlockNode>, BlocksError> {
        match f.get(key) {
            Some(slot) => Ok(Box::new(self.node(slot, f.depth + 1, false)?)),
            None => Err(f.error(format!("Fill in {label}."))),
        }
    }

    fn optional(&mut self, f: &Fields<'_>, key: &str) -> Result<Option<Box<BlockNode>>, BlocksError> {
        f.get(key)
            .map(|slot| self.node(slot, f.depth + 1, false).map(Box::new))
            .transpose()
    }

    fn list(&mut self, f: &Fields<'_>, key: &str) -> Result<Vec<BlockNode>, BlocksError> {
        let Some(slot) = f.get(key) else {
            return Ok(Vec::new());
        };
        let Some(items) = slot.as_array() else {
            return Err(f.error("A block list is broken."));
        };
        items
            .iter()
            .map(|item| self.node(item, f.depth + 1, false))
            .collect()
    }

    /// A user selector is read only for per-viewer storage; elsewhere it is dropped unread.
    fn selector(
        &mut self,
        f: &Fields<'_>,
        storage: VariableStorage,
    ) -> Result<Option<Box<BlockNode>>, BlocksError> {
        if !storage.is_user_scoped() {
            return Ok(None);
        }
        self.optional(f, "userSelector")
    }

    fn accessor(
        &mut self,
        f: &Fields<'_>,
        allowed: &[&str],
    ) -> Result<Option<BlockAccessor>, BlocksError> {
        let Some(raw) = f.get("accessor") else {
            return Ok(None);
        };
        let kind = raw
            .as_object()
            .and_then(|o| o.get("type"))
            .and_then(Value::as_str)
            .filter(|kind| allowed.contains(kind));
        let (Some(object), Some(kind)) = (raw.as_object(), kind) else {
            return Err(f.error("This list option is not available here."));
        };
        let mut index = || -> Result<Box<BlockNode>, BlocksError> {
            match object.get("index").filter(|v| !v.is_null()) {
                Some(index) => Ok(Box::new(self.node(index, f.depth + 1, false)?)),
                None => Err(f.error("Fill in the list position.")),
            }
        };
        Ok(Some(match kind {
            "index" => BlockAccessor::Index { index: index()? },
            "setIndex" => BlockAccessor::SetIndex { index: index()? },
            "remove" => BlockAccessor::Remove { index: index()? },
            "array" => BlockAccessor::Array,
            "append" => BlockAccessor::Append,
            "random" => BlockAccessor::Random,
            "length" => BlockAccessor::Length,
            _ => BlockAccessor::Clear,
        }))
    }

    fn empty_literal(&mut self) -> Box<BlockNode> {
        Box::new(BlockNode::literal(self.fresh_id(None), ""))
    }

    fn kind(&mut self, f: &Fields<'_>, kind: &str, at_root: bool) -> Result<BlockKind, BlocksError> {
        Ok(match kind {
            "literal" => {
                // `value.value ?? ''`.
                let value = match f.get("value") {
                    None => String::new(),
                    Some(_) => f.string("value", "Text", MAX_COMMAND_TEXT)?,
                };
                BlockKind::Literal { value }
            }
            "raw" => {
                if !at_root {
                    return Err(f.error("Advanced pieces can only be used at the top level."));
                }
                BlockKind::Raw {
                    source: f.string("source", "The advanced piece", MAX_COMMAND_TEXT)?,
                }
            }
            "function" => {
                let name = f.string("name", "The function name", 80)?;
                if !names::function_name(&name) {
                    return Err(f.error("That function name is not valid."));
                }
                BlockKind::Function {
                    name,
                    args: self.list(f, "args")?,
                }
            }
            "commandRef" => {
                let written = f.string("commandName", "The command name", 60)?;
                let command_name = written.strip_prefix('!').unwrap_or(&written).to_owned();
                if !names::command_name(&command_name) {
                    return Err(f.error("Type the command to run, like so."));
                }
                BlockKind::CommandRef {
                    command_name,
                    args: self.list(f, "args")?,
                }
            }
            "getVar" | "exists" | "deleteVar" => {
                let storage = f.storage()?;
                let name = f.var_name()?;
                let allowed = if kind == "deleteVar" {
                    DELETE_ACCESSORS
                } else {
                    READ_ACCESSORS
                };
                let accessor = self.accessor(f, allowed)?;
                let user_selector = self.selector(f, storage)?;
                match kind {
                    "getVar" => BlockKind::GetVar {
                        name,
                        storage,
                        accessor,
                        user_selector,
                    },
                    "exists" => BlockKind::Exists {
                        name,
                        storage,
                        accessor,
                        user_selector,
                    },
                    _ => BlockKind::DeleteVar {
                        name,
                        storage,
                        accessor,
                        user_selector,
                    },
                }
            }
            "setVar" => {
                let storage = f.storage()?;
                let name = f.var_name()?;
                let value = self.child(f, "value", "the value to remember")?;
                let accessor = self.accessor(f, SET_ACCESSORS)?;
                let user_selector = self.selector(f, storage)?;
                BlockKind::SetVar {
                    name,
                    storage,
                    value,
                    accessor,
                    user_selector,
                }
            }
            "binary" => {
                let operator = f
                    .value
                    .get("operator")
                    .and_then(Value::as_str)
                    .and_then(BinaryOp::parse)
                    .ok_or_else(|| f.error("Pick a check or math sign."))?;
                BlockKind::Binary {
                    operator,
                    left: self.child(f, "left", "the left side")?,
                    right: self.child(f, "right", "the right side")?,
                }
            }
            "unary" => {
                let operator = f
                    .value
                    .get("operator")
                    .and_then(Value::as_str)
                    .and_then(UnaryOp::parse)
                    .ok_or_else(|| f.error("Pick + or \u{2212}."))?;
                BlockKind::Unary {
                    operator,
                    argument: self.child(f, "argument", "the value")?,
                }
            }
            "ternary" => {
                let test = self.child(f, "test", "the check")?;
                let consequent = match self.optional(f, "consequent")? {
                    Some(node) => node,
                    None => self.empty_literal(),
                };
                let alternate = match self.optional(f, "alternate")? {
                    Some(node) => node,
                    None => self.empty_literal(),
                };
                BlockKind::Ternary {
                    test,
                    consequent,
                    alternate,
                }
            }
            "template" => BlockKind::Template {
                parts: self.list(f, "parts")?,
            },
            "group" => BlockKind::Group {
                children: self.list(f, "children")?,
            },
            "arrayLiteral" => {
                let items = self.list(f, "items")?;
                BlockKind::ArrayLiteral {
                    items,
                    accessor: self.accessor(f, ARRAY_ACCESSORS)?,
                }
            }
            "loopVar" => BlockKind::LoopVar {
                name: f.counter_name("name")?,
            },
            "loopAssign" => {
                let name = f.counter_name("name")?;
                let operator = f
                    .value
                    .get("operator")
                    .and_then(Value::as_str)
                    .and_then(LoopAssignOp::parse)
                    .ok_or_else(|| f.error("Pick how the counter changes."))?;
                let value = if operator.takes_value() {
                    Some(self.child(f, "value", "the counter value")?)
                } else {
                    None
                };
                BlockKind::LoopAssign {
                    name,
                    operator,
                    value,
                }
            }
            "forLoop" => {
                let loop_var = f.counter_name("loopVar")?;
                let mode = f
                    .value
                    .get("mode")
                    .and_then(Value::as_str)
                    .and_then(LoopMode::parse)
                    .ok_or_else(|| f.error("Pick the kind of repeat."))?;
                match mode {
                    LoopMode::Foreach => {
                        let iterable = self.child(f, "iterable", "the list to go through")?;
                        BlockKind::ForLoop {
                            loop_var,
                            mode,
                            init: None,
                            condition: None,
                            update: None,
                            iterable: Some(iterable),
                            body: self.list(f, "body")?,
                        }
                    }
                    LoopMode::Range => {
                        let init = self.child(f, "init", "the start")?;
                        let condition = self.child(f, "condition", "when to stop")?;
                        let update = self.child(f, "update", "the step")?;
                        BlockKind::ForLoop {
                            loop_var,
                            mode,
                            init: Some(init),
                            condition: Some(condition),
                            update: Some(update),
                            iterable: None,
                            body: self.list(f, "body")?,
                        }
                    }
                }
            }
            other => {
                // `String(value.type).slice(0, 24)`: 24 characters here (row B10).
                return Err(f.error(format!(
                    "Unknown block type \u{201c}{}\u{201d}.",
                    dima_text::truncate_chars(other, 24)
                )));
            }
        })
    }
}
