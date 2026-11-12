//! One evaluation: `evaluate()` of `evaluator.ts`, node by node.

use super::coerce::{
    arithmetic, compare, is_truthy, loop_assignment, resolve_array_index, to_number_safe,
};
use super::frame::{Frames, Scalars};
use super::{Engine, EvalError, EvalStats, LimitKind};
use crate::context::{
    BudgetSnapshot, CommandReference, Context, LoopExit, Origin, ReferenceAuthorization,
    ReferenceOrigin, ReferenceState, State, TimerSnapshot,
};
use crate::functions::{self, Counters};
use crate::host::{Host, HostCall, HostFuture};
use crate::map::OrderedMap;
use crate::permissions;
use crate::registry::{Builtin, FunctionKind};
use crate::syntax::{
    ArrayAccessor, AstNode, BinaryOp, LoopAssignOp, LoopMode, TemplateSegment, UnaryOp,
    VariableStorage,
};
use crate::value::{CoercionError, Value};
use dima_text::{to_lower, trim};

/// `MAX_TIMER_DEPTH`.
const MAX_TIMER_DEPTH: u32 = 5;
/// `MAX_TIMER_SECONDS` (seven days).
const MAX_TIMER_SECONDS: f64 = 604_800.0;
/// Command references nest at most this deep (`depth >= 5`).
const MAX_REFERENCE_DEPTH: u32 = 5;

/// The maps of what a run keeps, charged to [`super::EvalLimits::memory_bytes`].
#[derive(Clone, Copy)]
pub(super) enum Kept {
    /// Memory variables.
    Variables,
    /// The database read memo of channel variables.
    ChannelMemo,
    /// The database read memo of viewer variables.
    UserMemo,
    /// Loop variables.
    LoopVars,
}

fn entry_size(key: &str, value: &str) -> usize {
    key.len().saturating_add(value.len())
}

fn map_size(map: &OrderedMap<String, String>) -> usize {
    map.iter().fold(0usize, |total, (k, v)| {
        total.saturating_add(entry_size(k, v))
    })
}

/// How a loop body ended.
#[derive(Clone, Copy, PartialEq, Eq)]
enum BodyEnd {
    Normal,
    Break,
    Continue,
}

pub(super) struct Run<'a> {
    pub(super) engine: &'a Engine,
    pub(super) host: &'a mut dyn Host,
    pub(super) context: &'a Context,
    pub(super) state: State,
    pub(super) frames: Frames,
    pub(super) stats: EvalStats,
    /// How deep the evaluation recursion is.
    depth: usize,
    /// Bytes this run added to what it keeps ([`Kept`], command reference arguments).
    memory: usize,
    /// The stack left where the evaluation started (at its first level).
    stack_start: Option<usize>,
}

/// Whether `node` nests deeper than `limit` (checked without recursion, so a tree the parser
/// accepted at any depth is measured safely).
pub(super) fn depth_exceeds(node: &AstNode, limit: usize) -> bool {
    let mut pending = vec![(node, 1usize)];
    while let Some((node, depth)) = pending.pop() {
        if depth > limit {
            return true;
        }
        node.for_each_child(|child| pending.push((child, depth + 1)));
    }
    false
}

/// `String(item ?? '')` of each item.
fn item_texts(items: &[Value]) -> Result<Vec<String>, CoercionError> {
    items
        .iter()
        .map(|item| item.to_text_or_empty().map(std::borrow::Cow::into_owned))
        .collect()
}

/// `parseIterableValue`: a list's items, a JSON list's items, otherwise the text as one item
/// (none for empty text, `null` and `undefined`). A JSON list whose items `String()` cannot
/// convert is one item, its text: the reference converts them inside its `try`.
fn iterable_values(value: Value) -> Result<Vec<String>, CoercionError> {
    Ok(match value {
        Value::List(items) => item_texts(&items)?,
        Value::Text(text) => match Value::parse_json(&text) {
            Some(Value::List(items)) => item_texts(&items).unwrap_or_else(|_| vec![text]),
            Some(_) => vec![text],
            None if text.is_empty() => Vec::new(),
            None => vec![text],
        },
        Value::Undefined | Value::Null => Vec::new(),
        other => vec![other.into_text()?],
    })
}

/// `String(value ?? '')`, reusing text.
fn text_of(value: Value) -> Result<String, CoercionError> {
    match value {
        Value::Text(text) => Ok(text),
        other => Ok(other.to_text_or_empty()?.into_owned()),
    }
}

/// Arithmetic or comparison of two evaluated operands.
fn binary_result(operator: BinaryOp, left: &Value, right: &Value) -> Result<Value, CoercionError> {
    Ok(match operator {
        BinaryOp::Add
        | BinaryOp::Subtract
        | BinaryOp::Multiply
        | BinaryOp::Divide
        | BinaryOp::Modulo => {
            let left = to_number_safe(left)?;
            Value::Text(arithmetic(operator, left, to_number_safe(right)?))
        }
        _ => {
            let left = left.to_text()?;
            Value::flag(compare(&left, operator, &right.to_text()?))
        }
    })
}

/// A root keeps every value but `undefined` and empty text, joined by spaces.
/// The text a root adds for `value`, if any.
fn root_text(value: &Value) -> Result<Option<std::borrow::Cow<'_, str>>, CoercionError> {
    if matches!(value, Value::Undefined) || value.as_str() == Some("") {
        return Ok(None);
    }
    value.to_text().map(Some)
}

