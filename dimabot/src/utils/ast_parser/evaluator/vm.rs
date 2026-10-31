use super::{
    context::{fork_loop_vars, loop_insert, permission_denied, shallow},
    storage::{self, DecodeCache},
    value::{math_round, number_string, safe_compare},
    *,
};
use crate::utils::ast_syntax::{
    ArrayAccessor, AstNode, HARD_NESTING_CEILING, TemplateSegment, VariableStorage,
};
use std::{cell::RefCell, rc::Rc};

pub(crate) fn validate(node: &AstNode) -> Result<(), EvalError> {
    let mut stack = vec![(node, 0usize)];
    while let Some((node, depth)) = stack.pop() {
        if depth >= HARD_NESTING_CEILING {
            return Err(EvalError::new("AST nesting limit exceeded"));
        }
        let mut push = |n| stack.push((n, depth + 1));
        match node {
            AstNode::Root { children }
            | AstNode::Function { args: children, .. }
            | AstNode::CommandRef { args: children, .. } => {
                for n in children {
                    push(n);
                }
            }
            AstNode::SetVar {
                value,
                accessor,
                user_selector,
                ..
            } => {
                push(value.as_ref());
                if let Some(n) = user_selector {
                    push(n.as_ref());
                }
                if let Some(n) = index_node(accessor.as_ref()) {
                    push(n);
                }
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
                if let Some(n) = user_selector {
                    push(n.as_ref());
                }
                if let Some(n) = index_node(accessor.as_ref()) {
                    push(n);
                }
            }
            AstNode::Binary { left, right, .. } => {
                push(left.as_ref());
                push(right.as_ref());
            }
            AstNode::Unary { argument, .. } => push(argument.as_ref()),
            AstNode::Ternary {
                test,
                consequent,
                alternate,
            } => {
                push(test.as_ref());
                push(consequent.as_ref());
                push(alternate.as_ref());
            }
            AstNode::Template { segments } => {
                for s in segments {
                    if let TemplateSegment::Expr { node } = s {
                        push(node);
                    }
                }
            }
            AstNode::ArrayLiteral { items, accessor } => {
                for n in items {
                    push(n);
                }
                if let Some(n) = index_node(accessor.as_ref()) {
                    push(n);
                }
            }
            AstNode::LoopAssign { value: Some(n), .. } => {
                push(n.as_ref());
            }
            AstNode::ForLoop {
                init,
                condition,
                update,
                iterable,
                body,
                ..
            } => {
                for n in [init, condition, update, iterable].into_iter().flatten() {
                    push(n.as_ref());
                }
                for n in body {
                    push(n);
                }
            }
            _ => {}
        }
    }
    Ok(())
}
fn index_node(accessor: Option<&ArrayAccessor>) -> Option<&AstNode> {
    match accessor {
        Some(
            ArrayAccessor::Index { index }
            | ArrayAccessor::SetIndex { index }
            | ArrayAccessor::Remove { index },
        ) => Some(index),
        _ => None,
    }
}
fn empty() -> JsValue {
    JsValue::string("")
}
fn boolean(b: bool) -> JsValue {
    JsValue::string(if b { "true" } else { "false" })
}
fn join(values: &[JsValue], separator: &str) -> JsString {
    let mut s = JsString::default();
    for (i, v) in values.iter().enumerate() {
        if i > 0 {
            s.push(&separator.into());
        }
        s.push(&js_string(v));
    }
    s
}
fn iterable(v: &JsValue) -> Vec<JsString> {
    match v {
        JsValue::Array(a) => a.borrow().iter().map(nullish_string).collect(),
        JsValue::String(s) => match json_parse(s) {
            Ok(JsValue::Array(a)) => a.borrow().iter().map(nullish_string).collect(),
            Err(_) => {
                if s.is_empty() {
                    Vec::new()
                } else {
                    vec![s.clone()]
                }
            }
            _ => vec![s.clone()],
        },
        JsValue::Undefined | JsValue::Null => Vec::new(),
        _ => vec![js_string(v)],
    }
}
fn assignment(current: Option<JsString>, op: &str, value: &JsValue) -> JsString {
    let old = JsValue::String(current.clone().unwrap_or_default());
    let next = nullish_string(value);
    match op {
        "++" => number_string(to_number_safe(&old) + 1.0).into(),
        "--" => number_string(to_number_safe(&old) - 1.0).into(),
        "=" => next,
        "+=" => {
            let l = to_number(&old);
            let r = to_number(&JsValue::String(next.clone()));
            if l.is_finite() && r.is_finite() {
                number_string(l + r).into()
            } else {
                let mut s = current.unwrap_or_default();
                s.push(&next);
                s
            }
        }
        "-=" | "*=" | "/=" | "%=" => {
            let l = to_number_safe(&old);
            let r = to_number_safe(&JsValue::String(next));
            number_string(match op {
                "-=" => l - r,
                "*=" => l * r,
                "/=" => {
                    if r == 0.0 {
                        0.0
                    } else {
                        l / r
                    }
                }
                _ => {
                    if r == 0.0 {
                        0.0
                    } else {
                        l % r
                    }
                }
            })
            .into()
        }
        _ => next,
    }
}

