/**
 * Block tree for the paid block editor (dimasite command modal → Blocks tab).
 *
 * It mirrors the real parser's AST (utils/ast_parser/types.ts) so a block tree
 * and the command text it compiles to always mean the same thing. The frontend
 * keeps a structural copy in dimasite/src/app/features/commands/blocks/.
 *
 * Root children are what the bot's renderer sees: `literal` is plain chat text
 * (shown exactly as typed), every other block is one top-level expression.
 * `raw` keeps an expression the blocks can't show yet, byte for byte.
 */

export const BLOCKS_VERSION = 1;

export type BlockStorage = 'memory' | 'cache' | 'cacheUser' | 'db' | 'dbUser';
export type BlockBinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '>=' | '<=' | '>' | '<' | '=' | '~=' | '<>';
export type BlockUnaryOp = '+' | '-';
export type BlockLoopAssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '++' | '--';

export type BlockAccessor =
    | { type: 'array' }
    | { type: 'append' }
    | { type: 'random' }
    | { type: 'length' }
    | { type: 'clear' }
    | { type: 'index'; index: BlockNode }
    | { type: 'setIndex'; index: BlockNode }
    | { type: 'remove'; index: BlockNode };

interface Base { id: string }

export interface LiteralBlock extends Base { type: 'literal'; value: string }
export interface RawBlock extends Base { type: 'raw'; source: string }
export interface FunctionBlock extends Base { type: 'function'; name: string; args: BlockNode[] }
export interface CommandRefBlock extends Base { type: 'commandRef'; commandName: string; args: BlockNode[] }
export interface GetVarBlock extends Base { type: 'getVar'; name: string; storage: BlockStorage; accessor?: BlockAccessor; userSelector?: BlockNode }
export interface SetVarBlock extends Base { type: 'setVar'; name: string; storage: BlockStorage; value: BlockNode; accessor?: BlockAccessor; userSelector?: BlockNode }
export interface ExistsBlock extends Base { type: 'exists'; name: string; storage: BlockStorage; accessor?: BlockAccessor; userSelector?: BlockNode }
export interface DeleteVarBlock extends Base { type: 'deleteVar'; name: string; storage: BlockStorage; accessor?: BlockAccessor; userSelector?: BlockNode }
export interface BinaryBlock extends Base { type: 'binary'; operator: BlockBinaryOp; left: BlockNode; right: BlockNode }
export interface UnaryBlock extends Base { type: 'unary'; operator: BlockUnaryOp; argument: BlockNode }
export interface TernaryBlock extends Base { type: 'ternary'; test: BlockNode; consequent: BlockNode; alternate: BlockNode }
export interface TemplateBlock extends Base { type: 'template'; parts: BlockNode[] }
export interface ArrayLiteralBlock extends Base { type: 'arrayLiteral'; items: BlockNode[]; accessor?: BlockAccessor }
export interface LoopVarBlock extends Base { type: 'loopVar'; name: string }
export interface LoopAssignBlock extends Base { type: 'loopAssign'; name: string; operator: BlockLoopAssignOp; value?: BlockNode }
export interface ForLoopBlock extends Base {
    type: 'forLoop';
    loopVar: string;
    mode: 'range' | 'foreach';
    init?: BlockNode;
    condition?: BlockNode;
    update?: BlockNode;
    iterable?: BlockNode;
    body: BlockNode[];
}
/** Editor convenience: several blocks used as one value. Saved as a template. */
export interface GroupBlock extends Base { type: 'group'; children: BlockNode[] }

export type BlockNode =
    | LiteralBlock
    | RawBlock
    | FunctionBlock
    | CommandRefBlock
    | GetVarBlock
    | SetVarBlock
    | ExistsBlock
    | DeleteVarBlock
    | BinaryBlock
    | UnaryBlock
    | TernaryBlock
    | TemplateBlock
    | ArrayLiteralBlock
    | LoopVarBlock
    | LoopAssignBlock
    | ForLoopBlock
    | GroupBlock;

export interface BlockRoot { id: string; type: 'root'; children: BlockNode[] }

/** Stored on the command document (`commands.blocks`). */
export interface StoredBlocks { v: number; root: BlockRoot }

/** A save or import problem the editor can point at. */
export class BlocksError extends Error {
    constructor(message: string, public readonly blockId?: string) {
        super(message);
    }
}

export const STORAGE_PREFIX: Record<BlockStorage, string> = {
    memory: '',
    cache: '#',
    cacheUser: '##',
    db: '*',
    dbUser: '**'
};