/// `snapshotTimerContext`.
pub(super) fn snapshot(
    context: &Context,
    state: &State,
    count: f64,
    loop_vars: &OrderedMap<String, String>,
) -> TimerSnapshot {
    let pairs = |map: &OrderedMap<String, String>| {
        map.iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<Vec<_>>()
    };
    TimerSnapshot {
        broadcaster_id: context.broadcaster_id.clone(),
        user_id: context.user_id.clone(),
        user_login: context.user_login.clone(),
        user_display_name: context.user_display_name.clone(),
        user_plan: context.user_plan,
        user_level: context.user_level,
        enforce_function_permissions: context.enforce_function_permissions,
        authorization: context.authorization.clone(),
        argument: context.argument.clone(),
        count,
        event_data: context.event_data.clone(),
        eventsub_data: context.eventsub_data.clone(),
        extra_context: context.extra_context.clone(),
        platform: context.platform.clone(),
        scope_type: context.scope_type.clone(),
        scope_name: context.scope_name.clone(),
        scope_aliases: context.scope_aliases.clone(),
        command_name: context.command_name.clone(),
        command_id: context.command_id.clone(),
        command_ref_budget: BudgetSnapshot {
            remaining: context.budget.remaining(),
        },
        command_ref_depth: context.command_ref_depth,
        visited_commands: context.visited_commands.clone(),
        command_responses: state.command_responses.clone(),
        variables: pairs(&state.variables),
        arrays: state
            .arrays
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        loop_vars: pairs(loop_vars),
        timer_depth: context.timer_depth.unwrap_or(0).saturating_add(1),
    }
}

impl<'a> Run<'a> {
    pub(super) fn new(
        engine: &'a Engine,
        context: &'a Context,
        mut state: State,
        host: &'a mut dyn Host,
    ) -> Self {
        let scalars = Scalars {
            count: state.count,
            count_modified: state.count_modified,
            loop_exit: state.loop_exit,
            loop_depth: state.loop_depth,
            effect: context.effect.clone(),
        };
        let loop_vars = std::mem::take(&mut state.loop_vars);
        Self {
            engine,
            host,
            context,
            state,
            frames: Frames::new(scalars, loop_vars),
            stats: EvalStats::default(),
            depth: 0,
            memory: 0,
            stack_start: None,
        }
    }

    /// The state with the final scalars.
    pub(super) fn finish(mut self) -> (State, EvalStats) {
        self.state.count = self.frames.scalars.count;
        self.state.count_modified = self.frames.scalars.count_modified;
        self.state.loop_exit = self.frames.scalars.loop_exit;
        self.state.loop_depth = self.frames.scalars.loop_depth;
        self.state.loop_vars = std::mem::take(&mut self.frames.loop_vars);
        (self.state, self.stats)
    }

    /// After a limit stopped an expression midway: forget the watches it left open.
    pub(super) fn after_limit(&mut self) {
        self.frames.abandon_from(0);
        self.depth = 0;
    }

    // ---- limits ----

    fn step(&mut self) -> Result<(), EvalError> {
        self.charge(1)
    }

    fn charge(&mut self, units: u64) -> Result<(), EvalError> {
        self.stats.steps = self.stats.steps.saturating_add(units);
        if self.stats.steps > self.engine.limits.steps {
            return Err(EvalError::Limit(LimitKind::Steps));
        }
        Ok(())
    }

    /// Bytes of JSON read or written cost work too.
    pub(super) fn charge_bytes(&mut self, bytes: usize) -> Result<(), EvalError> {
        self.charge((bytes / 256) as u64)
    }

    pub(super) fn host_op(&mut self) -> Result<(), EvalError> {
        self.stats.host_calls = self.stats.host_calls.saturating_add(1);
        if self.stats.host_calls > self.engine.limits.host_calls {
            return Err(EvalError::Limit(LimitKind::HostCalls));
        }
        self.step()
    }

    /// Charges what the run keeps: `added` bytes in, `removed` bytes out.
    fn keep(&mut self, added: usize, removed: usize) -> Result<(), EvalError> {
        let memory = self.memory.saturating_sub(removed).saturating_add(added);
        if memory > self.engine.limits.memory_bytes {
            return Err(EvalError::Limit(LimitKind::Memory));
        }
        self.memory = memory;
        Ok(())
    }

    fn kept(&mut self, which: Kept) -> &mut OrderedMap<String, String> {
        match which {
            Kept::Variables => &mut self.state.variables,
            Kept::ChannelMemo => &mut self.state.command_variables,
            Kept::UserMemo => &mut self.state.user_command_variables,
            Kept::LoopVars => &mut self.frames.loop_vars,
        }
    }

    /// Whether [`Run::put`] of this entry would fit, without inserting it.
    pub(super) fn can_put(&mut self, which: Kept, key: &str, value: &str) -> Result<(), EvalError> {
        let old = self
            .kept(which)
            .get(key)
            .map_or(0, |old| entry_size(key, old));
        let memory = self
            .memory
            .saturating_sub(old)
            .saturating_add(entry_size(key, value));
        if memory > self.engine.limits.memory_bytes {
            return Err(EvalError::Limit(LimitKind::Memory));
        }
        Ok(())
    }

    /// Inserts into a kept map, within the memory budget (checked before the insert).
    pub(super) fn put(&mut self, which: Kept, key: String, value: String) -> Result<(), EvalError> {
        let old = self
            .kept(which)
            .get(&key)
            .map_or(0, |old| entry_size(&key, old));
        self.keep(entry_size(&key, &value), old)?;
        self.kept(which).insert(key, value);
        Ok(())
    }

