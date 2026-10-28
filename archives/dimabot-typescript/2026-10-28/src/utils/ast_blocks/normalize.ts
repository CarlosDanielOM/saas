import type { BlockAccessor, BlockNode, BlockRoot, LiteralBlock } from './types.js';

/**
 * Canonical form, so a tree from the editor and the tree read back from its
 * compiled text compare equal:
 * - top level: groups/quoted text are spread out (chat text is already free text),
 *   neighbouring text joins, empty text goes;
 * - inside a value: a group becomes quoted text, quoted text with only words
 *   becomes plain text (the bot treats `hi` and `"hi"` the same).
 */
export function normalizeRoot(root: BlockRoot): BlockRoot {
    const children: BlockNode[] = [];
    const push = (node: BlockNode) => {
        if (node.type === 'group') return node.children.forEach(push);
        if (node.type === 'template') return node.parts.forEach(push);
        children.push(node.type === 'literal' || node.type === 'raw' ? node : normalizeValue(node));
    };
    root.children.forEach(push);
    return { ...root, children: mergeText(children, true) };
}

export function normalizeValue(node: BlockNode): BlockNode {
    switch (node.type) {
        case 'group':
            return normalizeValue({ id: node.id, type: 'template', parts: node.children });
        case 'template': {
            const parts: BlockNode[] = [];
            const push = (part: BlockNode) => {
                if (part.type === 'group') return part.children.forEach(push);
                if (part.type === 'template') return part.parts.forEach(push);
                parts.push(normalizeValue(part));
            };
            node.parts.forEach(push);
            const merged = mergeText(parts, true);
            if (merged.length === 0) return { id: node.id, type: 'literal', value: '' };
            if (merged.every((part) => part.type === 'literal')) {
                return { id: node.id, type: 'literal', value: merged.map((part) => (part as LiteralBlock).value).join('') };
            }
            return { ...node, parts: merged };
        }
        case 'function':
        case 'commandRef':
            return { ...node, args: node.args.map(normalizeValue) };
        case 'getVar':
        case 'exists':
        case 'deleteVar':
            return withOptional({ ...node }, {
                accessor: normalizeAccessor(node.accessor),
                userSelector: node.userSelector ? normalizeValue(node.userSelector) : undefined
            });
        case 'setVar':
            return withOptional({ ...node, value: normalizeValue(node.value) }, {
                accessor: normalizeAccessor(node.accessor),
                userSelector: node.userSelector ? normalizeValue(node.userSelector) : undefined
            });
        case 'binary':
            return { ...node, left: normalizeValue(node.left), right: normalizeValue(node.right) };
        case 'unary':
            return { ...node, argument: normalizeValue(node.argument) };
        case 'ternary':
            return { ...node, test: normalizeValue(node.test), consequent: normalizeValue(node.consequent), alternate: normalizeValue(node.alternate) };
        case 'arrayLiteral':
            return withOptional({ ...node, items: node.items.map(normalizeValue) }, { accessor: normalizeAccessor(node.accessor) });
        case 'loopAssign':
            return withOptional({ ...node }, { value: node.value ? normalizeValue(node.value) : undefined });
        case 'forLoop': {
            const body: BlockNode[] = [];
            const push = (child: BlockNode) => {
                if (child.type === 'group') return child.children.forEach(push);
                body.push(normalizeValue(child));
            };
            node.body.forEach(push);
            return withOptional({ ...node, body }, {
                init: node.init ? normalizeValue(node.init) : undefined,
                condition: node.condition ? normalizeValue(node.condition) : undefined,
                update: node.update ? normalizeValue(node.update) : undefined,
                iterable: node.iterable ? normalizeValue(node.iterable) : undefined
            });
        }
        default:
            return node;
    }
}

function normalizeAccessor(accessor: BlockAccessor | undefined): BlockAccessor | undefined {
    if (!accessor) return undefined;
    if (accessor.type === 'index' || accessor.type === 'setIndex' || accessor.type === 'remove') {
        return { type: accessor.type, index: normalizeValue(accessor.index) };
    }
    return { type: accessor.type } as BlockAccessor;
}

/** Joins neighbouring text blocks; optionally drops empty ones. */
function mergeText(nodes: BlockNode[], dropEmpty: boolean): BlockNode[] {
    const out: BlockNode[] = [];
    for (const node of nodes) {
        const last = out[out.length - 1];
        if (node.type === 'literal' && last?.type === 'literal') {
            out[out.length - 1] = { ...last, value: last.value + node.value };
            continue;
        }
        out.push(node);
    }
    return dropEmpty ? out.filter((node) => node.type !== 'literal' || node.value !== '') : out;
}

function withOptional<T extends object>(base: T, optional: Record<string, unknown>): T {
    const out = { ...base } as Record<string, unknown>;
    for (const [key, value] of Object.entries(optional)) {
        if (value === undefined) delete out[key];
        else out[key] = value;
    }
    return out as T;
}

/** Structure without ids, with stable key order, for equality checks. */
export function blockShape(node: BlockNode | BlockRoot): string {
    return JSON.stringify(node, (key, value) => {
        if (key === 'id') return undefined;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
        }
        return value;
    });
}
