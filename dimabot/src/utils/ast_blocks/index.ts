import { parse } from '../ast_parser/parser.js';
import { scanSourceSegments, unescapeRenderedText, type SourceSegment } from '../ast_parser/render.js';
import { astToBlock, idMaker, UnsupportedSyntax, type IdMaker } from './from_ast.js';
import { blockShape, normalizeRoot, normalizeValue } from './normalize.js';
import { rootToSource, topLevel } from './to_source.js';
import { BLOCKS_VERSION, BlocksError, type BlockNode, type BlockRoot, type StoredBlocks } from './types.js';
import { readBlockRoot } from './validate.js';

export * from './types.js';
export { readBlockRoot } from './validate.js';

/** Longest command text the website saves (text or compiled blocks). Chat `!ec` keeps its own lower limit. */
export const MAX_COMMAND_TEXT = 10_000;

export interface CompiledBlocks {
    /** Normalized tree to store and send back to the editor. */
    root: BlockRoot;
    /** Command text the bot runs (`commands.message`). */
    text: string;
}

export interface ImportedText {
    root: BlockRoot;
    /** Expressions kept as advanced pieces because blocks can't show them yet. */
    advancedCount: number;
}

/**
 * Editor blocks → command text, with a guarantee: the text read back gives the
 * same blocks, so what the streamer sees is what the bot runs.
 */
export function compileBlocks(input: unknown): CompiledBlocks {
    const root = normalizeRoot(readBlockRoot(input));
    if (root.children.length === 0) throw new BlocksError('Add at least one block.');

    const text = rootToSource(root);
    if (text.length > MAX_COMMAND_TEXT) {
        throw new BlocksError(`This command is too long (${text.length} of ${MAX_COMMAND_TEXT} characters).`);
    }

    const segments = scanSourceSegments(text);
    const count = Math.max(segments.length, root.children.length);
    for (let i = 0; i < count; i++) {
        const block = root.children[i];
        const segment = segments[i];
        if (!block || !segment) {
            throw new BlocksError('This block would run differently than it looks. Try moving or retyping it.', block?.id ?? root.children.at(-1)?.id);
        }
        checkTopLevel(block, segment);
    }

    return { root, text };
}

function checkTopLevel(block: BlockNode, segment: SourceSegment): void {
    if (block.type === 'literal') {
        if (segment.kind !== 'text' || unescapeRenderedText(segment.text) !== block.value) {
            throw new BlocksError('Text can\'t have a backslash right before $ % * # or ^.', block.id);
        }
        return;
    }
    if (block.type === 'raw') {
        if (segment.kind === 'text' || segment.source !== block.source) {
            throw new BlocksError('An advanced piece must be one $( … ), %( … ), *( … ), ^( … ), %del( … ) or #( … ).', block.id);
        }
        return;
    }
    if (segment.kind !== 'expr') {
        throw new BlocksError('This block would run differently than it looks. Try moving or retyping it.', block.id);
    }
    const reread = readExpression(segment.source, idMaker('v'));
    if (!reread || blockShape(reread) !== blockShape(block)) {
        throw new BlocksError('This block would run differently than it looks. Try retyping its text.', block.id);
    }
}

/** One top-level expression → block, or null when it doesn't parse cleanly into one block. */
function readExpression(source: string, nextId: IdMaker): BlockNode | null {
    const { ast, error } = parse(source);
    if (error || ast.children.length !== 1) return null;
    try {
        return normalizeValue(astToBlock(ast.children[0], nextId));
    } catch (err) {
        if (err instanceof UnsupportedSyntax) return null;
        throw err;
    }
}

/**
 * Command text → blocks. Never fails: expressions that blocks can't show
 * exactly (or that wouldn't come back out the same) stay as advanced pieces
 * with their original text.
 */
export function importCommandText(text: string): ImportedText {
    if (text.length > MAX_COMMAND_TEXT) {
        throw new BlocksError(`This text is too long (${text.length} of ${MAX_COMMAND_TEXT} characters).`);
    }
    const nextId = idMaker('i');
    let advancedCount = 0;
    const children: BlockNode[] = scanSourceSegments(text).map((segment): BlockNode => {
        if (segment.kind === 'text') return { id: nextId(), type: 'literal', value: unescapeRenderedText(segment.text) };
        const block = segment.kind === 'expr' ? readExpression(segment.source, nextId) : null;
        if (block && roundTrips(block)) return block;
        advancedCount += 1;
        return { id: nextId(), type: 'raw', source: segment.source };
    });

    // Text with a backslash right before $ % * # ^ can't be written back the same
    // way; saving then points at that block instead of changing the reply.
    return { root: normalizeRoot({ id: nextId(), type: 'root', children }), advancedCount };
}

/** The block, written back out, scans as one expression and reads back the same. */
function roundTrips(block: BlockNode): boolean {
    try {
        const source = topLevel(block);
        const segments = scanSourceSegments(source);
        if (segments.length !== 1 || segments[0].kind !== 'expr' || segments[0].source !== source) return false;
        const reread = readExpression(source, idMaker('r'));
        return !!reread && blockShape(reread) === blockShape(block);
    } catch (err) {
        if (err instanceof BlocksError) return false;
        throw err;
    }
}

export function storedBlocks(root: BlockRoot): StoredBlocks {
    return { v: BLOCKS_VERSION, root };
}