    /// Removes from a kept map.
    pub(super) fn forget(&mut self, which: Kept, key: &str) {
        if let Some(old) = self.kept(which).remove(key) {
            self.memory = self.memory.saturating_sub(entry_size(key, &old));
        }
    }

    /// Restores the loop variables a loop started with.
    fn restore_loop_vars(&mut self, outer: OrderedMap<String, String>) {
        let inner = map_size(&self.frames.loop_vars);
        self.memory = self
            .memory
            .saturating_sub(inner)
            .saturating_add(map_size(&outer));
        self.frames.loop_vars = outer;
    }

    /// Adds `bytes` to a running total of one step's gathered values, within the text budget.
    fn gather(&self, total: &mut usize, bytes: usize) -> Result<(), EvalError> {
        *total = total.saturating_add(bytes);
        self.check_size(*total)
    }

    pub(super) fn check_size(&self, bytes: usize) -> Result<(), EvalError> {
        if bytes > self.engine.limits.text_bytes {
            return Err(EvalError::Limit(LimitKind::TextSize));
        }
        Ok(())
    }

    fn checked(&self, value: Value) -> Result<Value, EvalError> {
        if let Value::Text(text) = &value {
            self.check_size(text.len())?;
        } else if !matches!(
            value,
            Value::Undefined | Value::Null | Value::Bool(_) | Value::Number(_)
        ) {
            self.check_size(value.weight())?;
        }
        Ok(value)
    }

    pub(super) fn random(&mut self) -> Result<f64, EvalError> {
        self.host.random().float().map_err(|_| EvalError::Random)
    }

    // ---- evaluation ----

    /// A program (or any node) at the top of a run. A tree deeper than the evaluation's nesting
    /// limit is refused before anything in it runs, as a parse limit would be.
    pub(super) async fn program(&mut self, node: &AstNode) -> Result<Value, EvalError> {
        if depth_exceeds(node, self.engine.limits.nesting) {
            return Err(EvalError::Limit(LimitKind::Nesting));
        }
        self.child(node).await
    }

    /// Evaluates a child. Leaves are evaluated in place; any other node runs as its own boxed
    /// future (one allocation per non-leaf node), whose depth is checked against the nesting
    /// limit as a guard (the stack grows with it: every level polls the one below), and so is
    /// the stack left: within the contract ([`crate::stack`]) neither check fires before the
    /// nesting limit does.
    pub(super) async fn child(&mut self, node: &AstNode) -> Result<Value, EvalError> {
        self.step()?;
        match node {
            AstNode::Literal { value } => return Ok(Value::Text(value.clone())),
            AstNode::LoopVar { name } => return Ok(Value::Text(self.loop_var(name))),
            _ => {}
        }
        let room = crate::stack::remaining();
        if let Some(room) = room {
            let start = *self.stack_start.get_or_insert(room);
            let used = start.saturating_sub(room);
            self.stats.stack_bytes = self.stats.stack_bytes.max(used);
        }
        if self.depth >= self.engine.limits.nesting
            || room.is_none_or(|room| room < crate::stack::HOST_STACK_BYTES)
        {
            return Err(EvalError::Limit(LimitKind::Nesting));
        }
        self.depth += 1;
        let result = self.eval(node).await;
        self.depth -= 1;
        self.checked(result?)
    }

    /// The node's own future. A plain function, so a level of the tree costs only the frames of
    /// the node's method and of [`Run::child`].
    fn eval<'s>(&'s mut self, node: &'s AstNode) -> HostFuture<'s, Result<Value, EvalError>> {
        match node {
            AstNode::LoopAssign {
                name,
                operator,
                value,
            } => Box::pin(self.loop_assign(name, *operator, value.as_deref())),
            AstNode::GetVar {
                name,
                storage,
                accessor,
                user_selector,
            } => {
                Box::pin(self.get_var(name, *storage, accessor.as_ref(), user_selector.as_deref()))
            }
            AstNode::SetVar {
                name,
                storage,
                value,
                accessor,
                user_selector,
            } => Box::pin(self.set_var(
                name,
                *storage,
                value,
                accessor.as_ref(),
                user_selector.as_deref(),
            )),
            AstNode::Exists {
                name,
                storage,
                accessor,
                user_selector,
            } => Box::pin(self.exists(name, *storage, accessor.as_ref(), user_selector.as_deref())),
            AstNode::DeleteVar {
                name,
                storage,
                accessor,
                user_selector,
            } => Box::pin(self.delete_var(
                name,
                *storage,
                accessor.as_ref(),
                user_selector.as_deref(),
            )),
            AstNode::Function { name, args } => Box::pin(self.function(name, args)),
            AstNode::Binary {
                operator,
                left,
                right,
            } => Box::pin(self.binary(*operator, left, right)),
            AstNode::Unary { operator, argument } => Box::pin(self.unary(*operator, argument)),
            AstNode::Ternary {
                test,
                consequent,
                alternate,
            } => Box::pin(self.ternary(test, consequent, alternate)),
            AstNode::Template { segments } => Box::pin(self.template(segments)),
            AstNode::ArrayLiteral { items, accessor } => {
                Box::pin(self.array_literal(items, accessor.as_ref()))
            }
            AstNode::ForLoop {
                loop_var,
                mode,
                init,
                condition,
                update,
                iterable,
                body,
            } => Box::pin(self.for_loop(
                loop_var,
                *mode,
                [
                    init.as_deref(),
                    condition.as_deref(),
                    update.as_deref(),
                    iterable.as_deref(),
                ],
                body,
            )),
            AstNode::CommandRef { command_name, args } => {
                Box::pin(self.command_ref(command_name, args))
            }
            AstNode::Root { children } => Box::pin(self.root(children)),
            AstNode::Custom { custom_type, .. } => {
                let value = Value::Text(format!("[Custom node not implemented: {custom_type}]"));
                Box::pin(async move { Ok(value) })
            }
            AstNode::Literal { value } => {
                let value = Value::Text(value.clone());
                Box::pin(async move { Ok(value) })
            }
            AstNode::LoopVar { name } => {
                let value = Value::Text(self.loop_var(name));
                Box::pin(async move { Ok(value) })
            }
        }
    }

