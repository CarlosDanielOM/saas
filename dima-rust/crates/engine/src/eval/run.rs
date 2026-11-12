//! One evaluation: `evaluate()` of `evaluator.ts`, node by node.

use super::coerce::{
    arithmetic, compare, is_truthy, loop_assignment, resolve_array_index, to_number_safe,
};
use super::frame::{Frames, Scalars};
use super::stack::StackBase;
use super::{Engine, EvalError, EvalStats, LimitKind};
use crate::context::{
    BudgetSnapshot, CommandReference, Context, LoopExit, Origin, ReferenceAuthorization,
    ReferenceOrigin, ReferenceState, State, TimerSnapshot,
};
use crate::functions::{self, Counters};
use crate::host::{Host, HostCall, HostFuture};
use crate::map::OrderedMap;
use crate::registry::{Builtin, FunctionKind};
use crate::syntax::{
    ArrayAccessor, AstNode, BinaryOp, LoopAssignOp, LoopMode, TemplateSegment, UnaryOp,
    VariableStorage,
};
use crate::value::Value;
use dima_text::{to_lower, trim};

/// `MAX_TIMER_DEPTH`.
const MAX_TIMER_DEPTH: u32 = 5;
/// `MAX_TIMER_SECONDS` (seven days).
const MAX_TIMER_SECONDS: f64 = 604_800.0;
/// Command references nest at most this deep (`depth >= 5`).
const MAX_REFERENCE_DEPTH: u32 = 5;

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
    /// Where the current poll's stack started.
    stack: StackBase,
}

/// Whether `node` nests deeper than `limit` (checked without recursion, so a tree the parser
/// accepted at any depth is measured safely).
pub(super) fn depth_exceeds(node: &AstNode, limit: usize) -> bool {
    let mut pending = vec![(node, 1usize)];
    while let Some((node, depth)) = pending.pop() {
        if depth > limit {
            return true;
        }
        children(node, |child| pending.push((child, depth + 1)));
    }
    false
}

fn accessor_index(accessor: Option<&ArrayAccessor>) -> Option<&AstNode> {
    match accessor {
        Some(
            ArrayAccessor::Index { index }
            | ArrayAccessor::SetIndex { index }
            | ArrayAccessor::Remove { index },
        ) => Some(index),
        _ => None,
    }
}

/// Calls `visit` with each child of `node`.
fn children<'a>(node: &'a AstNode, mut visit: impl FnMut(&'a AstNode)) {
    match node {
        AstNode::Root { children: nodes }
        | AstNode::Function { args: nodes, .. }
        | AstNode::CommandRef { args: nodes, .. } => nodes.iter().for_each(visit),
        AstNode::ArrayLiteral { items, accessor } => {
            items.iter().for_each(&mut visit);
            accessor_index(accessor.as_ref())
                .into_iter()
                .for_each(visit);
        }
        AstNode::SetVar {
            value,
            accessor,
            user_selector,
            ..
        } => {
            visit(value);
            user_selector.as_deref().into_iter().for_each(&mut visit);
            accessor_index(accessor.as_ref())
                .into_iter()
                .for_each(visit);
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
            user_selector.as_deref().into_iter().for_each(&mut visit);
            accessor_index(accessor.as_ref())
                .into_iter()
                .for_each(visit);
        }
        AstNode::Binary { left, right, .. } => {
            visit(left);
            visit(right);
        }
        AstNode::Unary { argument, .. } => visit(argument),
        AstNode::Ternary {
            test,
            consequent,
            alternate,
        } => {
            visit(test);
            visit(consequent);
            visit(alternate);
        }
        AstNode::Template { segments } => {
            for segment in segments {
                if let TemplateSegment::Expr { node } = segment {
                    visit(node);
                }
            }
        }
        AstNode::LoopAssign { value, .. } => value.as_deref().into_iter().for_each(visit),
        AstNode::ForLoop {
            init,
            condition,
            update,
            iterable,
            body,
            ..
        } => {
            for part in [init, condition, update, iterable].into_iter().flatten() {
                visit(part);
            }
            body.iter().for_each(visit);
        }
        AstNode::Literal { .. } | AstNode::LoopVar { .. } | AstNode::Custom { .. } => {}
    }
}

