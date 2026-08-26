import { registerFunction, type FunctionHandler } from '../evaluator.js';

function joinArgs(args: unknown[], from: number = 0): string {
    return args.slice(from).map((arg) => String(arg ?? '')).join(' ');
}

function isNumericArg(value: unknown): boolean {
    return /^-?\d+$/.test(String(value ?? '').trim());
}

// Wraps negative indexes (consistent with array accessors) and clamps to bounds
function resolveSliceIndex(raw: string, length: number, fallback: number): number {
    let idx = parseInt(raw, 10);
    if (!Number.isFinite(idx)) return fallback;
    if (idx < 0) idx = length + idx;
    return Math.max(0, Math.min(length, idx));
}

const upperHandler: FunctionHandler = async (args) => joinArgs(args).toUpperCase();

const lowerHandler: FunctionHandler = async (args) => joinArgs(args).toLowerCase();

const titleHandler: FunctionHandler = async (args) =>
    joinArgs(args).toLowerCase().replace(/(?:^|\s)(\p{L})/gu, (match, letter: string) => match.replace(letter, letter.toUpperCase()));

const capitalizeHandler: FunctionHandler = async (args) => {
    const text = joinArgs(args);
    return text.length === 0 ? '' : text[0].toUpperCase() + text.slice(1);
};

const trimHandler: FunctionHandler = async (args) => joinArgs(args).trim();

const lengthHandler: FunctionHandler = async (args) => String(joinArgs(args).length);

// $(slice start [end] text...) - numeric args first, the rest is the text.
// Negative indexes wrap from the end, same as array accessors.
// The tokenizer emits unary minus as a separate `-` arg, so fold `-` + number pairs.
const sliceHandler: FunctionHandler = async (args) => {
    const takeNumber = (idx: number): { raw?: string; next: number } => {
        const token = String(args[idx] ?? '').trim();
        if (token === '-' && isNumericArg(args[idx + 1])) {
            return { raw: `-${String(args[idx + 1]).trim()}`, next: idx + 2 };
        }
        if (isNumericArg(token)) {
            return { raw: token, next: idx + 1 };
        }
        return { next: idx };
    };

    const startArg = takeNumber(0);
    if (startArg.raw === undefined) {
        return '';
    }

    const endArg = takeNumber(startArg.next);
    const text = joinArgs(args, endArg.next);
    const start = resolveSliceIndex(startArg.raw, text.length, 0);
    const end = endArg.raw !== undefined ? resolveSliceIndex(endArg.raw, text.length, text.length) : text.length;

    return text.slice(start, end);
};

// $(replace search replacement text...) - literal replace-all, no regex.
// Use quoted template args for multi-word search/replacement.
const replaceHandler: FunctionHandler = async (args) => {
    const search = String(args[0] ?? '');
    const replacement = String(args[1] ?? '');
    const text = joinArgs(args, 2);

    if (search === '' || text === '') {
        return text;
    }

    return text.split(search).join(replacement);
};

export function registerStringFunctions(): void {
    registerFunction('upper', upperHandler);
    registerFunction('lower', lowerHandler);
    registerFunction('title', titleHandler);
    registerFunction('capitalize', capitalizeHandler);
    registerFunction('trim', trimHandler);
    registerFunction('length', lengthHandler);
    registerFunction('slice', sliceHandler);
    registerFunction('replace', replaceHandler);
}