pub(crate) struct Vm<'a> {
    registry: &'a FunctionRegistry,
    pub stats: EvalStats,
    decoded: DecodeCache,
}
#[derive(Clone)]
enum Gather<'a> {
    Root,
    Function(&'a str),
    Array(Option<&'a ArrayAccessor>),
    Reference {
        name: String,
        depth: f64,
        visited: Rc<RefCell<Vec<String>>>,
        key: String,
    },
}
#[derive(Clone, Copy)]
enum VarOp<'a> {
    Get,
    Set(&'a AstNode),
    Exists,
    Delete,
}
struct Var<'a> {
    name: &'a str,
    storage: VariableStorage,
    accessor: Option<&'a ArrayAccessor>,
    op: VarOp<'a>,
    target: Option<JsString>,
    ctx: Context,
    original: Context,
}
impl Var<'_> {
    fn responses(&self) -> bool {
        self.name == "responses" && self.storage == VariableStorage::Memory
    }
}
enum IndexAction {
    Get,
    Exists,
    Set(JsString),
    DeleteMemory,
    DeleteDb,
    DeleteCache,
}
struct Loop<'a> {
    node: &'a AstNode,
    outer: Context,
    active: Context,
    depth: f64,
    max: usize,
    iterations: usize,
    items: Vec<JsString>,
    body_context: Option<Context>,
}
#[derive(Clone, Copy)]
enum LoopPhase {
    Initial,
    Check,
    AfterCondition,
    Body(usize),
    AfterBody(bool),
    AfterUpdate,
    NextItem,
}
enum Task<'a> {
    Eval(&'a AstNode, Context),
    Gather {
        kind: Gather<'a>,
        nodes: &'a [AstNode],
        index: usize,
        values: Vec<JsValue>,
        ctx: Context,
    },
    Template {
        segments: &'a [TemplateSegment],
        index: usize,
        output: JsString,
        ctx: Context,
        pending: bool,
    },
    BinaryLeft(&'a str, &'a AstNode),
    BinaryRight(&'a str, JsValue),
    Unary(&'a str),
    Ternary(&'a AstNode, &'a AstNode),
    Assign(&'a str, &'a str),
    ArrayIndex(Vec<JsValue>),
    VarStart(Var<'a>, bool),
    VarValue(Var<'a>),
    VarIndex(Var<'a>, Vec<JsValue>, IndexAction),
    Timer(&'a [AstNode], Context),
    Loop(Loop<'a>, LoopPhase),
    Catch(Context),
}
impl<'e> Vm<'e> {
    pub fn new(registry: &'e FunctionRegistry) -> Self {
        Self {
            registry,
            stats: EvalStats::default(),
            decoded: DecodeCache::default(),
        }
    }
    fn count_copy(&mut self, copied: bool) {
        if copied {
            self.stats.loop_map_copies = self.stats.loop_map_copies.saturating_add(1);
        }
    }
    async fn array<H: Host>(
        &mut self,
        v: &Var<'_>,
        host: &mut H,
    ) -> Result<Vec<JsValue>, EvalError> {
        if v.responses() {
            return Ok(v.ctx.borrow().command_responses.borrow().clone());
        }
        let raw =
            storage::read(host, &mut self.stats, v.name, v.storage, &v.ctx, &v.target).await?;
        Ok(self.decoded.array(&raw, &mut self.stats))
    }
    fn random<H: Host>(&mut self, values: &[JsValue], host: &mut H) -> Result<JsValue, EvalError> {
        if values.is_empty() {
            return Ok(empty());
        }
        self.stats.host_calls = self.stats.host_calls.saturating_add(1);
        let n = host.random()?;
        let index = (n * values.len() as f64).floor();
        Ok(if index >= 0.0 && index < (values.len() as f64) {
            values[index as usize].clone()
        } else {
            JsValue::Undefined
        })
    }
    pub async fn run<'a, H: Host>(
        &mut self,
        node: &'a AstNode,
        context: Context,
        host: &mut H,
    ) -> Result<(JsValue, Context), EvalError> {
        let mut tasks = vec![Task::Eval(node, context.clone())];
        let mut last = (empty(), context);
        // This macro preserves actual source catch scopes, including a thrown index
        // subtree in DB array deletion. There is no per-node async function/future.
        'run: while let Some(task) = tasks.pop() {
            macro_rules! attempt {
                ($expr:expr) => {
                    match $expr {
                        Ok(v) => v,
                        Err(error) => {
                            let mut caught = None;
                            while let Some(t) = tasks.pop() {
                                if let Task::Catch(ctx) = t {
                                    caught = Some(ctx);
                                    break;
                                }
                            }
                            if let Some(ctx) = caught {
                                last = (empty(), ctx);
                                continue 'run;
                            }
                            return Err(error);
                        }
                    }
                };
            }
            match task {
                Task::Eval(node, ctx) => {
                    self.stats.nodes = self.stats.nodes.saturating_add(1);
                    match node {
                        AstNode::Literal { value } => last = (JsValue::string(value), ctx),
                        AstNode::LiteralUtf16 { value } => last = (JsValue::String(value.0.clone()), ctx),
                        AstNode::Custom { custom_type, .. } => {
                            last = (
                                JsValue::string(format!(
                                    "[Custom node not implemented: {custom_type}]"
                                )),
                                ctx,
                            )
                        }
                        AstNode::LoopVar { name } => {
                            let value = ctx
                                .borrow()
                                .loop_vars
                                .as_ref()
                                .and_then(|v| v.get(name))
                                .unwrap_or_else(|| format!("#{name}").into());
                            last = (JsValue::String(value), ctx);
                        }
                        AstNode::LoopAssign {
                            name,
                            operator,
                            value,
                        } => {
                            tasks.push(Task::Assign(name, operator));
                            if let Some(value) = value {
                                tasks.push(Task::Eval(value, ctx));
                            } else {
                                last = (JsValue::Undefined, ctx);
                            }
                        }
                        AstNode::Binary {
                            operator,
                            left,
                            right,
                        } => {
                            tasks.push(Task::BinaryLeft(operator, right));
                            tasks.push(Task::Eval(left, ctx));
                        }
                        AstNode::Unary { operator, argument } => {
                            tasks.push(Task::Unary(operator));
                            tasks.push(Task::Eval(argument, ctx));
                        }
                        AstNode::Ternary {
                            test,
                            consequent,
                            alternate,
                        } => {
                            tasks.push(Task::Ternary(consequent, alternate));
                            tasks.push(Task::Eval(test, ctx));
                        }
                        AstNode::Root { children } => tasks.push(Task::Gather {
                            kind: Gather::Root,
                            nodes: children,
                            index: 0,
                            values: Vec::new(),
                            ctx,
                        }),
                        AstNode::Template { segments } => tasks.push(Task::Template {
                            segments,
                            index: 0,
                            output: JsString::default(),
                            ctx,
                            pending: false,
                        }),
                        AstNode::ArrayLiteral { items, accessor } => tasks.push(Task::Gather {
                            kind: Gather::Array(accessor.as_ref()),
                            nodes: items,
                            index: 0,
                            values: Vec::new(),
                            ctx,
                        }),
                        AstNode::Function { name, args } if name == "timer" => {
                            let fail = if args.len() < 2 {
                                Some("usage: $(timer seconds message_and_actions)")
                            } else if ctx.borrow().timer_depth.unwrap_or(0.0) >= 5.0 {
                                Some("maximum nested timer depth reached")
                            } else if ctx.borrow().broadcaster_id.is_empty()
                                || ctx.borrow().platform != "twitch"
                            {
                                Some("requires a Twitch channel")
                            } else {
                                None
                            };
                            if let Some(message) = fail {
                                last = (JsValue::string(format!("timer: {message}")), ctx);
                            } else {
                                let duration_ctx = shallow(&ctx);
                                duration_ctx.borrow_mut().effect_context = None;
                                tasks.push(Task::Timer(args, ctx));
                                tasks.push(Task::Eval(&args[0], duration_ctx));
                            }
                        }
                        AstNode::Function { name, args } => tasks.push(Task::Gather {
                            kind: Gather::Function(name),
                            nodes: args,
                            index: 0,
                            values: Vec::new(),
                            ctx,
                        }),
                        AstNode::CommandRef { command_name, args } => {
                            let name =
                                attempt!(JsString::from(command_name).trim().lower().to_utf8());
                            let (depth, visited, key, denied) = {
                                let c = ctx.borrow();
                                let depth = c.command_ref_depth.unwrap_or(0.0);
                                let visited = c.visited_commands.clone().unwrap_or_default();
                                let key = format!("{}:{name}", c.broadcaster_id);
                                let denied = depth >= 5.0
                                    || visited.borrow().contains(&key)
                                    || c.command_ref_budget.borrow().remaining <= 0.0;
                                (depth, visited, key, denied)
                            };
                            if denied {
                                last = (empty(), ctx);
                            } else {
                                tasks.push(Task::Gather {
                                    kind: Gather::Reference {
                                        name,
                                        depth,
                                        visited,
                                        key,
                                    },
                                    nodes: args,
                                    index: 0,
                                    values: Vec::new(),
                                    ctx,
                                });
                            }
                        }
                        AstNode::GetVar {
                            name,
                            storage,
                            accessor,
                            user_selector,
                        }
                        | AstNode::Exists {
                            name,
                            storage,
                            accessor,
                            user_selector,
                        }
                        | AstNode::DeleteVar {
                            name,
                            storage,
                            accessor,
                            user_selector,
                        } => {
                            let op = match node {
                                AstNode::GetVar { .. } => VarOp::Get,
                                AstNode::Exists { .. } => VarOp::Exists,
                                _ => VarOp::Delete,
                            };
                            let selector = if matches!(
                                storage,
                                VariableStorage::CacheUser | VariableStorage::DbUser
                            ) {
                                user_selector.as_deref()
                            } else {
                                None
                            };
                            tasks.push(Task::VarStart(
                                Var {
                                    name,
                                    storage: *storage,
                                    accessor: accessor.as_ref(),
                                    op,
                                    target: None,
                                    original: ctx.clone(),
                                    ctx: ctx.clone(),
                                },
                                selector.is_some(),
                            ));
                            if let Some(selector) = selector {
                                tasks.push(Task::Eval(selector, ctx));
                            }
                        }
                        AstNode::SetVar {
                            name,
                            storage,
                            accessor,
                            user_selector,
                            value,
                        } => {
                            let selector = if matches!(
                                storage,
                                VariableStorage::CacheUser | VariableStorage::DbUser
                            ) {
                                user_selector.as_deref()
                            } else {
                                None
                            };
                            tasks.push(Task::VarStart(
                                Var {
                                    name,
                                    storage: *storage,
                                    accessor: accessor.as_ref(),
                                    op: VarOp::Set(value),
                                    target: None,
                                    original: ctx.clone(),
                                    ctx: ctx.clone(),
                                },
                                selector.is_some(),
                            ));
                            if let Some(selector) = selector {
                                tasks.push(Task::Eval(selector, ctx));
                            }
                        }
                        AstNode::ForLoop {
                            mode,
                            init,
                            iterable,
                            ..
                        } => {
                            let (depth, max_depth, max) = {
                                let c = ctx.borrow();
                                let (md, mi) = match c.user_plan.as_str() {
                                    "premium" => (3.0, 50),
                                    "pro" => (4.0, 100),
                                    _ => (2.0, 25),
                                };
                                (c.loop_depth.unwrap_or(0.0), md, mi)
                            };
                            if depth >= max_depth {
                                last = (empty(), ctx);
                            } else {
                                let active = shallow(&ctx);
                                fork_loop_vars(&active);
                                {
                                    let mut c = active.borrow_mut();
                                    c.loop_depth = Some(depth + 1.0);
                                    c.loop_exit = None;
                                }
                                self.stats.loop_frames = self.stats.loop_frames.saturating_add(1);
                                let l = Loop {
                                    node,
                                    outer: ctx,
                                    active: active.clone(),
                                    depth: depth + 1.0,
                                    max,
                                    iterations: 0,
                                    items: Vec::new(),
                                    body_context: None,
                                };
                                if mode == "foreach" {
                                    tasks.push(Task::Loop(l, LoopPhase::Initial));
                                    if let Some(n) = iterable {
                                        tasks.push(Task::Eval(n, active));
                                    } else {
                                        last = (empty(), active);
                                    }
                                } else if let Some(n) = init {
                                    tasks.push(Task::Loop(l, LoopPhase::Initial));
                                    tasks.push(Task::Eval(n, active));
                                } else {
                                    tasks.push(Task::Loop(l, LoopPhase::Check));
                                }
                            }
                        }
                    }
                }
                Task::Assign(name, op) => {
                    let current = last.1.borrow().loop_vars.as_ref().and_then(|v| v.get(name));
                    let value = assignment(current, op, &last.0);
                    self.count_copy(loop_insert(&last.1, name, value.clone()));
                    last.0 = JsValue::String(value);
                }
                Task::BinaryLeft(op, right) => {
                    tasks.push(Task::BinaryRight(op, last.0.clone()));
                    tasks.push(Task::Eval(right, last.1.clone()));
                }
                Task::BinaryRight(op, left) => {
                    last.0 = if matches!(op, "+" | "-" | "*" | "/" | "%") {
                        let l = to_number_safe(&left);
                        let r = to_number_safe(&last.0);
                        let value = match op {
                            "+" => l + r,
                            "-" => l - r,
                            "*" => l * r,
                            "/" => {
                                if r == 0.0 {
                                    0.0
                                } else {
                                    l / r
                                }
                            }
                            _ => {
                                if r == 0.0 {
                                    0.0
                                } else {
                                    l % r
                                }
                            }
                        };
                        let value = if value.is_finite() && value.fract() == 0.0 {
                            value
                        } else {
                            math_round(value * 1_000_000.0) / 1_000_000.0
                        };
                        JsValue::string(number_string(value))
                    } else if matches!(
                        op,
                        "==" | "!=" | ">=" | "<=" | ">" | "<" | "=" | "~=" | "<>"
                    ) {
                        boolean(safe_compare(&left, op, &last.0))
                    } else {
                        empty()
                    };
                }
                Task::Unary(op) => {
                    let n = to_number_safe(&last.0);
                    last.0 = JsValue::string(number_string(if op == "-" { -n } else { n }));
                }
                Task::Ternary(yes, no) => tasks.push(Task::Eval(
                    if is_truthy(&last.0) { yes } else { no },
                    last.1.clone(),
                )),
                Task::Template {
                    segments,
                    mut index,
                    mut output,
                    mut ctx,
                    pending,
                } => {
                    if pending {
                        output.push(&nullish_string(&last.0));
                        ctx = last.1.clone();
                    }
                    while index < segments.len() {
                        match &segments[index] {
                            TemplateSegment::Text { value } => {
                                output.push(&value.into());
                                index += 1;
                            }
                            TemplateSegment::TextUtf16 { value } => {
                                output.push(&value.0);
                                index += 1;
                            }
                            TemplateSegment::Expr { node } => {
                                tasks.push(Task::Template {
                                    segments,
                                    index: index + 1,
                                    output,
                                    ctx: ctx.clone(),
                                    pending: true,
                                });
                                tasks.push(Task::Eval(node, ctx));
                                continue 'run;
                            }
                        }
                    }
                    last = (JsValue::String(output), ctx);
                }
                Task::Gather {
                    kind,
                    nodes,
                    index,
                    mut values,
                    mut ctx,
                } => {
                    if index > 0 {
                        ctx = last.1.clone();
                        match kind {
                            Gather::Root => {
                                if !matches!(last.0, JsValue::Undefined)
                                    && !last.0.is_empty_string()
                                {
                                    values.push(JsValue::String(js_string(&last.0)));
                                }
                            }
                            Gather::Array(_) | Gather::Reference { .. } => {
                                values.push(JsValue::String(nullish_string(&last.0)))
                            }
                            Gather::Function(_) => values.push(last.0.clone()),
                        }
                    }
                    if index < nodes.len() {
                        tasks.push(Task::Gather {
                            kind,
                            nodes,
                            index: index + 1,
                            values,
                            ctx: ctx.clone(),
                        });
                        tasks.push(Task::Eval(&nodes[index], ctx));
                        continue;
                    }
                    match kind {
                        Gather::Root => last = (JsValue::String(join(&values, " ")), ctx),
                        Gather::Function(name) => {
                            let Some(entry) = self.registry.get(name) else {
                                last =
                                    (JsValue::string(format!("[Unknown function: {name}]")), ctx);
                                continue;
                            };
                            let required = entry
                                .metadata
                                .as_ref()
                                .and_then(|m| m.min_user_level)
                                .unwrap_or(1.0);
                            let denied = ctx.borrow().enforce_function_permissions
                                && ctx.borrow().user_level < required;
                            if denied {
                                last = (
                                    JsValue::string(permission_denied(
                                        name,
                                        required,
                                        ctx.borrow().user_level,
                                    )),
                                    ctx.clone(),
                                );
                            } else {
                                let value = match entry.dispatch {
                                    registry::DispatchKind::Context => {
                                        registry::builtin(name, &values, &ctx)
                                    }
                                    #[cfg(feature = "ast-pure-functions")]
                                    registry::DispatchKind::Pure(function) => {
                                        attempt!(super::pure::dispatch(
                                            function,
                                            &values,
                                            &ctx,
                                            host,
                                            &mut self.stats
                                        ))
                                    }
                                    registry::DispatchKind::Host => attempt!(
                                        storage::call(
                                            host,
                                            &mut self.stats,
                                            HostRequest::Function {
                                                name: name.into(),
                                                args: values
                                            },
                                            &ctx
                                        )
                                        .await
                                    ),
                                };
                                last = (value, ctx);
                            }
                        }
                        Gather::Array(accessor) => match accessor {
                            Some(ArrayAccessor::Index { index }) => {
                                tasks.push(Task::ArrayIndex(values));
                                tasks.push(Task::Eval(index, ctx));
                            }
                            Some(ArrayAccessor::Length) => {
                                last = (JsValue::string(values.len().to_string()), ctx)
                            }
                            Some(ArrayAccessor::Random) => {
                                last = (attempt!(self.random(&values, host)), ctx)
                            }
                            _ => last = (JsValue::array(values), ctx),
                        },
                        Gather::Reference {
                            name,
                            depth,
                            visited,
                            key,
                        } => {
                            if ctx.borrow().command_ref_budget.borrow().remaining <= 0.0 {
                                last = (empty(), ctx);
                                continue;
                            }
                            ctx.borrow().command_ref_budget.borrow_mut().remaining -= 1.0;
                            let authorization = resolve_command_ref_authorization(&ctx);
                            let effect = {
                                let c = ctx.borrow();
                                if !c.enforce_function_permissions
                                    && matches!(c.authorization.get("origin"),JsValue::String(ref s)if s==&JsString::from("authored"))
                                {
                                    c.effect_context.clone()
                                } else {
                                    None
                                }
                            };
                            let effect_context = effect.as_ref().and_then(|e| {
                                self.stats.host_calls = self.stats.host_calls.saturating_add(1);
                                host.fork_effect(e)
                            });
                            let c = ctx.borrow();
                            let event_data = match &c.event_data {
                                JsValue::Object(o) => {
                                    let entries = o.borrow();
                                    JsValue::object(
                                        value::property_order(&entries)
                                            .into_iter()
                                            .map(|i| entries[i].clone())
                                            .collect(),
                                    )
                                }
                                JsValue::Array(a) => JsValue::object(
                                    a.borrow()
                                        .iter()
                                        .enumerate()
                                        .map(|(i, value)| (i.to_string().into(), value.clone()))
                                        .collect(),
                                ),
                                JsValue::String(s) => JsValue::object(
                                    s.units()
                                        .iter()
                                        .enumerate()
                                        .map(|(i, unit)| {
                                            (
                                                i.to_string().into(),
                                                JsValue::String(JsString::from_units(vec![*unit])),
                                            )
                                        })
                                        .collect(),
                                ),
                                _ => JsValue::object(Vec::new()),
                            };
                            let id = if c.user_id.is_empty() {
                                &c.broadcaster_id
                            } else {
                                &c.user_id
                            };
                            let login = if c.user_login.is_empty() {
                                &c.broadcaster_id
                            } else {
                                &c.user_login
                            };
                            let display = c.effective_user_display_name();
                            let display = if value::js_truthy(&display) {
                                display
                            } else {
                                JsValue::string(login)
                            };
                            event_data.set("chatter_user_id", JsValue::string(id));
                            event_data.set("chatter_user_login", JsValue::string(login));
                            event_data.set("chatter_user_name", display);
                            let mut visited = visited.borrow().clone();
                            if !visited.contains(&key) {
                                visited.push(key);
                            }
                            c.command_references.borrow_mut().push(CommandReference {
                                effect_context,
                                channel_id: c.broadcaster_id.clone(),
                                command_name: name,
                                argument: join(&values, " "),
                                event_data,
                                authorization,
                                state: CommandReferenceState {
                                    visited_commands: visited,
                                    command_ref_depth: depth + 1.0,
                                    command_ref_budget: c.command_ref_budget.clone(),
                                    timer_depth: c.timer_depth,
                                },
                            });
                            drop(c);
                            last = (empty(), ctx);
                        }
                    }
                }
                Task::ArrayIndex(values) => {
                    last.0 = resolve_array_index(&last.0, values.len())
                        .map(|i| values[i].clone())
                        .unwrap_or_else(empty);
                }
                Task::Timer(args, original) => {
                    let duration = last.1.clone();
                    let resumed = shallow(&duration);
                    resumed.borrow_mut().effect_context = original.borrow().effect_context.clone();
                    let seconds = to_number(&last.0);
                    if !seconds.is_finite() || !(1.0..=604800.0).contains(&seconds) {
                        last = (
                            JsValue::string("timer: seconds must be between 1 and 604800"),
                            resumed,
                        );
                    } else {
                        let result = storage::call(
                            host,
                            &mut self.stats,
                            HostRequest::ScheduleTimer {
                                seconds,
                                body: AstNode::Root {
                                    children: args[1..].to_vec(),
                                },
                            },
                            &duration,
                        )
                        .await;
                        last = (
                            if result.is_ok() {
                                empty()
                            } else {
                                JsValue::string("timer: could not schedule timer")
                            },
                            resumed,
                        );
                    }
                }
                Task::VarStart(mut v, selector) => {
                    if selector {
                        v.target = Some(nullish_string(&last.0).trim());
                        v.ctx = last.1.clone();
                    }
                    match v.op {
                        VarOp::Set(value) => {
                            let ctx = v.ctx.clone();
                            tasks.push(Task::VarValue(v));
                            tasks.push(Task::Eval(value, ctx));
                        }
                        VarOp::Get => {
                            if v.responses() {
                                v.ctx = v.original.clone();
                            }
                            if v.accessor.is_none() {
                                let value = if v.responses() {
                                    attempt!(storage::stringify_array(
                                        v.ctx.borrow().command_responses.borrow().clone()
                                    ))
                                } else {
                                    attempt!(
                                        storage::read(
                                            host,
                                            &mut self.stats,
                                            v.name,
                                            v.storage,
                                            &v.ctx,
                                            &v.target
                                        )
                                        .await
                                    )
                                };
                                last = (JsValue::String(value), v.ctx);
                                continue;
                            }
                            let values = attempt!(self.array(&v, host).await);
                            match v.accessor {
                                Some(ArrayAccessor::Array) => {
                                    last = (
                                        JsValue::String(attempt!(storage::stringify_array(values))),
                                        v.ctx,
                                    )
                                }
                                Some(ArrayAccessor::Length) => {
                                    last = (JsValue::string(values.len().to_string()), v.ctx)
                                }
                                Some(ArrayAccessor::Random) => {
                                    last = (attempt!(self.random(&values, host)), v.ctx)
                                }
                                Some(ArrayAccessor::Index { index }) => {
                                    let ctx = v.ctx.clone();
                                    tasks.push(Task::VarIndex(v, values, IndexAction::Get));
                                    tasks.push(Task::Eval(index, ctx));
                                }
                                _ => last = (empty(), v.ctx),
                            }
                        }
                        VarOp::Exists => {
                            if v.responses() {
                                v.ctx = v.original.clone();
                            }
                            let exists = if v.responses() {
                                !v.ctx.borrow().command_responses.borrow().is_empty()
                            } else {
                                attempt!(
                                    storage::exists(
                                        host,
                                        &mut self.stats,
                                        v.name,
                                        v.storage,
                                        &v.ctx,
                                        &v.target
                                    )
                                    .await
                                )
                            };
                            match v.accessor {
                                None | Some(ArrayAccessor::Array) => {
                                    last = (boolean(exists), v.ctx)
                                }
                                Some(ArrayAccessor::Length) => {
                                    last = (boolean(v.responses() || exists), v.ctx)
                                }
                                Some(ArrayAccessor::Index { index }) if exists || v.responses() => {
                                    let values = attempt!(self.array(&v, host).await);
                                    let ctx = v.ctx.clone();
                                    tasks.push(Task::VarIndex(v, values, IndexAction::Exists));
                                    tasks.push(Task::Eval(index, ctx));
                                }
                                Some(ArrayAccessor::Random) if exists => {
                                    let values = attempt!(self.array(&v, host).await);
                                    last = (boolean(!values.is_empty()), v.ctx);
                                }
                                _ => last = (boolean(false), v.ctx),
                            }
                        }
                        VarOp::Delete => {
                            use VariableStorage::*;
                            let clear = matches!(v.accessor, Some(ArrayAccessor::Clear));
                            let remove = matches!(v.accessor, Some(ArrayAccessor::Remove { .. }));
                            if v.accessor.is_none()
                                || (clear && matches!(v.storage, Memory | Cache | CacheUser))
                            {
                                attempt!(
                                    storage::delete(
                                        host,
                                        &mut self.stats,
                                        v.name,
                                        v.storage,
                                        &v.ctx,
                                        &v.target
                                    )
                                    .await
                                );
                                last = (empty(), v.ctx);
                                continue;
                            }
                            if !remove && !clear {
                                last = (empty(), v.ctx);
                                continue;
                            }
                            if matches!(v.storage, Cache | CacheUser) {
                                let index = index_node(v.accessor).expect("remove accessor");
                                let ctx = v.ctx.clone();
                                tasks.push(Task::VarIndex(v, Vec::new(), IndexAction::DeleteCache));
                                tasks.push(Task::Eval(index, ctx));
                                continue;
                            }
                            let raw = if v.storage == Memory {
                                v.ctx
                                    .borrow()
                                    .variables
                                    .borrow()
                                    .get(storage::strip(v.name, v.storage))
                                    .map(js_string)
                                    .unwrap_or_default()
                            } else {
                                attempt!(
                                    storage::read(
                                        host,
                                        &mut self.stats,
                                        v.name,
                                        v.storage,
                                        &v.ctx,
                                        &v.target
                                    )
                                    .await
                                )
                            };
                            let parsed = json_parse(&raw);
                            let valid = matches!(parsed, Ok(JsValue::Array(_)));
                            let values = match parsed {
                                Ok(JsValue::Array(a)) => a.borrow().clone(),
                                _ => Vec::new(),
                            };
                            if v.storage != Memory && !valid {
                                last = (empty(), v.ctx);
                                continue;
                            }
                            if clear {
                                let value = attempt!(storage::stringify_array(Vec::new()));
                                let _ = storage::save(
                                    host,
                                    &mut self.stats,
                                    v.name,
                                    v.storage,
                                    value,
                                    &v.ctx,
                                    &v.target,
                                )
                                .await;
                                last = (empty(), v.ctx);
                                continue;
                            }
                            let index = index_node(v.accessor).expect("remove accessor");
                            let ctx = v.ctx.clone();
                            let action = if v.storage == Memory {
                                IndexAction::DeleteMemory
                            } else {
                                tasks.push(Task::Catch(ctx.clone()));
                                IndexAction::DeleteDb
                            };
                            tasks.push(Task::VarIndex(v, values, action));
                            tasks.push(Task::Eval(index, ctx));
                        }
                    }
                }
                Task::VarValue(mut v) => {
                    v.ctx = last.1.clone();
                    let value = js_string(&last.0);
                    let append = match &last.0 {
                        JsValue::Array(a) => a
                            .borrow()
                            .iter()
                            .map(|v| JsValue::String(js_string(v)))
                            .collect::<Vec<_>>(),
                        _ => vec![JsValue::String(value.clone())],
                    };
                    if v.responses() {
                        match v.accessor {
                            Some(ArrayAccessor::Append) => {
                                v.original
                                    .borrow()
                                    .command_responses
                                    .borrow_mut()
                                    .extend(append);
                                attempt!(
                                    storage::call(
                                        host,
                                        &mut self.stats,
                                        HostRequest::SaveResponses,
                                        &v.original
                                    )
                                    .await
                                );
                                last = (empty(), v.ctx);
                            }
                            Some(ArrayAccessor::SetIndex { index }) => {
                                let ctx = v.ctx.clone();
                                tasks.push(Task::VarIndex(v, Vec::new(), IndexAction::Set(value)));
                                tasks.push(Task::Eval(index, ctx));
                            }
                            _ => last = (empty(), v.ctx),
                        }
                        continue;
                    }
                    if v.accessor.is_none() {
                        attempt!(
                            storage::save(
                                host,
                                &mut self.stats,
                                v.name,
                                v.storage,
                                value,
                                &v.ctx,
                                &v.target
                            )
                            .await
                        );
                        last = (empty(), v.ctx);
                        continue;
                    }
                    let mut values = attempt!(self.array(&v, host).await);
                    match v.accessor {
                        Some(ArrayAccessor::Append) => {
                            values.extend(append);
                            let value = attempt!(storage::stringify_array(values));
                            attempt!(
                                storage::save(
                                    host,
                                    &mut self.stats,
                                    v.name,
                                    v.storage,
                                    value,
                                    &v.ctx,
                                    &v.target
                                )
                                .await
                            );
                            last = (empty(), v.ctx);
                        }
                        Some(ArrayAccessor::SetIndex { index }) => {
                            let ctx = v.ctx.clone();
                            tasks.push(Task::VarIndex(v, values, IndexAction::Set(value)));
                            tasks.push(Task::Eval(index, ctx));
                        }
                        _ => last = (empty(), v.ctx),
                    }
                }
                Task::VarIndex(v, mut values, action) => {
                    let index_value = last.0.clone();
                    let index_ctx = last.1.clone();
                    if v.responses()
                        && matches!(
                            action,
                            IndexAction::Get | IndexAction::Exists | IndexAction::Set(_)
                        )
                    {
                        values = v.original.borrow().command_responses.borrow().clone();
                    }
                    let index = resolve_array_index(&index_value, values.len());
                    match action {
                        IndexAction::Get => {
                            last = (
                                index.map(|i| values[i].clone()).unwrap_or_else(empty),
                                v.ctx,
                            )
                        }
                        IndexAction::Exists => last = (boolean(index.is_some()), index_ctx),
                        IndexAction::Set(value) => {
                            if let Some(i) = index {
                                if v.responses() {
                                    v.original.borrow().command_responses.borrow_mut()[i] =
                                        JsValue::String(value);
                                    attempt!(
                                        storage::call(
                                            host,
                                            &mut self.stats,
                                            HostRequest::SaveResponses,
                                            &v.original
                                        )
                                        .await
                                    );
                                } else {
                                    values[i] = JsValue::String(value);
                                    let value = attempt!(storage::stringify_array(values));
                                    attempt!(
                                        storage::save(
                                            host,
                                            &mut self.stats,
                                            v.name,
                                            v.storage,
                                            value,
                                            &index_ctx,
                                            &v.target
                                        )
                                        .await
                                    );
                                }
                            }
                            last = (empty(), index_ctx);
                        }
                        IndexAction::DeleteMemory => {
                            if let Some(i) = index {
                                values.remove(i);
                                let value = attempt!(storage::stringify_array(values));
                                v.ctx.borrow().variables.borrow_mut().insert(
                                    storage::strip(v.name, v.storage).into(),
                                    JsValue::String(value),
                                );
                            }
                            last = (empty(), v.ctx);
                        }
                        IndexAction::DeleteDb => {
                            if let Some(i) = index {
                                values.remove(i);
                            }
                            let value = attempt!(storage::stringify_array(values));
                            attempt!(
                                storage::save(
                                    host,
                                    &mut self.stats,
                                    v.name,
                                    v.storage,
                                    value,
                                    &v.ctx,
                                    &v.target
                                )
                                .await
                            );
                            last = (empty(), v.ctx);
                        }
                        IndexAction::DeleteCache => {
                            for key in storage::cache_keys(v.name, v.storage, &v.ctx, &v.target) {
                                let value = attempt!(
                                    storage::call(
                                        host,
                                        &mut self.stats,
                                        HostRequest::CacheGet { key: key.clone() },
                                        &v.ctx
                                    )
                                    .await
                                );
                                if !value::js_truthy(&value) {
                                    continue;
                                }
                                if let Ok(JsValue::Array(a)) = json_parse(&js_string(&value)) {
                                    let mut a = a.borrow().clone();
                                    if let Some(i) = resolve_array_index(&index_value, a.len()) {
                                        a.remove(i);
                                        if let Ok(value) = storage::stringify_array(a)
                                            && storage::call(
                                                host,
                                                &mut self.stats,
                                                HostRequest::CacheSet {
                                                    key: key.clone(),
                                                    value,
                                                },
                                                &v.ctx,
                                            )
                                            .await
                                            .is_ok()
                                        {
                                            let _ = storage::call(
                                                host,
                                                &mut self.stats,
                                                HostRequest::CacheExpire {
                                                    key,
                                                    seconds: 86400,
                                                },
                                                &v.ctx,
                                            )
                                            .await;
                                        }
                                    }
                                }
                            }
                            last = (empty(), v.ctx);
                        }
                    }
                }
                Task::Catch(_) => {}
                Task::Loop(mut l, phase) => {
                    let AstNode::ForLoop {
                        loop_var,
                        mode,
                        condition,
                        update,
                        body,
                        ..
                    } = l.node
                    else {
                        unreachable!()
                    };
                    let finish = |l: Loop<'a>| {
                        let result = shallow(&l.active);
                        {
                            let outer = l.outer.borrow();
                            let mut c = result.borrow_mut();
                            c.loop_depth = outer.loop_depth;
                            c.loop_exit = None;
                            c.loop_vars = outer.loop_vars.clone();
                        }
                        (empty(), result)
                    };
                    match phase {
                        LoopPhase::Initial => {
                            l.active = shallow(&last.1);
                            fork_loop_vars(&l.active);
                            {
                                let mut c = l.active.borrow_mut();
                                c.loop_depth = Some(l.depth);
                                c.loop_exit = None;
                            }
                            if mode == "foreach" {
                                l.items = iterable(&last.0);
                                tasks.push(Task::Loop(l, LoopPhase::NextItem));
                            } else {
                                tasks.push(Task::Loop(l, LoopPhase::Check));
                            }
                        }
                        LoopPhase::Check => {
                            if l.iterations >= l.max {
                                last = finish(l);
                            } else if let Some(n) = condition {
                                let ctx = l.active.clone();
                                tasks.push(Task::Loop(l, LoopPhase::AfterCondition));
                                tasks.push(Task::Eval(n, ctx));
                            } else {
                                tasks.push(Task::Loop(l, LoopPhase::Body(0)));
                            }
                        }
                        LoopPhase::AfterCondition => {
                            l.active = shallow(&last.1);
                            fork_loop_vars(&l.active);
                            {
                                let mut c = l.active.borrow_mut();
                                c.loop_depth = Some(l.depth);
                                c.loop_exit = None;
                            }
                            if !is_truthy(&last.0) {
                                last = finish(l);
                            } else {
                                tasks.push(Task::Loop(l, LoopPhase::Body(0)));
                            }
                        }
                        LoopPhase::NextItem => {
                            if l.iterations >= l.max || l.iterations >= l.items.len() {
                                last = finish(l);
                            } else {
                                self.count_copy(loop_insert(
                                    &l.active,
                                    loop_var,
                                    l.items[l.iterations].clone(),
                                ));
                                tasks.push(Task::Loop(l, LoopPhase::Body(0)));
                            }
                        }
                        LoopPhase::Body(index) => {
                            if index == 0 {
                                let ctx = shallow(&l.active);
                                fork_loop_vars(&ctx);
                                ctx.borrow_mut().loop_exit = None;
                                l.body_context = Some(ctx);
                                self.stats.loop_frames = self.stats.loop_frames.saturating_add(1);
                            } else {
                                let b = l.body_context.as_ref().expect("body context");
                                let (vars, exit) = {
                                    let c = last.1.borrow();
                                    (
                                        c.loop_vars
                                            .as_ref()
                                            .map(LoopVars::fork)
                                            .unwrap_or_default(),
                                        c.loop_exit,
                                    )
                                };
                                {
                                    let mut c = b.borrow_mut();
                                    c.loop_vars = Some(vars);
                                    c.loop_exit = exit;
                                }
                                l.active = shallow(&last.1);
                                {
                                    let mut c = l.active.borrow_mut();
                                    c.loop_depth = Some(l.depth);
                                    c.loop_vars = b.borrow().loop_vars.as_ref().map(LoopVars::fork);
                                    c.loop_exit = exit;
                                }
                                if let Some(exit) = exit {
                                    l.active.borrow_mut().loop_exit = None;
                                    tasks.push(Task::Loop(
                                        l,
                                        LoopPhase::AfterBody(exit == LoopExit::Break),
                                    ));
                                    continue;
                                }
                            }
                            if index < body.len() {
                                let ctx = l.body_context.as_ref().expect("body context").clone();
                                tasks.push(Task::Loop(l, LoopPhase::Body(index + 1)));
                                tasks.push(Task::Eval(&body[index], ctx));
                            } else {
                                l.active.borrow_mut().loop_exit = None;
                                tasks.push(Task::Loop(l, LoopPhase::AfterBody(false)));
                            }
                        }
                        LoopPhase::AfterBody(breaking) => {
                            l.iterations += 1;
                            self.stats.loop_iterations =
                                self.stats.loop_iterations.saturating_add(1);
                            if breaking {
                                last = finish(l);
                            } else if mode == "foreach" {
                                tasks.push(Task::Loop(l, LoopPhase::NextItem));
                            } else if let Some(n) = update {
                                let ctx = l.active.clone();
                                tasks.push(Task::Loop(l, LoopPhase::AfterUpdate));
                                tasks.push(Task::Eval(n, ctx));
                            } else {
                                tasks.push(Task::Loop(l, LoopPhase::Check));
                            }
                        }
                        LoopPhase::AfterUpdate => {
                            l.active = shallow(&last.1);
                            fork_loop_vars(&l.active);
                            {
                                let mut c = l.active.borrow_mut();
                                c.loop_depth = Some(l.depth);
                                c.loop_exit = None;
                            }
                            tasks.push(Task::Loop(l, LoopPhase::Check));
                        }
                    }
                }
            }
        }
        Ok(last)
    }
}