/// `parseIterableValue`: a list's items, a JSON list's items, otherwise the text as one item
/// (none for empty text, `null` and `undefined`).
fn iterable_values(value: Value) -> Vec<String> {
    match value {
        Value::List(items) => items
            .iter()
            .map(|item| item.to_text_or_empty().into_owned())
            .collect(),
        Value::Text(text) => match Value::parse_json(&text) {
            Some(Value::List(items)) => items
                .iter()
                .map(|item| item.to_text_or_empty().into_owned())
                .collect(),
            Some(_) => vec![text],
            None if text.is_empty() => Vec::new(),
            None => vec![text],
        },
        Value::Undefined | Value::Null => Vec::new(),
        other => vec![other.into_text()],
    }
}

/// `String(value ?? '')`, reusing text.
fn text_of(value: Value) -> String {
    match value {
        Value::Text(text) => text,
        other => other.to_text_or_empty().into_owned(),
    }
}

/// Arithmetic or comparison of two evaluated operands.
fn binary_result(operator: BinaryOp, left: &Value, right: &Value) -> Value {
    match operator {
        BinaryOp::Add
        | BinaryOp::Subtract
        | BinaryOp::Multiply
        | BinaryOp::Divide
        | BinaryOp::Modulo => Value::Text(arithmetic(
            operator,
            to_number_safe(left),
            to_number_safe(right),
        )),
        _ => Value::flag(compare(&left.to_text(), operator, &right.to_text())),
    }
}

