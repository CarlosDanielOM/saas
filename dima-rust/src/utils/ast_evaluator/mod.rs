//! Opt-in DEFAULT AST evaluator. No runtime adapters, singleton, worker wiring
//! or output cache. Compile exact post-substitution source once, then supply a
//! fresh context and explicit host for each sequential run.
mod context;
mod host;
#[cfg(feature = "ast-pure-functions")]
mod pure;
mod registry;
mod storage;
pub mod value;
mod vm;
use crate::utils::ast_syntax::{
    AstNode, CompiledProgram, CompiledTemplate, Diagnostic, SourceSegment, SyntaxEngine,
};
pub use context::*;
pub use host::*;
pub use registry::*;
pub use value::{
    JsString, JsValue, is_truthy, js_string, json_parse, json_stringify, nullish_string,
    resolve_array_index, to_number, to_number_safe,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvalError {
    pub name: String,
    pub message: String,
}
impl EvalError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            name: "Error".into(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for EvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for EvalError {}
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct EvalStats {
    pub nodes: u64,
    pub host_calls: u64,
    pub host_futures: u64,
    pub array_decodes: u64,
    pub array_cache_hits: u64,
    pub loop_frames: u64,
    pub loop_iterations: u64,
    pub loop_map_copies: u64,
    pub node_futures: u64,
}
#[derive(Clone, Debug)]
pub struct EvalResult {
    pub value: JsValue,
    pub context: Context,
    pub stats: EvalStats,
}
#[derive(Clone, Debug)]
pub struct RenderResult {
    pub text: JsString,
    pub context: Context,
    pub stats: EvalStats,
}
#[derive(Clone, Debug)]
pub struct Engine {
    syntax: SyntaxEngine,
    registry: FunctionRegistry,
}
impl Default for Engine {
    fn default() -> Self {
        Self::new(FunctionRegistry::default())
    }
}
impl Engine {
    pub fn new(registry: FunctionRegistry) -> Self {
        Self {
            syntax: SyntaxEngine::typescript_compatible(),
            registry,
        }
    }
    /// Explicitly select an existing syntax profile or prepared grammar.
    /// `new` and `default` retain TypeScript-compatible syntax; compiled
    /// templates must still match this engine's grammar, profile and limits.
    pub fn with_syntax(registry: FunctionRegistry, syntax: SyntaxEngine) -> Self {
        Self { syntax, registry }
    }
    pub fn syntax(&self) -> &SyntaxEngine {
        &self.syntax
    }
    pub fn registry(&self) -> &FunctionRegistry {
        &self.registry
    }
    pub fn compile_template(&self, source: &str) -> Result<CompiledTemplate, Diagnostic> {
        self.syntax.compile_template(source)
    }
    pub fn compile_program(&self, source: &str) -> Result<CompiledProgram, Diagnostic> {
        self.syntax.parse(source)
    }
    pub async fn evaluate<H: Host>(
        &self,
        node: &AstNode,
        context: Context,
        host: &mut H,
    ) -> Result<EvalResult, EvalError> {
        vm::validate(node)?;
        let mut vm = vm::Vm::new(&self.registry);
        let (value, context) = vm.run(node, context, host).await?;
        Ok(EvalResult {
            value,
            context,
            stats: vm.stats,
        })
    }
    pub async fn evaluate_program<H: Host>(
        &self,
        program: &CompiledProgram,
        context: Context,
        host: &mut H,
    ) -> Result<EvalResult, EvalError> {
        {
            let mut vm = vm::Vm::new(&self.registry);
            let (value, context) = vm.run(program.root(), context, host).await?;
            Ok(EvalResult {
                value,
                context,
                stats: vm.stats,
            })
        }
    }
    pub async fn render<H: Host>(
        &self,
        template: &CompiledTemplate,
        mut context: Context,
        host: &mut H,
    ) -> Result<RenderResult, EvalError> {
        if !template.is_compatible_with(&self.syntax, template.source()) {
            return Err(EvalError::new(
                "Incompatible compiled template profile or grammar",
            ));
        }
        let mut vm = vm::Vm::new(&self.registry);
        let mut text = JsString::default();
        for segment in template.segments() {
            match segment.source_segment() {
                SourceSegment::Text { text: s, .. } => text.push(&s.into()),
                SourceSegment::Unclosed { .. } => {
                    text.push(&"[Parse error: Unclosed expression]".into());
                    break;
                }
                SourceSegment::Expr { .. } => match segment.program() {
                    Some(Ok(program)) => {
                        let (value, next) = vm.run(program.root(), context, host).await?;
                        context = next;
                        text.push(&nullish_string(&value));
                    }
                    Some(Err(error)) => {
                        text.push(&format!("[Parse error: {}]", error.message).into())
                    }
                    None => {}
                },
            }
        }
        Ok(RenderResult {
            text,
            context,
            stats: vm.stats,
        })
    }
}
#[cfg(test)]
mod tests;