    fn loop_var(&self, name: &str) -> String {
        self.frames
            .loop_vars
            .get(name)
            .cloned()
            .unwrap_or_else(|| format!("#{name}"))
    }

    /// `String(value ?? '')` of a child.
    async fn child_text(&mut self, node: &AstNode) -> Result<String, EvalError> {
        Ok(text_of(self.child(node).await?)?)
    }

    /// A child whose returned context the reference throws away.
    async fn discarded(&mut self, node: &AstNode) -> Result<Value, EvalError> {
        let watch = self.frames.watch();
        let result = self.child(node).await;
        self.frames.unwatch(watch);
        result
    }

    /// The per-viewer selector of `cacheUser`/`dbUser` variables: its text, trimmed.
    async fn selector(
        &mut self,
        storage: VariableStorage,
        selector: Option<&AstNode>,
    ) -> Result<Option<String>, EvalError> {
        match selector {
            Some(node) if storage.is_user_scoped() => {
                let text = self.child_text(node).await?;
                Ok(Some(trim(&text).to_owned()))
            }
            _ => Ok(None),
        }
    }

    fn responses(name: &str, storage: VariableStorage) -> bool {
        name == "responses" && storage == VariableStorage::Memory
    }

    fn random_item<T: Clone>(&mut self, items: &[T]) -> Result<Option<T>, EvalError> {
        if items.is_empty() {
            return Ok(None);
        }
        let index = (self.random()? * items.len() as f64).floor();
        Ok(items.get(index as usize).cloned())
    }

    async fn loop_assign(
        &mut self,
        name: &str,
        operator: LoopAssignOp,
        value: Option<&AstNode>,
    ) -> Result<Value, EvalError> {
        let next = match value {
            Some(value) => self.child(value).await?,
            None => Value::Undefined,
        };
        let current = self.frames.loop_vars.get(name).map(String::as_str);
        let resolved = loop_assignment(current, operator, &next, self.engine.limits.text_bytes)
            .map_err(failure)?;
        self.put(Kept::LoopVars, name.to_owned(), resolved.clone())?;
        Ok(Value::Text(resolved))
    }

    async fn delete_var(
        &mut self,
        name: &str,
        storage: VariableStorage,
        accessor: Option<&ArrayAccessor>,
        selector: Option<&AstNode>,
    ) -> Result<Value, EvalError> {
        let target = self.selector(storage, selector).await?;
        let watch = self.frames.watch();
        let result = self
            .delete_value(name, storage, accessor, target.as_deref())
            .await;
        self.frames.unwatch(watch);
        result?;
        Ok(Value::empty())
    }

    async fn binary(
        &mut self,
        operator: BinaryOp,
        left: &AstNode,
        right: &AstNode,
    ) -> Result<Value, EvalError> {
        let left = self.child(left).await?;
        let right = self.child(right).await?;
        Ok(binary_result(operator, &left, &right)?)
    }

    async fn unary(&mut self, operator: UnaryOp, argument: &AstNode) -> Result<Value, EvalError> {
        let number = to_number_safe(&self.child(argument).await?)?;
        let result = match operator {
            UnaryOp::Plus => number,
            UnaryOp::Minus => -number,
        };
        Ok(Value::Text(dima_text::number_to_string(result)))
    }

    async fn ternary(
        &mut self,
        test: &AstNode,
        consequent: &AstNode,
        alternate: &AstNode,
    ) -> Result<Value, EvalError> {
        let test = self.child(test).await?;
        let branch = if is_truthy(&test)? {
            consequent
        } else {
            alternate
        };
        self.child(branch).await
    }

    async fn template(&mut self, segments: &[TemplateSegment]) -> Result<Value, EvalError> {
        let mut out = String::new();
        for segment in segments {
            match segment {
                TemplateSegment::Text { value } => {
                    self.check_size(out.len().saturating_add(value.len()))?;
                    out.push_str(value);
                }
                TemplateSegment::Expr { node } => {
                    let value = self.child(node).await?;
                    let text = value.to_text_or_empty()?;
                    self.check_size(out.len().saturating_add(text.len()))?;
                    out.push_str(&text);
                }
            }
        }
        Ok(Value::Text(out))
    }