/// A root keeps every value but `undefined` and empty text, joined by spaces.
fn push_root_value(out: &mut String, first: &mut bool, value: &Value) -> bool {
    if matches!(value, Value::Undefined) || value.as_str() == Some("") {
        return false;
    }
    if !*first {
        out.push(' ');
    }
    *first = false;
    out.push_str(&value.to_text());
    true
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
        stack: StackBase,
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
            stack,
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
    /// limit as a guard (the stack grows with it: every level polls the one below).
    pub(super) async fn child(&mut self, node: &AstNode) -> Result<Value, EvalError> {
        self.step()?;
        match node {
            AstNode::Literal { value } => return Ok(Value::Text(value.clone())),
            AstNode::LoopVar { name } => return Ok(Value::Text(self.loop_var(name))),
            _ => {}
        }
        if self.depth >= self.engine.limits.nesting
            || self.stack.used() > self.engine.limits.stack_bytes
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
        Ok(text_of(self.child(node).await?))
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
        let resolved = loop_assignment(current, operator, &next);
        self.check_size(resolved.len())?;
        self.frames
            .loop_vars
            .insert(name.to_owned(), resolved.clone());
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
        Ok(binary_result(operator, &left, &right))
    }

    async fn unary(&mut self, operator: UnaryOp, argument: &AstNode) -> Result<Value, EvalError> {
        let number = to_number_safe(&self.child(argument).await?);
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
        let branch = if is_truthy(&test) {
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
                TemplateSegment::Text { value } => out.push_str(value),
                TemplateSegment::Expr { node } => {
                    let value = self.child(node).await?;
                    out.push_str(&value.to_text_or_empty());
                }
            }
            self.check_size(out.len())?;
        }
        Ok(Value::Text(out))
    }

    async fn array_literal(
        &mut self,
        items: &[AstNode],
        accessor: Option<&ArrayAccessor>,
    ) -> Result<Value, EvalError> {
        let mut values = Vec::with_capacity(items.len());
        for item in items {
            let value = self.child(item).await?;
            values.push(text_of(value));
        }
        Ok(match accessor {
            Some(ArrayAccessor::Index { index }) => {
                let index = self.child(index).await?;
                match resolve_array_index(&index, values.len()) {
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
            if !push_root_value(&mut out, &mut first, &value) {
                continue;
            }
            self.check_size(out.len())?;
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
                None | Some(ArrayAccessor::Array) => Value::Text(json_of_texts(responses)),
                Some(ArrayAccessor::Index { index }) => {
                    let index = self.discarded(index).await?;
                    let responses = &self.state.command_responses;
                    resolve_array_index(&index, responses.len())
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
                match resolve_array_index(&index, list.len()) {
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
        let text = value.to_text().into_owned();
        let appended: Vec<String> = match &value {
            Value::List(items) => items
                .iter()
                .map(|item| item.to_text().into_owned())
                .collect(),
            _ => vec![text.clone()],
        };
        if Self::responses(name, storage) {
            match accessor {
                Some(ArrayAccessor::Append) => {
                    self.state.command_responses.extend(appended);
                    let total: usize = self.state.command_responses.iter().map(String::len).sum();
                    self.check_size(total)?;
                    self.save_responses().await?;
                }
                Some(ArrayAccessor::SetIndex { index }) => {
                    let index = self.child(index).await?;
                    if let Some(at) =
                        resolve_array_index(&index, self.state.command_responses.len())
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
                    resolve_array_index(&index, list.len()).and_then(|at| list.get_mut(at))
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
                    resolve_array_index(&index, self.state.command_responses.len()).is_some()
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
                    resolve_array_index(&index, list.len()).is_some()
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
        let json = Value::list_to_json(list);
        self.charge_bytes(json.len())?;
        self.check_size(json.len())?;
        Ok(json)
    }

    // ---- functions ----

    async fn args(&mut self, nodes: &[AstNode]) -> Result<Vec<Value>, EvalError> {
        let mut values = Vec::with_capacity(nodes.len());
        for node in nodes {
            values.push(self.child(node).await?);
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
            FunctionKind::Builtin(Builtin::Delay) => match functions::delay_millis(&args) {
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
                    draw = Some(self.random()?);
                }
                let scalars = &mut self.frames.scalars;
                let counters = Counters {
                    count: &mut scalars.count,
                    count_modified: &mut scalars.count_modified,
                    loop_exit: &mut scalars.loop_exit,
                };
                let mut random = || draw.unwrap_or(0.0);
                Ok(functions::run(
                    builtin,
                    &args,
                    self.context,
                    counters,
                    &mut random,
                ))
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
        let seconds = duration?.to_number();
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
        self.frames.loop_vars = outer_vars;
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
            for item in iterable_values(value) {
                if iterations >= max {
                    break;
                }
                self.frames.loop_vars.insert(loop_var.to_owned(), item);
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
                if !is_truthy(&test) {
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
        for arg in args {
            values.push(self.child_text(arg).await?);
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
        self.check_size(argument.len())?;
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

    /// `resolveCommandRefAuthorization`.
    fn reference_authorization(&self) -> ReferenceAuthorization {
        let context = self.context;
        let permissions = &self.engine.permissions;
        if !context.enforce_function_permissions {
            return ReferenceAuthorization {
                origin: ReferenceOrigin::Authored,
                identity: permissions.broadcaster_identity(),
            };
        }
        let fallback = if context.user_level.is_finite() {
            context.user_level.trunc().clamp(1.0, 10.0) as u8
        } else {
            1
        };
        let identity = match context
            .authorization
            .as_ref()
            .and_then(|a| a.identity.as_ref())
        {
            Some(raw) if raw.js_truthy() => permissions.parse_identity(raw, fallback),
            _ => permissions.user_identity(fallback),
        };
        ReferenceAuthorization {
            origin: ReferenceOrigin::Llm,
            identity,
        }
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
