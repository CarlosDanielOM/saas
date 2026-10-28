import { BlocksError, STORAGE_PREFIX, type BlockAccessor, type BlockNode, type BlockRoot } from './types.js';

/**
 * Blocks → command text. Expects a normalized tree (normalize.ts).
 *
 * Contexts follow the real grammar (utils/ast_parser/registry.ts):
 * - top level: plain text is copied; anything else is one expression;
 * - "sequence" spots (function args, variable values, loop bodies) read single
 *   tokens, so math/if/loops need their own *( … );
 * - "expression" spots (inside *( … ), sides of a check, list items, ${…})
 *   read full expressions; nested ones get parentheses.
 */
export function rootToSource(root: BlockRoot): string {
    return root.children.map((node) => {
        if (node.type === 'literal') return escapeChatText(node.value);
        if (node.type === 'raw') return node.source;
        return topLevel(node);
    }).join('');
}

/** One top-level expression. */
export function topLevel(node: BlockNode): string {
    switch (node.type) {
        case 'function':
        case 'commandRef':
        case 'getVar':
        case 'setVar':
        case 'exists':
        case 'deleteVar':
        case 'forLoop':
            return seq(node);
        case 'literal':
            return `*(${literal(node.value)})`;
        default:
            return `*(${expr(node)})`;
    }
}

const START_TOKENS = ['%del(', '$(', '%(', '*(', '^(', '#('];

/**
 * Plain chat text: a start token would turn into an expression, so it gets a
 * backslash (the bot removes `\$`, `\%`, `\*`, `\#`, `\^` from the reply).
 */
export function escapeChatText(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        if (START_TOKENS.some((token) => text.startsWith(token, i))) out += '\\';
        out += text[i];
    }
    return out;
}

/** Words that would be read as syntax when bare. */
const RESERVED_WORDS = new Set(['for', 'in', 'random']);
const BARE = /^[\p{L}\p{N}_@!&¡¿]+$/u;

/** A text value inside an expression: bare when safe, otherwise quoted. */
export function literal(value: string): string {
    if (BARE.test(value) && !RESERVED_WORDS.has(value.toLowerCase())) return value;
    return `"${escapeQuoted(value)}"`;
}

function escapeQuoted(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}

/** Sequence spot: function args, variable values, user selectors, loop bodies. */
function seq(node: BlockNode): string {
    switch (node.type) {
        case 'literal':
            return literal(node.value);
        case 'loopVar':
            return `#${node.name}`;
        case 'function':
            return node.args.length ? `$(${node.name} ${node.args.map(seq).join(' ')})` : `$(${node.name})`;
        case 'commandRef':
            return node.args.length ? `#(${node.commandName} ${node.args.map(seq).join(' ')})` : `#(${node.commandName})`;
        case 'getVar':
            return `%(${varTarget(node)}${readAccessor(node.accessor)})`;
        case 'exists':
            return `^(${varTarget(node)}${readAccessor(node.accessor)})`;
        case 'deleteVar':
            return `%del(${varTarget(node)}${deleteAccessor(node.accessor)})`;
        case 'setVar': {
            const accessor = node.accessor?.type === 'append' ? '[]'
                : node.accessor?.type === 'setIndex' ? `[${expr(node.accessor.index)}]` : '';
            return `%(${varTarget(node)}${accessor} ${seq(node.value)})`;
        }
        case 'arrayLiteral':
            return arrayLiteral(node);
        case 'template':
            return template(node);
        case 'forLoop':
            return `*(${forLoop(node)})`;
        case 'raw':
            throw new BlocksError('Advanced pieces can only be used at the top level.', node.id);
        case 'group':
            throw new BlocksError('A group was not saved correctly.', node.id);
        default:
            return `*(${expr(node)})`;
    }
}

/** Expression spot: inside *( … ). */
function expr(node: BlockNode): string {
    switch (node.type) {
        case 'binary':
            return `${operand(node.left)} ${node.operator} ${operand(node.right)}`;
        case 'unary':
            return `${node.operator}(${expr(node.argument)})`;
        case 'ternary':
            return `${operand(node.test)} ? ${operand(node.consequent)} : ${operand(node.alternate)}`;
        case 'loopAssign':
            if (node.operator === '++' || node.operator === '--') return `#${node.name}${node.operator}`;
            return `#${node.name} ${node.operator} ${operand(node.value ?? { id: '', type: 'literal', value: '' })}`;
        default:
            return seq(node);
    }
}

/** Nested expressions keep their shape with parentheses. */
function operand(node: BlockNode): string {
    if (node.type === 'binary' || node.type === 'ternary' || node.type === 'unary' || node.type === 'loopAssign') {
        return `(${expr(node)})`;
    }
    return expr(node);
}

function varTarget(node: { name: string; storage: keyof typeof STORAGE_PREFIX; userSelector?: BlockNode }): string {
    const selector = node.userSelector ? `(${seq(node.userSelector)})` : '';
    return `${STORAGE_PREFIX[node.storage]}${node.name}${selector}`;
}

function readAccessor(accessor: BlockAccessor | undefined): string {
    switch (accessor?.type) {
        case 'array': return '[]';
        case 'random': return '[random]';
        case 'length': return '[].length';
        case 'index': return `[${expr(accessor.index)}]`;
        default: return '';
    }
}

function deleteAccessor(accessor: BlockAccessor | undefined): string {
    if (accessor?.type === 'clear') return '[]';
    if (accessor?.type === 'remove') return `[${expr(accessor.index)}]`;
    return '';
}

function arrayLiteral(node: Extract<BlockNode, { type: 'arrayLiteral' }>): string {
    const items = node.items.map((item) => (item.type === 'literal' ? quotedIfComma(item.value) : expr(item))).join(', ');
    const accessor = node.accessor?.type === 'length' ? '[].length' : readAccessor(node.accessor);
    return `%[${items}]${accessor}`;
}

function quotedIfComma(value: string): string {
    return literal(value);
}

function template(node: Extract<BlockNode, { type: 'template' }>): string {
    const inner = node.parts.map((part) => (part.type === 'literal' ? escapeQuoted(part.value) : `\${${expr(part)}}`)).join('');
    return `"${inner}"`;
}

function forLoop(node: Extract<BlockNode, { type: 'forLoop' }>): string {
    const body = node.body.map(seq).join(' ');
    if (node.mode === 'foreach') {
        return `for #${node.loopVar} in ${expr(node.iterable!)} { ${body} }`;
    }
    return `for ${expr(node.init!)}; ${expr(node.condition!)}; ${expr(node.update!)} { ${body} }`;
}