    async fn array_literal(
        &mut self,
        items: &[AstNode],
        accessor: Option<&ArrayAccessor>,
    ) -> Result<Value, EvalError> {
        let mut values = Vec::with_capacity(items.len());
        let mut total = 0usize;
        for item in items {
            let value = text_of(self.child(item).await?)?;
            self.gather(&mut total, value.len())?;
            values.push(value);
        }
        Ok(match accessor {
            Some(ArrayAccessor::Index { index }) => {
                let index = self.child(index).await?;
                match resolve_array_index(&index, values.len())? {
                    Some(at) => Value::Text(values.swap_remove(at)),
                    None => Value::empty(),
                }
            }
            Some(ArrayAccessor::Random) => match self.random_item(&values)? {
                Some(item) => Value::Text(item),
                None => Value::empty(),
            },
            Some(ArrayAccessor::Length) => Value::Text(values.len().to_string()),
            _ => Value::List(values.into_iter().map(Value::Text).collect()),
        })
    }

    async fn root(&mut self, children: &[AstNode]) -> Result<Value, EvalError> {
        let mut out = String::new();
        let mut first = true;
        for child in children {
            let value = self.child(child).await?;
            let Some(text) = root_text(&value)? else {
                continue;
            };
            self.check_size(out.len().saturating_add(text.len()).saturating_add(1))?;
            if !first {
                out.push(' ');
            }
            first = false;
            out.push_str(&text);
        }
        Ok(Value::Text(out))
    }

    // ---- variables ----

    async fn get_var(
        &mut self,
        name: &str,
        storage: VariableStorage,
        accessor: Option<&ArrayAccessor>,
        selector: Option<&AstNode>,
    ) -> Result<Value, EvalError> {
        let target = self.selector(storage, selector).await?;
        let target = target.as_deref();
        if Self::responses(name, storage) {
            let responses = &self.state.command_responses;
            return Ok(match accessor {
                None | Some(ArrayAccessor::Array) => {
                    let size = responses
                        .iter()
                        .fold(responses.len().saturating_add(1), |total, item| {
                            total.saturating_add(crate::value::json_string_size(item))
                        });
                    self.check_size(size)?;
                    Value::Text(json_of_texts(&self.state.command_responses))
                }
                Some(ArrayAccessor::Index { index }) => {
                    let index = self.discarded(index).await?;
                    let responses = &self.state.command_responses;
                    resolve_array_index(&index, responses.len())?
                        .and_then(|at| responses.get(at).cloned())
                        .map_or_else(Value::empty, Value::Text)
                }
                Some(ArrayAccessor::Random) => {
                    let responses = self.state.command_responses.clone();
                    self.random_item(&responses)?
                        .map_or_else(Value::empty, Value::Text)
                }
                Some(ArrayAccessor::Length) => Value::Text(responses.len().to_string()),
                Some(_) => Value::empty(),
            });
        }
        let Some(accessor) = accessor else {
            return Ok(Value::Text(self.read_value(name, storage, target).await?));
        };
        let mut list = self.read_list(name, storage, target).await?;
        Ok(match accessor {
            ArrayAccessor::Array => Value::Text(self.write_json(&list)?),
            ArrayAccessor::Index { index } => {
                let index = self.discarded(index).await?;
                match resolve_array_index(&index, list.len())? {
                    Some(at) => list.swap_remove(at),
                    None => Value::empty(),
                }
            }
            ArrayAccessor::Random => self.random_item(&list)?.unwrap_or_else(Value::empty),
            ArrayAccessor::Length => Value::Text(list.len().to_string()),
            _ => Value::empty(),
        })
    }

    async fn set_var(
        &mut self,
        name: &str,
        storage: VariableStorage,
        value: &AstNode,
        accessor: Option<&ArrayAccessor>,
        selector: Option<&AstNode>,
    ) -> Result<Value, EvalError> {
        let target = self.selector(storage, selector).await?;
        let target = target.as_deref();
        let value = self.child(value).await?;
        // `String(value)`: `undefined` is the text "undefined" here.
        let text = value.to_text()?.into_owned();
        let appended: Vec<String> = match &value {
            Value::List(items) => items
                .iter()
                .map(|item| item.to_text().map(std::borrow::Cow::into_owned))
                .collect::<Result<_, _>>()?,
            _ => vec![text.clone()],
        };
        if Self::responses(name, storage) {
            match accessor {
                Some(ArrayAccessor::Append) => {
                    let total = self
                        .state
                        .command_responses
                        .iter()
                        .chain(&appended)
                        .fold(0usize, |total, item| total.saturating_add(item.len()));
                    self.check_size(total)?;
                    self.state.command_responses.extend(appended);
                    self.save_responses().await?;
                }
                Some(ArrayAccessor::SetIndex { index }) => {
                    let index = self.child(index).await?;
                    if let Some(at) =
                        resolve_array_index(&index, self.state.command_responses.len())?
                    {
                        if let Some(slot) = self.state.command_responses.get_mut(at) {
                            *slot = text;
                        }
                        self.save_responses().await?;
                    }
                }
                _ => {}
            }
            return Ok(Value::empty());
        }
        let Some(accessor) = accessor else {
            self.save_value(name, storage, text, target).await?;
            return Ok(Value::empty());
        };
        let mut list = self.read_list(name, storage, target).await?;
        match accessor {
            ArrayAccessor::Append => {
                list.extend(appended.into_iter().map(Value::Text));
                let json = self.write_json(&list)?;
                self.save_value(name, storage, json, target).await?;
            }
            ArrayAccessor::SetIndex { index } => {
                let index = self.child(index).await?;
                if let Some(slot) =
                    resolve_array_index(&index, list.len())?.and_then(|at| list.get_mut(at))
                {
                    *slot = Value::Text(text);
                    let json = self.write_json(&list)?;
                    self.save_value(name, storage, json, target).await?;
                }
            }
            _ => {}
        }
        Ok(Value::empty())
    }

