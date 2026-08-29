import type { ExecutionContext, EvaluateResult, AstNode, RootNode, SyntaxDefinition, FunctionMetadata, AstFunctionSurface } from './types.js';
import { parse, parseToAst, printAst } from './parser.js';
import { tokenize } from './tokenizer.js';
import { evaluate, createExecutionContext, registerFunction, getFunctionHandler, getFunctionMetadata, getAllRegisteredFunctions, FunctionHandler, RegisteredFunctionEntry } from './evaluator.js';
import { SyntaxRegistry, createSyntaxRegistry, registerSyntax, parseExpression } from './registry.js';
import { renderAstWithSourceReference } from './render.js';
import { registerAllFunctions } from './functions/index.js';

export type {
    ExecutionContext,
    EvaluateResult,
    AstNode,
    RootNode,
    SyntaxDefinition,
    FunctionHandler,
    FunctionMetadata,
    AstFunctionSurface,
    RegisteredFunctionEntry
};

export {
    parse,
    parseToAst,
    printAst,
    tokenize,
    evaluate,
    createExecutionContext,
    registerFunction,
    getFunctionHandler,
    getFunctionMetadata,
    getAllRegisteredFunctions,
    SyntaxRegistry,
    createSyntaxRegistry,
    registerSyntax,
    parseExpression,
    renderAstWithSourceReference
};

export async function parseAndEvaluate(
    input: string,
    context: Partial<ExecutionContext> = {}
): Promise<{ result: unknown; context: ExecutionContext }> {
    registerAllFunctions();
    
    const fullContext = createExecutionContext(context);
    const { ast, error } = parse(input);
    
    if (error) {
        return { result: `[Parse error: ${error}]`, context: fullContext };
    }
    
    const { value, context: resultContext } = await evaluate(ast, fullContext);
    
    return { result: value, context: resultContext };
}
