export type NodeType = 'root' | 'setVar' | 'getVar' | 'deleteVar' | 'function' | 'literal' | 'custom' | 'exists' | 'binary' | 'unary' | 'ternary' | 'template' | 'arrayLiteral' | 'commandRef' | 'loopVar' | 'loopAssign' | 'forLoop';

export type TemplateSegment = { type: 'text'; value: string } | { type: 'expr'; node: AstNode };

export type ArithmeticOperator = '+' | '-' | '*' | '/' | '%';
export type ComparisonOperator = '==' | '!=' | '>=' | '<=' | '>' | '<' | '=' | '~=' | '<>';
export type UnaryOperator = '+' | '-';
export type BinaryOperator = ArithmeticOperator | ComparisonOperator;

export type VariableStorage = 'memory' | 'cache' | 'cacheUser' | 'db' | 'dbUser';

export interface ParsedVarName {
    name: string;
    storage: VariableStorage;
}

export type ArrayAccessor = 
    | { type: 'array' }
    | { type: 'index'; index: AstNode }
    | { type: 'random' }
    | { type: 'length' }
    | { type: 'append' }
    | { type: 'setIndex'; index: AstNode }
    | { type: 'remove'; index: AstNode }
    | { type: 'clear' };

export type LoopAssignOperator = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '++' | '--';

export interface BaseNode {
    type: NodeType;
}

export interface RootNode extends BaseNode {
    type: 'root';
    children: AstNode[];
}

export interface SetVarNode extends BaseNode {
    type: 'setVar';
    name: string;
    storage: VariableStorage;
    value: AstNode;
    accessor?: ArrayAccessor;
    userSelector?: AstNode;
}

export interface GetVarNode extends BaseNode {
    type: 'getVar';
    name: string;
    storage: VariableStorage;
    accessor?: ArrayAccessor;
    userSelector?: AstNode;
}

export interface ExistsNode extends BaseNode {
    type: 'exists';
    name: string;
    storage: VariableStorage;
    accessor?: ArrayAccessor;
    userSelector?: AstNode;
}

export interface DeleteVarNode extends BaseNode {
    type: 'deleteVar';
    name: string;
    storage: VariableStorage;
    accessor?: ArrayAccessor;
    userSelector?: AstNode;
}

export interface CommandRefNode extends BaseNode {
    type: 'commandRef';
    commandName: string;
    args: AstNode[];
}

export interface LoopVarNode extends BaseNode {
    type: 'loopVar';
    name: string;
}

export interface LoopAssignNode extends BaseNode {
    type: 'loopAssign';
    name: string;
    operator: LoopAssignOperator;
    value?: AstNode;
}

export interface FunctionNode extends BaseNode {
    type: 'function';
    name: string;
    args: AstNode[];
}

export interface BinaryExpressionNode extends BaseNode {
    type: 'binary';
    operator: BinaryOperator;
    left: AstNode;
    right: AstNode;
}

export interface UnaryExpressionNode extends BaseNode {
    type: 'unary';
    operator: UnaryOperator;
    argument: AstNode;
}

export interface TernaryExpressionNode extends BaseNode {
    type: 'ternary';
    test: AstNode;
    consequent: AstNode;
    alternate: AstNode;
}

export interface TemplateNode extends BaseNode {
    type: 'template';
    segments: TemplateSegment[];
}

export interface LiteralNode extends BaseNode {
    type: 'literal';
    value: string;
}

export interface ArrayLiteralNode extends BaseNode {
    type: 'arrayLiteral';
    items: AstNode[];
    /** Optional trailing accessor: `%[1,2,3][random]`, `%[1,2,3][0]`, `%[1,2,3][].length` */
    accessor?: ArrayAccessor;
}

export interface ForLoopNode extends BaseNode {
    type: 'forLoop';
    loopVar: string;
    mode: 'range' | 'foreach';
    init?: AstNode;
    condition?: AstNode;
    update?: AstNode;
    iterable?: AstNode;
    body: AstNode[];
}