    async fn exists(
        &mut self,
        name: &str,
        storage: VariableStorage,
        accessor: Option<&ArrayAccessor>,
        selector: Option<&AstNode>,
    ) -> Result<Value, EvalError> {
        let target = self.selector(storage, selector).await?;
        let target = target.as_deref();
        if Self::responses(name, storage) {
            let any = !self.state.command_responses.is_empty();
            return Ok(Value::flag(match accessor {
                None | Some(ArrayAccessor::Array | ArrayAccessor::Random) => any,
                Some(ArrayAccessor::Index { index }) => {
                    let index = self.child(index).await?;
                    resolve_array_index(&index, self.state.command_responses.len())?.is_some()
                }
                Some(ArrayAccessor::Length) => true,
                Some(_) => false,
            }));
        }
        let Some(accessor) = accessor else {
            return Ok(Value::flag(self.key_exists(name, storage, target).await?));
        };
        let exists = self.key_exists(name, storage, target).await?;
        Ok(Value::flag(match accessor {
            ArrayAccessor::Array | ArrayAccessor::Length => exists,
            ArrayAccessor::Index { index } => {
                if exists {
                    let list = self.read_list(name, storage, target).await?;
                    let index = self.child(index).await?;
                    resolve_array_index(&index, list.len())?.is_some()
                } else {
                    false
                }
            }
            ArrayAccessor::Random => {
                exists && !self.read_list(name, storage, target).await?.is_empty()
            }
            _ => false,
        }))
    }

    /// `JSON.stringify` of a list, within the size limit.
    pub(super) fn write_json(&mut self, list: &[Value]) -> Result<String, EvalError> {
        let size = Value::list_json_size(list);
        self.check_size(size)?;
        self.charge_bytes(size)?;
        Ok(Value::list_to_json(list))
    }

    // ---- functions ----

    async fn args(&mut self, nodes: &[AstNode]) -> Result<Vec<Value>, EvalError> {
        let mut values = Vec::with_capacity(nodes.len());
        let mut total = 0usize;
        for node in nodes {
            let value = self.child(node).await?;
            self.gather(&mut total, value.weight())?;
            values.push(value);
        }
        Ok(values)
    }

    async fn function(&mut self, name: &str, nodes: &[AstNode]) -> Result<Value, EvalError> {
        // Timer bodies are programs to run later, never eager arguments.
        if name == "timer" {
            if self.context.simulation {
                self.host_op()?;
                let value = self.host.simulate("timer", &[], self.context).await?;
                return Ok(value.unwrap_or_else(Value::empty));
            }
            return self.timer(nodes).await;
        }
        let args = self.args(nodes).await?;
        let registry = self.engine.registry.clone();
        let Some(spec) = registry.get(name) else {
            return Ok(Value::Text(format!("[Unknown function: {name}]")));
        };
        let required = spec.metadata.as_ref().map_or(1.0, |m| m.required_level());
        let actual = self.context.user_level;
        if self.context.enforce_function_permissions && actual < required {
            return Ok(Value::Text(permission_denied(name, required, actual)));
        }
        if self.context.simulation {
            self.host_op()?;
            if let Some(value) = self.host.simulate(name, &args, self.context).await? {
                return Ok(value);
            }
        }
        match spec.kind {
            FunctionKind::Builtin(Builtin::Delay) => match functions::delay_millis(&args)? {
                Ok(millis) => {
                    self.host_op()?;
                    self.host.sleep(millis).await;
                    Ok(Value::empty())
                }
                Err(answer) => Ok(Value::Text(answer)),
            },
            FunctionKind::Builtin(Builtin::Timer) => Ok(Value::empty()),
            FunctionKind::Builtin(builtin) => {
                let mut draw: Option<f64> = None;
                if builtin == Builtin::Random {
                    // The bound is read (and may fail) before the draw.
                    functions::random_max(&args)?;
                    draw = Some(self.random()?);
                }
                let scalars = &mut self.frames.scalars;
                let counters = Counters {
                    count: &mut scalars.count,
                    count_modified: &mut scalars.count_modified,
                    loop_exit: &mut scalars.loop_exit,
                };
                let mut random = || draw.unwrap_or(0.0);
                functions::run(
                    builtin,
                    &args,
                    self.context,
                    counters,
                    &mut random,
                    self.engine.limits.text_bytes,
                )
                .map_err(failure)
            }
            FunctionKind::Host(function) => {
                self.host_op()?;
                let call = HostCall {
                    function,
                    name,
                    args,
                    context: self.context,
                    effect: self.frames.scalars.effect.as_ref(),
                    random_user: &mut self.state.random_user,
                };
                Ok(self.host.call(call).await?)
            }
        }
    }

