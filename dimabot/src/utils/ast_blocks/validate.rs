use super::types::*;
use crate::utils::ast_syntax::PersistedJsString;
use regex::Regex;
use serde_json::{Map, Value};
use std::{collections::HashSet, sync::OnceLock};

pub(crate) fn units(value: &str) -> usize {
    value.encode_utf16().count()
}
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub(crate) fn base36(mut n: u64) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).expect("base36 is ASCII")
}
#[derive(Default)]
pub(crate) struct Ids {
    seen: HashSet<String>,
    seq: u64,
}
impl Ids {
    pub(crate) fn fresh(&mut self, candidate: Option<String>) -> String {
        if let Some(id) = candidate
            && valid_id(&id)
            && self.seen.insert(id.clone())
        {
            return id;
        }
        loop {
            self.seq += 1;
            let id = format!("s{}", base36(self.seq));
            if self.seen.insert(id.clone()) {
                return id;
            }
        }
    }
}
pub(crate) struct Rules {
    var: Regex,
    function: Regex,
    counter: Regex,
    bare: Regex,
}
impl Rules {
    fn new() -> Self {
        // JS anchors here are absolute (no multiline flag). Rust Unicode \w or
        // char::is_alphanumeric would include the wrong name categories.
        Self {
            var: Regex::new(r"\A[\p{L}\p{N}_]{1,64}\z").expect("constant regex"),
            function: Regex::new(r"\A[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\z")
                .expect("constant regex"),
            counter: Regex::new(r"\A[A-Za-z_][A-Za-z0-9_]{0,31}\z").expect("constant regex"),
            bare: Regex::new(r"\A[\p{L}\p{N}_@!&¡¿]+\z").expect("constant regex"),
        }
    }
    pub(crate) fn var_name(&self, s: &str) -> bool {
        self.var.is_match(s)
    }
    pub(crate) fn function_name(&self, s: &str) -> bool {
        self.function.is_match(s)
    }
    pub(crate) fn counter_name(&self, s: &str) -> bool {
        self.counter.is_match(s)
    }
    pub(crate) fn command_name(&self, s: &str) -> bool {
        !s.is_empty()
            && s.chars().all(|c| {
                !crate::utils::js_compat::is_whitespace(c) && !matches!(c, '(' | ')' | '"' | '\\')
            })
    }
    pub(crate) fn bare(&self, s: &str) -> bool {
        self.bare.is_match(s) && !matches!(s.to_ascii_lowercase().as_str(), "for" | "in" | "random")
    }
}
pub(crate) fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(Rules::new)
}
fn error(
    code: BlocksErrorCode,
    msg: impl Into<String>,
    id: Option<&str>,
    p: &Origin,
) -> BlocksError {
    BlocksError::at(code, msg, id.map(str::to_owned), p)
}
fn string(
    m: &mut Map<String, Value>,
    field: &str,
    label: &str,
    max: usize,
    default: bool,
    id: &str,
    p: &Origin,
) -> Result<String, BlocksError> {
    let v = m.remove(field).unwrap_or(Value::Null);
    let value = match v {
        Value::String(s) => s,
        Value::Null if default => String::new(),
        _ => {
            return Err(error(
                BlocksErrorCode::MissingField,
                format!("{label} is missing."),
                Some(id),
                &p.child(field),
            ));
        }
    };
    if units(&value) > max {
        return Err(error(
            BlocksErrorCode::StringLimit,
            format!("{label} is too long."),
            Some(id),
            &p.child(field),
        ));
    }
    Ok(value)
}
/// Read the additive version-2 code-unit array. Only integers in `u16` range
/// are accepted; a UTF-8 string or a lossy replacement is never inferred.
fn persisted_string(
    m: &mut Map<String, Value>,
    field: &str,
    label: &str,
    max: usize,
    id: &str,
    p: &Origin,
) -> Result<PersistedJsString, BlocksError> {
    let value = m.remove(field).unwrap_or(Value::Null);
    let value = serde_json::from_value::<PersistedJsString>(value).map_err(|_| {
        error(
            BlocksErrorCode::InvalidUtf16,
            format!("{label} is not a valid UTF-16 code unit list."),
            Some(id),
            &p.child(field),
        )
    })?;
    if value.0.len() > max {
        return Err(error(
            BlocksErrorCode::StringLimit,
            format!("{label} is too long."),
            Some(id),
            &p.child(field),
        ));
    }
    Ok(value)
}

