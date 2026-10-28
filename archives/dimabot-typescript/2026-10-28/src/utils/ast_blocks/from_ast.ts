import type { ArrayAccessor, AstNode, VariableStorage } from '../ast_parser/types.js';
import { STORAGE_PREFIX, type BlockAccessor, type BlockNode } from './types.js';

export class UnsupportedSyntax extends Error {}

export type IdMaker = () => string;

export function idMaker(prefix = 'b'): IdMaker {
    let seq = 0;
    const salt = Math.random().toString(36).slice(2, 6);
    return () => `${prefix}${salt}${(seq += 1).toString(36)}`;
}

/** Real parser node → block. Throws UnsupportedSyntax for shapes blocks can't show. */
export function astToBlock(node: AstNode, nextId: IdMaker): BlockNode {
    const id = nextId();
    const sub = (child: AstNode) => astToBlock(child, nextId);
    switch (node.type) {
        case 'literal':
            return { id, type: 'literal', value: node.value };
        case 'function':
            return { id, type: 'function', name: node.name, args: node.args.map(sub) };
        case 'commandRef':
            return { id, type: 'commandRef', commandName: node.commandName, args: node.args.map(sub) };
        case 'getVar':
        case 'exists':
        case 'deleteVar': {
            const block: Record<string, unknown> = { id, type: node.type, name: varName(node.name, node.storage), storage: node.storage };
            if (node.accessor) block.accessor = accessor(node.accessor, nextId);
            if (node.userSelector) block.userSelector = sub(node.userSelector);
            return block as unknown as BlockNode;
        }
        case 'setVar': {
            const block: Record<string, unknown> = { id, type: 'setVar', name: varName(node.name, node.storage), storage: node.storage, value: sub(node.value) };
            if (node.accessor) block.accessor = accessor(node.accessor, nextId);
            if (node.userSelector) block.userSelector = sub(node.userSelector);
            return block as unknown as BlockNode;
        }
        case 'binary':
            return { id, type: 'binary', operator: node.operator, left: sub(node.left), right: sub(node.right) };
        case 'unary':
            return { id, type: 'unary', operator: node.operator, argument: sub(node.argument) };
        case 'ternary':
            return { id, type: 'ternary', test: sub(node.test), consequent: sub(node.consequent), alternate: sub(node.alternate) };
        case 'template':
            return {
                id,
                type: 'template',
                parts: node.segments.map((segment) =>
                    segment.type === 'text' ? { id: nextId(), type: 'literal', value: segment.value } : sub(segment.node))
            };
        case 'arrayLiteral': {
            const block: Record<string, unknown> = { id, type: 'arrayLiteral', items: node.items.map(sub) };
            if (node.accessor) block.accessor = accessor(node.accessor, nextId);
            return block as unknown as BlockNode;
        }
        case 'loopVar':
            return { id, type: 'loopVar', name: node.name };
        case 'loopAssign': {
            const block: Record<string, unknown> = { id, type: 'loopAssign', name: node.name, operator: node.operator };
            if (node.value) block.value = sub(node.value);
            return block as unknown as BlockNode;
        }
        case 'forLoop': {
            const block: Record<string, unknown> = { id, type: 'forLoop', loopVar: node.loopVar, mode: node.mode, body: node.body.map(sub) };
            for (const key of ['init', 'condition', 'update', 'iterable'] as const) {
                if (node[key]) block[key] = sub(node[key]!);
            }
            return block as unknown as BlockNode;
        }
        default:
            throw new UnsupportedSyntax(node.type);
    }
}

/** The parser keeps the storage prefix in the name (`*deaths`); blocks store it separately. */
function varName(name: unknown, storage: VariableStorage): string {
    if (typeof name !== 'string') throw new UnsupportedSyntax('variable name');
    const prefix = STORAGE_PREFIX[storage];
    const bare = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!/^[\p{L}\p{N}_]{1,64}$/u.test(bare)) throw new UnsupportedSyntax('variable name');
    return bare;
}

function accessor(value: ArrayAccessor, nextId: IdMaker): BlockAccessor {
    if (value.type === 'index' || value.type === 'setIndex' || value.type === 'remove') {
        return { type: value.type, index: astToBlock(value.index, nextId) };
    }
    return { type: value.type };
}