    /// `evaluateTimer`.
    pub(super) async fn timer(&mut self, args: &[AstNode]) -> Result<Value, EvalError> {
        let fail = |message: &str| Value::Text(format!("timer: {message}"));
        let (Some(duration), Some(body)) = (args.first(), args.get(1..).filter(|b| !b.is_empty()))
        else {
            return Ok(fail("usage: $(timer seconds message_and_actions)"));
        };
        if self.context.timer_depth.unwrap_or(0) >= MAX_TIMER_DEPTH {
            return Ok(fail("maximum nested timer depth reached"));
        }
        if self.context.broadcaster_id.is_empty() || self.context.platform != "twitch" {
            return Ok(fail("requires a Twitch channel"));
        }
        // Timers never carry live effect authority, their duration expression included.
        self.frames.switch();
        let effect = self.frames.scalars.effect.take();
        let duration = self.child(duration).await;
        let snapshot = snapshot(
            self.context,
            &self.state,
            self.frames.scalars.count,
            &self.frames.loop_vars,
        );
        self.frames.switch();
        self.frames.scalars.effect = effect;
        let seconds = duration?.to_number()?;
        if !seconds.is_finite() || !(1.0..=MAX_TIMER_SECONDS).contains(&seconds) {
            return Ok(fail("seconds must be between 1 and 604800"));
        }
        self.host_op()?;
        match self.host.schedule_timer(seconds, body, snapshot).await {
            Ok(()) => Ok(Value::empty()),
            Err(_) => Ok(fail("could not schedule timer")),
        }
    }

    // ---- loops ----

    async fn for_loop(
        &mut self,
        loop_var: &str,
        mode: LoopMode,
        [init, condition, update, iterable]: [Option<&AstNode>; 4],
        body: &[AstNode],
    ) -> Result<Value, EvalError> {
        let depth = self.frames.scalars.loop_depth;
        let plan = self.context.user_plan;
        if depth >= plan.max_loop_depth() {
            return Ok(Value::empty());
        }
        let outer_vars = self.frames.loop_vars.clone();
        // loopContext = { ...context, loopDepth: depth + 1, loopVars: copy, loopExit: undefined }
        self.frames.switch();
        self.frames.scalars.loop_depth = depth + 1;
        self.frames.scalars.loop_exit = None;
        let result = self
            .iterate(
                loop_var,
                mode,
                [init, condition, update, iterable],
                body,
                depth + 1,
                plan.max_loop_iterations(),
            )
            .await;
        self.restore_loop_vars(outer_vars);
        self.frames.scalars.loop_depth = depth;
        result?;
        // { ...activeContext, loopDepth: context.loopDepth, loopExit: undefined, loopVars: context.loopVars }
        self.frames.switch();
        self.frames.scalars.loop_exit = None;
        Ok(Value::empty())
    }

    /// `activeContext = { ...result.context, loopDepth, loopVars: copy, loopExit: undefined }`.
    fn next_active(&mut self, depth: u32) {
        self.frames.switch();
        self.frames.scalars.loop_depth = depth;
        self.frames.scalars.loop_exit = None;
    }

    async fn iterate(
        &mut self,
        loop_var: &str,
        mode: LoopMode,
        [init, condition, update, iterable]: [Option<&AstNode>; 4],
        body: &[AstNode],
        depth: u32,
        max: u32,
    ) -> Result<(), EvalError> {
        let mut iterations = 0u32;
        if mode == LoopMode::Foreach {
            let value = match iterable {
                Some(node) => self.child(node).await?,
                None => Value::empty(),
            };
            self.next_active(depth);
            if let Value::Text(text) = &value {
                self.charge_bytes(text.len())?;
            }
            for item in iterable_values(value)? {
                if iterations >= max {
                    break;
                }
                self.put(Kept::LoopVars, loop_var.to_owned(), item)?;
                let end = self.body(body, depth).await?;
                iterations += 1;
                if end == BodyEnd::Break {
                    break;
                }
            }
            return Ok(());
        }
        if let Some(init) = init {
            self.child(init).await?;
            self.next_active(depth);
        }
        while iterations < max {
            if let Some(condition) = condition {
                let test = self.child(condition).await?;
                self.next_active(depth);
                if !is_truthy(&test)? {
                    break;
                }
            }
            let end = self.body(body, depth).await?;
            iterations += 1;
            if end == BodyEnd::Break {
                break;
            }
            if let Some(update) = update {
                self.child(update).await?;
                self.next_active(depth);
            }
        }
        Ok(())
    }

    /// `runBody`: every node runs on the iteration's own copy (`bodyContext`), which takes only
    /// the loop variables and the exit flag from each node's result; what follows the body
    /// continues from the last node's result (`activeContext`).
    async fn body(&mut self, body: &[AstNode], depth: u32) -> Result<BodyEnd, EvalError> {
        let before = self.frames.object();
        // bodyContext = { ...activeContext, loopVars: copy, loopExit: undefined }
        self.frames.switch();
        self.frames.scalars.loop_exit = None;
        let mut active: Option<Scalars> = None;
        for node in body {
            let watch = self.frames.watch();
            let level = self.frames.watch_depth();
            if let Err(error) = self.child(node).await {
                self.frames.abandon_from(level - 1);
                return Err(error);
            }
            let mut result = self.frames.scalars.clone();
            self.frames.unwatch(watch);
            self.frames.scalars.loop_exit = result.loop_exit;
            result.loop_depth = depth;
            if let Some(exit) = result.loop_exit.take() {
                self.frames.switch();
                self.frames.scalars = result;
                return Ok(match exit {
                    LoopExit::Break => BodyEnd::Break,
                    LoopExit::Continue => BodyEnd::Continue,
                });
            }
            active = Some(result);
        }
        match active {
            Some(result) => {
                self.frames.switch();
                self.frames.scalars = result;
            }
            // An empty body leaves activeContext as it was.
            None => self.frames.resume(before),
        }
        self.frames.scalars.loop_exit = None;
        Ok(BodyEnd::Normal)
    }