export interface CustomNode<T = unknown> extends BaseNode {
    type: 'custom';
    customType: string;
    data: T;
}

export type AstNode = RootNode | SetVarNode | GetVarNode | ExistsNode | DeleteVarNode | FunctionNode | BinaryExpressionNode | UnaryExpressionNode | TernaryExpressionNode | TemplateNode | LiteralNode | ArrayLiteralNode | CustomNode | CommandRefNode | LoopVarNode | LoopAssignNode | ForLoopNode;

export type LoopExitType = 'break' | 'continue';

export interface IStreamerData {
    id?: string;
    name?: string;
    [key: string]: unknown;
}

export interface ExecutionContext {
    variables: Map<string, unknown>;
    arrays: Map<string, string[]>;
    broadcasterId: string;
    userId: string;
    userLogin: string;
    userDisplayName: string;
    userPlan: 'free' | 'premium' | 'pro';
    userLevel: number;
    argument?: string;
    count: number;
    eventData?: Record<string, unknown>;
    eventsubData?: Record<string, unknown>;
    extraContext?: Record<string, unknown>;
    streamer?: IStreamerData | null;
    platform: string;
    scopeType: string;
    scopeName: string;
    scopeAliases: string[];
    commandName: string;
    commandId: string;
    visitedCommands?: Set<string>;
    commandRefDepth?: number;
    loopExit?: LoopExitType;
    loopVars?: Map<string, string>;
    loopDepth?: number;
    commandResponses: string[];
    commandVariables: Map<string, string>;
    userCommandVariables: Map<string, string>;
    countModified?: boolean;
    saveResponses: () => Promise<void>;
    saveChannelVariable: (name: string, value: string) => Promise<void>;
    loadChannelVariable: (name: string) => Promise<string>;
    saveUserVariable: (name: string, value: string) => Promise<void>;
    loadUserVariable: (name: string, targetUserLogin?: string) => Promise<string>;
}

export interface ParseResult {
    node: AstNode;
    newIndex: number;
}

export type ParserHandler = (
    tokens: string[],
    currentIndex: number,
    registry: Map<string, SyntaxDefinition>
) => ParseResult;

export interface SyntaxDefinition {
    startToken: string;
    endToken: string;
    handler: ParserHandler;
}

export interface TokenizeResult {
    tokens: string[];
    error?: string;
}

export interface AstParseResult {
    ast: RootNode;
    error?: string;
}

export interface EvaluateResult {
    value: unknown;
    context: ExecutionContext;
}

/**
 * Which consumer a function is relevant for:
 * - 'action': the chat AI executing it through the AST_PARSER tool
 * - 'authoring': command/reward message templates built via code_execution
 */
export type AstFunctionSurface = 'action' | 'authoring';

/**
 * Self-describing metadata attached to each registered AST function.
 * Single source of truth for the generated AI command catalog (ast_docs).
 */
export interface FunctionMetadata {
    /** Short human/LLM-readable description of what the function does */
    description: string;
    /** Literal call syntax WITHOUT the $() wrapper, e.g. 'start.poll title;option1/option2;seconds' */
    syntax: string;
    /** Functional category used for grouping and filtering */
    category: string;
    /** One or more complete usage examples WITHOUT the $() wrapper */
    examples: string[];
    /** Minimum user level required (1=Everyone … 10=Broadcaster). Defaults to 1 */
    minUserLevel?: number;
    /** Search keywords for intent-based lookup; include English and Spanish terms */
    keywords?: string[];
    /** Other registered names that resolve to this same function */
    aliases?: string[];
    /** When set, this name is an alias of the given canonical function name */
    aliasOf?: string;
    /** When set, this name is deprecated; value names the recommended replacement */
    deprecated?: string;
    /** True for destructive actions (ban, unmod, clear.chat, ...) that deserve double-checking */
    destructive?: boolean;
    /** Minimum plan tier when the function (or part of it) is plan-gated */
    planTier?: 'free' | 'premium' | 'pro';
    /** Which consumers this function matters for. Defaults to both surfaces */
    surfaces?: AstFunctionSurface[];
}
