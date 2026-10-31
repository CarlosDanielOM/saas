#![cfg(any(feature = "ast-blocks", feature = "ast-evaluator"))]

use dima_rust::utils::ast_syntax::{
    AstNode, JsString, PersistedJsString, SourceSpan, SyntaxEngine, TemplateSegment,
};

#[cfg(feature = "ast-evaluator")]
use dima_rust::utils::ast_evaluator::{
    Context, Engine, EvalError, ExecutionContext, FunctionRegistry, Host, HostFuture, HostRequest,
    JsValue,
};
#[cfg(feature = "ast-evaluator")]
use std::{
    future::Future,
    task::{Context as TaskContext, Poll, Waker},
};

#[cfg(feature = "ast-evaluator")]
fn run<T>(future: impl Future<Output = T>) -> T {
    let mut context = TaskContext::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
}

#[cfg(feature = "ast-evaluator")]
#[test]
fn persisted_utf16_ast_and_vm_keep_exact_units() {
    let ast = AstNode::Template { segments: vec![
        TemplateSegment::TextUtf16 { value: PersistedJsString(JsString::from_units(vec![65, 0xd800])) },
        TemplateSegment::Expr { node: AstNode::LiteralUtf16 { value: PersistedJsString(JsString::from_units(vec![0xdc00, 66])) } },
    ] };
    let json = serde_json::to_value(&ast).unwrap();
    assert_eq!(json["segments"][0]["type"], "textUtf16");
    assert_eq!(json["segments"][1]["node"]["type"], "literalUtf16");
    let restored: AstNode = serde_json::from_value(json).unwrap();
    assert_eq!(restored, ast);
    let result = run(Engine::new(FunctionRegistry::default()).evaluate(
        &restored, ExecutionContext::default().into_context(), &mut ReturnString("".into()),
    )).unwrap();
    match result.value {
        JsValue::String(value) => assert_eq!(value.units(), &[65, 0xd800, 0xdc00, 66]),
        other => panic!("expected string, got {other:?}"),
    }
}

#[cfg(feature = "ast-evaluator")]
struct ReturnString(JsString);
#[cfg(feature = "ast-evaluator")]
impl Host for ReturnString {
    fn execute<'a>(&'a mut self, _: HostRequest, _: Context) -> HostFuture<'a> {
        let value = self.0.clone();
        Box::pin(async move { Ok(JsValue::String(value)) })
    }
    fn random(&mut self) -> Result<f64, EvalError> { Ok(0.5) }
}

#[cfg(feature = "ast-evaluator")]
#[test]
fn utf16_storage_and_vm_host_result_preserve_unpaired_units() {
    for units in [vec![65, 0xd800, 66], vec![65, 0xdc00, 66]] {
        let original = PersistedJsString(JsString::from_units(units.clone()));
        let json = serde_json::to_string(&original).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let restored: PersistedJsString = serde_json::from_value(value).unwrap();
        assert_eq!(restored.0.units(), units);
        assert!(restored.0.to_utf8().is_err());

        let mut registry = FunctionRegistry::default();
        registry.register("lossless", None);
        let engine = Engine::new(registry);
        let plan = engine.compile_template("before $(lossless) after").unwrap();
        let rendered = run(engine.render(&plan, ExecutionContext::default().into_context(), &mut ReturnString(restored.0))).unwrap();
        let mut expected: Vec<u16> = "before ".encode_utf16().collect();
        expected.extend(units);
        expected.extend(" after".encode_utf16());
        assert_eq!(rendered.text.units(), expected);
    }
}

#[test]
fn existing_utf8_ast_json_shape_is_unchanged() {
    let ast = SyntaxEngine::default().parse("hello").unwrap();
    let encoded = serde_json::to_string(ast.root()).unwrap();
    let restored: AstNode = serde_json::from_str(&encoded).unwrap();
    assert_eq!(&restored, ast.root());
    assert!(encoded.contains("\"value\":\"hello\""));
}

// Source fixtures for the future lossless entry point. These assertions check
// the fixture itself and its storage, not parsing: no UTF-16 parser exists yet.
#[test]
fn source_oracles_retain_lone_units_in_text_and_nested_expressions() {
    for lone in [0xd800, 0xdc00] {
        let mut units: Vec<u16> = "a".encode_utf16().collect();
        units.push(lone);
        units.extend(" $(say \"x".encode_utf16());
        units.push(lone);
        units.extend("${1}y\") z".encode_utf16());
        let source = JsString::from_units(units.clone());
        assert_eq!(&source.units()[..3], &[b'a' as u16, lone, b' ' as u16]);
        assert_eq!(source.units()[11], lone);
        assert!(source.to_utf8().is_err());
        let encoded = serde_json::to_string(&PersistedJsString(source)).unwrap();
        let restored: PersistedJsString = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored.0.units(), units);
    }
}

#[test]
fn utf8_scanner_spans_are_utf16_offsets() {
    let segments = SyntaxEngine::default()
        .scan_template("😀 $(say hi)!")
        .unwrap();
    assert_eq!(segments.len(), 3);
    assert_eq!(segments[0].span(), SourceSpan { start: 0, end: 3 });
    assert_eq!(segments[1].span(), SourceSpan { start: 3, end: 12 });
    assert_eq!(segments[2].span(), SourceSpan { start: 12, end: 13 });
    assert_eq!(segments[1].raw_text(), "$(say hi)");
}

#[cfg(feature = "ast-blocks")]
#[test]
fn blocks_preserve_lossless_units_across_stored_json_source_and_ast() {
    use dima_rust::utils::ast_blocks::{
        BLOCKS_LOSSLESS_VERSION, BlockKind, BlockRoot, BlocksErrorCode, JsString, RootTag,
        StoredBlocks, ast_to_block, block_root_to_ast, id_maker, normalize_root,
        read_block_root_owned, root_to_source, root_to_source_utf16, stored_blocks,
        stored_blocks_lossless,
    };

    let legacy = serde_json::json!({
        "id":"root","type":"root","children":[{"id":"legacy","type":"literal","value":"plain"}]
    });
    let legacy = read_block_root_owned(legacy).unwrap();
    assert_eq!(stored_blocks(legacy.clone()).v, 1);

    for lone in [0xd800u16, 0xdc00] {
        let units = vec![0x41, lone, 0x42];
        let ast = AstNode::LiteralUtf16 {
            value: PersistedJsString(JsString::from_units(units.clone())),
        };
        let mut ids = id_maker();
        let block = ast_to_block(&ast, &mut ids).unwrap();
        assert!(matches!(&block.kind, BlockKind::LiteralUtf16 { .. }));
        let root = normalize_root(BlockRoot {
            id: "root".into(),
            kind: RootTag::Root,
            children: vec![block],
        });
        let stored = stored_blocks_lossless(root);
        assert_eq!(stored.v, BLOCKS_LOSSLESS_VERSION);
        let json = serde_json::to_value(&stored).unwrap();
        assert_eq!(json["root"]["children"][0]["type"], "literalUtf16");
        assert_eq!(json["root"]["children"][0]["value"], serde_json::json!(&units));

        let restored: StoredBlocks = serde_json::from_value(json).unwrap();
        let read = read_block_root_owned(restored.root.to_value()).unwrap();
        assert_eq!(
            root_to_source_utf16(&read).unwrap().units(),
            units.as_slice()
        );
        assert_eq!(
            root_to_source(&read).unwrap_err().code,
            BlocksErrorCode::UnpairedSurrogate
        );
        assert_eq!(block_root_to_ast(&read).unwrap(), AstNode::Root {
            children: vec![ast],
        });
    }
}