    // ---- command references ----

    async fn command_ref(
        &mut self,
        command_name: &str,
        args: &[AstNode],
    ) -> Result<Value, EvalError> {
        let name = to_lower(trim(command_name));
        let depth = self.context.command_ref_depth.unwrap_or(0);
        let key = format!("{}:{name}", self.context.broadcaster_id);
        let budget = self.context.budget.clone();
        if depth >= MAX_REFERENCE_DEPTH
            || self.context.visited_commands.contains(&key)
            || budget.remaining() <= 0
        {
            return Ok(Value::empty());
        }
        let mut values = Vec::with_capacity(args.len());
        let mut total = 0usize;
        for arg in args {
            let value = self.child_text(arg).await?;
            // The argument is the values joined by spaces.
            self.gather(&mut total, value.len().saturating_add(1))?;
            values.push(value);
        }
        if !budget.take() {
            return Ok(Value::empty());
        }
        let context = self.context;
        let effect = match (&self.frames.scalars.effect, &context.authorization) {
            (Some(effect), Some(authorization))
                if !context.enforce_function_permissions
                    && authorization.origin == Origin::Authored =>
            {
                self.host.fork_effect(effect)
            }
            _ => None,
        };
        let argument = values.join(" ");
        self.keep(argument.len(), 0)?;
        let mut visited = context.visited_commands.clone();
        if !visited.contains(&key) {
            visited.push(key);
        }
        let reference = CommandReference {
            effect,
            channel_id: context.broadcaster_id.clone(),
            command_name: name,
            argument,
            event_data: reference_event_data(context),
            authorization: self.reference_authorization(),
            state: ReferenceState {
                visited_commands: visited,
                command_ref_depth: depth + 1,
                budget,
                timer_depth: context.timer_depth,
            },
        };
        self.state.command_references.push(reference);
        Ok(Value::empty())
    }

    /// `resolveCommandRefAuthorization`, with `dima-commands`' identity rules.
    fn reference_authorization(&self) -> ReferenceAuthorization {
        let context = self.context;
        if !context.enforce_function_permissions {
            return ReferenceAuthorization {
                origin: ReferenceOrigin::Authored,
                identity: permissions::create_broadcaster_identity(),
            };
        }
        let fallback = if context.user_level.is_finite() {
            context.user_level.trunc().clamp(1.0, 10.0)
        } else {
            1.0
        };
        let identity = match context
            .authorization
            .as_ref()
            .and_then(|a| a.identity.as_ref())
        {
            Some(raw) if raw.js_truthy() => permissions::parse_identity(raw, fallback),
            _ => permissions::user_identity(fallback),
        };
        ReferenceAuthorization {
            origin: ReferenceOrigin::Llm,
            identity,
        }
    }
}

/// A builtin's failure as the evaluation's error.
fn failure(failure: functions::Failure) -> EvalError {
    match failure {
        functions::Failure::TooLong => EvalError::Limit(LimitKind::TextSize),
        functions::Failure::Coercion => EvalError::Coercion(CoercionError),
    }
}

/// `{ ...eventData, chatter_user_id, chatter_user_login, chatter_user_name }`. Spreading text
/// gives one key per character (the reference: per UTF-16 unit).
fn reference_event_data(context: &Context) -> Value {
    let mut entries: Vec<(String, Value)> = match &context.event_data {
        Value::Object(entries) => entries.clone(),
        Value::List(items) => items
            .iter()
            .enumerate()
            .map(|(at, item)| (at.to_string(), item.clone()))
            .collect(),
        Value::Text(text) => text
            .chars()
            .enumerate()
            .map(|(at, ch)| (at.to_string(), Value::Text(ch.to_string())))
            .collect(),
        _ => Vec::new(),
    };
    let or = |first: &str, second: &str| -> String {
        if first.is_empty() {
            second.to_owned()
        } else {
            first.to_owned()
        }
    };
    let broadcaster = context.broadcaster_id.as_str();
    entries.push((
        "chatter_user_id".into(),
        Value::Text(or(&context.user_id, broadcaster)),
    ));
    entries.push((
        "chatter_user_login".into(),
        Value::Text(or(&context.user_login, broadcaster)),
    ));
    let name = or(
        &context.user_display_name,
        &or(&context.user_login, broadcaster),
    );
    entries.push(("chatter_user_name".into(), Value::Text(name)));
    Value::object(entries)
}

/// `JSON.stringify` of a list of texts.
fn json_of_texts(items: &[String]) -> String {
    let mut out = String::from("[");
    for (at, item) in items.iter().enumerate() {
        if at > 0 {
            out.push(',');
        }
        crate::value::write_json_string(item, &mut out);
    }
    out.push(']');
    out
}

/// `buildPermissionDeniedMessage`.
pub(crate) fn permission_denied(name: &str, required: f64, actual: f64) -> String {
    let role = match required {
        7.0 => "moderator".to_owned(),
        8.0 => "editor".to_owned(),
        9.0 => "admin".to_owned(),
        10.0 => "broadcaster".to_owned(),
        level => format!("level {}", dima_text::number_to_string(level)),
    };
    format!(
        "Error: permission denied - '{name}' requires {role} permissions (userlevel {}), but the requesting user only has userlevel {}. Do not retry this action; explain to the user that someone with the required role has to do it.",
        dima_text::number_to_string(required),
        dima_text::number_to_string(actual)
    )
}