pub(crate) struct Reader {
    pub nodes: usize,
    ids: Ids,
    rules: &'static Rules,
}
impl Reader {
    pub(crate) fn new() -> Self {
        Self {
            nodes: 0,
            ids: Ids::default(),
            rules: rules(),
        }
    }
    pub(crate) fn root(&mut self, input: Value) -> Result<BlockRoot, BlocksError> {
        let p = Origin::default();
        let Value::Object(mut m) = input else {
            return Err(error(
                BlocksErrorCode::BrokenRoot,
                "The block tree is missing or broken.",
                None,
                &p,
            ));
        };
        if m.get("type").and_then(Value::as_str) != Some("root")
            || !m.get("children").is_some_and(Value::is_array)
        {
            return Err(error(
                BlocksErrorCode::BrokenRoot,
                "The block tree is missing or broken.",
                None,
                &p,
            ));
        }
        let id = self.ids.fresh(m.remove("id").and_then(|v| {
            if let Value::String(s) = v {
                Some(s)
            } else {
                None
            }
        }));
        let children = self.list(&mut m, "children", 0, true, &id, &p)?;
        Ok(BlockRoot {
            id,
            kind: RootTag::Root,
            children,
        })
    }
    fn quota(&mut self, depth: usize, p: &Origin) -> Result<(), BlocksError> {
        if depth > MAX_BLOCK_DEPTH {
            return Err(error(
                BlocksErrorCode::DepthLimit,
                "Blocks are nested too deeply.",
                None,
                p,
            ));
        }
        self.nodes += 1;
        if self.nodes > MAX_BLOCK_NODES {
            return Err(error(
                BlocksErrorCode::NodeLimit,
                format!("Too many blocks (limit {MAX_BLOCK_NODES})."),
                None,
                p,
            ));
        }
        Ok(())
    }
    // Keep the source validation order explicit: field policy plus parent
    // depth, ID and origin are independent inputs to this single helper.
    #[allow(clippy::too_many_arguments)]
    fn child(
        &mut self,
        m: &mut Map<String, Value>,
        field: &str,
        label: &str,
        optional: bool,
        depth: usize,
        id: &str,
        p: &Origin,
    ) -> Result<Option<Box<BlockNode>>, BlocksError> {
        match m.remove(field).unwrap_or(Value::Null) {
            Value::Null if optional => Ok(None),
            Value::Null => Err(error(
                BlocksErrorCode::MissingField,
                format!("Fill in {label}."),
                Some(id),
                &p.child(field),
            )),
            v => self
                .node(v, depth + 1, false, p.child(field))
                .map(|v| Some(Box::new(v))),
        }
    }
    fn required(
        &mut self,
        m: &mut Map<String, Value>,
        field: &str,
        label: &str,
        depth: usize,
        id: &str,
        p: &Origin,
    ) -> Result<Box<BlockNode>, BlocksError> {
        Ok(self
            .child(m, field, label, false, depth, id, p)?
            .expect("required child checked"))
    }
    fn list(
        &mut self,
        m: &mut Map<String, Value>,
        field: &str,
        depth: usize,
        at_root: bool,
        id: &str,
        p: &Origin,
    ) -> Result<Vec<BlockNode>, BlocksError> {
        match m.remove(field).unwrap_or(Value::Null) {
            Value::Null => Ok(Vec::new()),
            Value::Array(a) => a
                .into_iter()
                .enumerate()
                .map(|(i, v)| self.node(v, depth + 1, at_root, p.child(field).child(i.to_string())))
                .collect(),
            _ => Err(error(
                BlocksErrorCode::BrokenList,
                "A block list is broken.",
                Some(id),
                &p.child(field),
            )),
        }
    }
    fn storage(
        &self,
        m: &Map<String, Value>,
        id: &str,
        p: &Origin,
    ) -> Result<BlockStorage, BlocksError> {
        m.get("storage")
            .and_then(Value::as_str)
            .and_then(BlockStorage::parse)
            .ok_or_else(|| {
                error(
                    BlocksErrorCode::InvalidStorage,
                    "Pick how long the variable is kept.",
                    Some(id),
                    &p.child("storage"),
                )
            })
    }
    fn name(
        &self,
        m: &mut Map<String, Value>,
        counter: bool,
        field: &str,
        id: &str,
        p: &Origin,
    ) -> Result<String, BlocksError> {
        let label = if counter {
            "The counter name"
        } else {
            "The variable name"
        };
        let name = string(m, field, label, if counter { 32 } else { 64 }, false, id, p)?;
        if !(if counter {
            self.rules.counter_name(&name)
        } else {
            self.rules.var_name(&name)
        }) {
            return Err(error(
                BlocksErrorCode::InvalidName,
                if counter {
                    "Counter names start with a letter."
                } else {
                    "Variable names use only letters, numbers and _."
                },
                Some(id),
                &p.child(field),
            ));
        }
        Ok(name)
    }
    fn accessor(
        &mut self,
        m: &mut Map<String, Value>,
        allowed: &[&str],
        depth: usize,
        id: &str,
        p: &Origin,
    ) -> Result<Option<BlockAccessor>, BlocksError> {
        let raw = m.remove("accessor").unwrap_or(Value::Null);
        if raw.is_null() {
            return Ok(None);
        }
        let ap = p.child("accessor");
        let Value::Object(mut a) = raw else {
            return Err(error(
                BlocksErrorCode::InvalidAccessor,
                "This list option is not available here.",
                Some(id),
                &ap,
            ));
        };
        let t = a.remove("type").and_then(|v| {
            if let Value::String(s) = v {
                Some(s)
            } else {
                None
            }
        });
        let Some(t) = t.filter(|s| allowed.contains(&s.as_str())) else {
            return Err(error(
                BlocksErrorCode::InvalidAccessor,
                "This list option is not available here.",
                Some(id),
                &ap.child("type"),
            ));
        };
        let result = match t.as_str() {
            "array" => BlockAccessor::Array,
            "append" => BlockAccessor::Append,
            "random" => BlockAccessor::Random,
            "length" => BlockAccessor::Length,
            "clear" => BlockAccessor::Clear,
            _ => {
                let v = a.remove("index").unwrap_or(Value::Null);
                if v.is_null() {
                    return Err(error(
                        BlocksErrorCode::MissingField,
                        "Fill in the list position.",
                        Some(id),
                        &ap.child("index"),
                    ));
                }
                let index = Box::new(self.node(v, depth + 1, false, ap.child("index"))?);
                match t.as_str() {
                    "index" => BlockAccessor::Index { index },
                    "setIndex" => BlockAccessor::SetIndex { index },
                    _ => BlockAccessor::Remove { index },
                }
            }
        };
        Ok(Some(result))
    }
    fn selector(
        &mut self,
        m: &mut Map<String, Value>,
        storage: BlockStorage,
        depth: usize,
        id: &str,
        p: &Origin,
    ) -> Result<Option<Box<BlockNode>>, BlocksError> {
        if !storage.user_scoped() {
            return Ok(None);
        }
        self.child(m, "userSelector", "", true, depth, id, p)
    }
    fn node(
        &mut self,
        value: Value,
        depth: usize,
        at_root: bool,
        p: Origin,
    ) -> Result<BlockNode, BlocksError> {
        let Value::Object(mut m) = value else {
            return Err(error(
                BlocksErrorCode::BrokenBlock,
                "A block is broken.",
                None,
                &p,
            ));
        };
        let Some(Value::String(t)) = m.remove("type") else {
            return Err(error(
                BlocksErrorCode::BrokenBlock,
                "A block is broken.",
                None,
                &p.child("type"),
            ));
        };
        self.quota(depth, &p)?;
        let id = self.ids.fresh(m.remove("id").and_then(|v| {
            if let Value::String(s) = v {
                Some(s)
            } else {
                None
            }
        }));
        use BlockKind::*;
        let kind = match t.as_str() {
            "literal" => Literal {
                value: string(&mut m, "value", "Text", MAX_COMMAND_TEXT, true, &id, &p)?,
            },
            "literalUtf16" => {
                let value = persisted_string(
                    &mut m,
                    "value",
                    "Text",
                    MAX_COMMAND_TEXT,
                    &id,
                    &p,
                )?;
                // Keep one canonical editor/block form: units that already form
                // UTF-8 text use the version-1 literal and its existing APIs.
                match value.0.to_utf8() {
                    Ok(text) => Literal { value: text },
                    Err(_) => LiteralUtf16 { value },
                }
            }
            "raw" => {
                if !at_root {
                    return Err(error(
                        BlocksErrorCode::RawNotTopLevel,
                        "Advanced pieces can only be used at the top level.",
                        Some(&id),
                        &p,
                    ));
                }
                Raw {
                    source: string(
                        &mut m,
                        "source",
                        "The advanced piece",
                        MAX_COMMAND_TEXT,
                        false,
                        &id,
                        &p,
                    )?,
                }
            }
            "function" => {
                let name = string(&mut m, "name", "The function name", 80, false, &id, &p)?;
                if !self.rules.function_name(&name) {
                    return Err(error(
                        BlocksErrorCode::InvalidName,
                        "That function name is not valid.",
                        Some(&id),
                        &p.child("name"),
                    ));
                }
                Function {
                    name,
                    args: self.list(&mut m, "args", depth, false, &id, &p)?,
                }
            }
            "commandRef" => {
                let mut command_name = string(
                    &mut m,
                    "commandName",
                    "The command name",
                    60,
                    false,
                    &id,
                    &p,
                )?;
                if command_name.starts_with('!') {
                    command_name.remove(0);
                }
                if !self.rules.command_name(&command_name) {
                    return Err(error(
                        BlocksErrorCode::InvalidName,
                        "Type the command to run, like so.",
                        Some(&id),
                        &p.child("commandName"),
                    ));
                }
                CommandRef {
                    command_name,
                    args: self.list(&mut m, "args", depth, false, &id, &p)?,
                }
            }
            "getVar" | "exists" | "deleteVar" | "setVar" => {
                let storage = self.storage(&m, &id, &p)?;
                let name = self.name(&mut m, false, "name", &id, &p)?;
                let value = if t == "setVar" {
                    Some(self.required(&mut m, "value", "the value to remember", depth, &id, &p)?)
                } else {
                    None
                };
                let allowed: &[&str] = match t.as_str() {
                    "setVar" => &["append", "setIndex"],
                    "deleteVar" => &["clear", "remove"],
                    _ => &["array", "index", "random", "length"],
                };
                let accessor = self.accessor(&mut m, allowed, depth, &id, &p)?;
                let user_selector = self.selector(&mut m, storage, depth, &id, &p)?;
                match t.as_str() {
                    "setVar" => SetVar {
                        name,
                        storage,
                        value: value.expect("set value"),
                        accessor,
                        user_selector,
                    },
                    "deleteVar" => DeleteVar {
                        name,
                        storage,
                        accessor,
                        user_selector,
                    },
                    "exists" => Exists {
                        name,
                        storage,
                        accessor,
                        user_selector,
                    },
                    _ => GetVar {
                        name,
                        storage,
                        accessor,
                        user_selector,
                    },
                }
            }
            "binary" => {
                let operator = m
                    .get("operator")
                    .and_then(Value::as_str)
                    .and_then(BlockBinaryOp::parse)
                    .ok_or_else(|| {
                        error(
                            BlocksErrorCode::InvalidOperator,
                            "Pick a check or math sign.",
                            Some(&id),
                            &p.child("operator"),
                        )
                    })?;
                Binary {
                    operator,
                    left: self.required(&mut m, "left", "the left side", depth, &id, &p)?,
                    right: self.required(&mut m, "right", "the right side", depth, &id, &p)?,
                }
            }
            "unary" => {
                let operator = m
                    .get("operator")
                    .and_then(Value::as_str)
                    .and_then(BlockUnaryOp::parse)
                    .ok_or_else(|| {
                        error(
                            BlocksErrorCode::InvalidOperator,
                            "Pick + or −.",
                            Some(&id),
                            &p.child("operator"),
                        )
                    })?;
                Unary {
                    operator,
                    argument: self.required(&mut m, "argument", "the value", depth, &id, &p)?,
                }
            }
            "ternary" => {
                let test = self.required(&mut m, "test", "the check", depth, &id, &p)?;
                let mut branch = |field| -> Result<Box<BlockNode>, BlocksError> {
                    if let Some(n) = self.child(&mut m, field, "", true, depth, &id, &p)? {
                        return Ok(n);
                    }
                    let origin = p.child(field);
                    self.quota(depth + 1, &origin)?;
                    Ok(Box::new(BlockNode {
                        id: self.ids.fresh(None),
                        kind: Literal {
                            value: String::new(),
                        },
                        origin,
                        diagnostic_id: None,
                        text_pieces: Vec::new(),
                    }))
                };
                let consequent = branch("consequent")?;
                let alternate = branch("alternate")?;
                Ternary {
                    test,
                    consequent,
                    alternate,
                }
            }
            "template" => Template {
                parts: self.list(&mut m, "parts", depth, false, &id, &p)?,
            },
            "group" => Group {
                children: self.list(&mut m, "children", depth, false, &id, &p)?,
            },
            "arrayLiteral" => ArrayLiteral {
                items: self.list(&mut m, "items", depth, false, &id, &p)?,
                accessor: self.accessor(&mut m, &["index", "random", "length"], depth, &id, &p)?,
            },
            "loopVar" => LoopVar {
                name: self.name(&mut m, true, "name", &id, &p)?,
            },
            "loopAssign" => {
                let name = self.name(&mut m, true, "name", &id, &p)?;
                let operator = m
                    .get("operator")
                    .and_then(Value::as_str)
                    .and_then(BlockLoopAssignOp::parse)
                    .ok_or_else(|| {
                        error(
                            BlocksErrorCode::InvalidOperator,
                            "Pick how the counter changes.",
                            Some(&id),
                            &p.child("operator"),
                        )
                    })?;
                let value = if operator.increment() {
                    None
                } else {
                    Some(self.required(&mut m, "value", "the counter value", depth, &id, &p)?)
                };
                LoopAssign {
                    name,
                    operator,
                    value,
                }
            }
            "forLoop" => {
                let loop_var = self.name(&mut m, true, "loopVar", &id, &p)?;
                let mode = m
                    .get("mode")
                    .and_then(Value::as_str)
                    .and_then(BlockLoopMode::parse)
                    .ok_or_else(|| {
                        error(
                            BlocksErrorCode::InvalidMode,
                            "Pick the kind of repeat.",
                            Some(&id),
                            &p.child("mode"),
                        )
                    })?;
                let (init, condition, update, iterable) = if mode == BlockLoopMode::Foreach {
                    (
                        None,
                        None,
                        None,
                        Some(self.required(
                            &mut m,
                            "iterable",
                            "the list to go through",
                            depth,
                            &id,
                            &p,
                        )?),
                    )
                } else {
                    (
                        Some(self.required(&mut m, "init", "the start", depth, &id, &p)?),
                        Some(self.required(&mut m, "condition", "when to stop", depth, &id, &p)?),
                        Some(self.required(&mut m, "update", "the step", depth, &id, &p)?),
                        None,
                    )
                };
                let body = self.list(&mut m, "body", depth, false, &id, &p)?;
                ForLoop {
                    loop_var,
                    mode,
                    init,
                    condition,
                    update,
                    iterable,
                    body,
                }
            }
            _ => {
                return Err(error(
                    BlocksErrorCode::UnknownType,
                    format!(
                        "Unknown block type “{}”.",
                        t.chars().take(24).collect::<String>()
                    ),
                    Some(&id),
                    &p.child("type"),
                ));
            }
        };
        Ok(BlockNode {
            id,
            kind,
            origin: p,
            diagnostic_id: None,
            text_pieces: Vec::new(),
        })
    }
}
