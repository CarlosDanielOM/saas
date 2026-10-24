import type { ExecutionContext } from './types.js';
import type { SyntaxDefinition } from './types.js';
import { SyntaxRegistry } from './registry.js';
import { parse } from './parser.js';
import { evaluate } from './evaluator.js';

interface RenderAstResult {
    parsedText: string;
    context: ExecutionContext;
}

function isEscaped(input: string, index: number): boolean {
    let backslashes = 0;
    for (let i = index - 1; i >= 0 && input[i] === '\\'; i--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

function findExpressionEnd(input: string, startIndex: number): number {
    let depth = 1;
    let inQuote: 'single' | 'double' | null = null;

    for (let i = startIndex; i < input.length; i++) {
        const char = input[i];

        if (inQuote) {
            if (char === '\\') {
                i++;
                continue;
            }

            if ((inQuote === 'single' && char === "'") || (inQuote === 'double' && char === '"')) {
                inQuote = null;
            }

            continue;
        }

        if (char === '\\') {
            // Escaped char (e.g. `\)`): not structural, skip it for depth counting
            i++;
            continue;
        }

        if (char === '"') {
            inQuote = 'double';
            continue;
        }

        if (char === "'") {
            inQuote = 'single';
            continue;
        }

        if (char === '(') {
            depth++;
            continue;
        }

        if (char === ')') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }

    return -1;
}

function getStartTokens(registry: Map<string, SyntaxDefinition>): string[] {
    return Array.from(registry.keys()).sort((a, b) => b.length - a.length);
}

function findMatchingStartToken(
    input: string,
    index: number,
    startTokens: string[]
): string | null {
    for (const token of startTokens) {
        if (input.startsWith(token, index)) {
            return token;
        }
    }
    return null;
}

/**
 * The bot's final pass over a rendered reply: `\$`, `\%`, `\*`, `\#` and `\^`
 * lose their backslash (that is how chat text shows a literal `$(` and friends).
 */
export function unescapeRenderedText(input: unknown): string {
    if (typeof input !== 'string') return String(input || '');
    return input
        .replace(/\\\$/g, '$')
        .replace(/\\%/g, '%')
        .replace(/\\\*/g, '*')
        .replace(/\\#/g, '#')
        .replace(/\\\^/g, '^');
}

/**
 * One piece of command text, split the way the renderer evaluates it: plain
 * text is copied as is; each top-level expression ($(…), %(…), *(…), ^(…),
 * %del(…), #(…)) is parsed and evaluated on its own. `unclosed` is a start
 * token with no matching `)`; rendering stops there.
 */
export type SourceSegment =
    | { kind: 'text'; text: string }
    | { kind: 'expr'; source: string }
    | { kind: 'unclosed'; source: string };

/** Splits command text exactly like renderAstWithSourceReference. Adjacent text is merged. */
export function scanSourceSegments(
    input: string,
    registry: Map<string, SyntaxDefinition> = SyntaxRegistry
): SourceSegment[] {
    const startTokens = getStartTokens(registry);
    const segments: SourceSegment[] = [];
    let text = '';
    let i = 0;

    const flushText = () => {
        if (text) segments.push({ kind: 'text', text });
        text = '';
    };

    while (i < input.length) {
        const token = findMatchingStartToken(input, i, startTokens);

        if (!token || isEscaped(input, i)) {
            text += input[i];
            i++;
            continue;
        }

        const expressionEnd = findExpressionEnd(input, i + token.length);
        flushText();
        if (expressionEnd === -1) {
            segments.push({ kind: 'unclosed', source: input.slice(i) });
            return segments;
        }

        segments.push({ kind: 'expr', source: input.slice(i, expressionEnd + 1) });
        i = expressionEnd + 1;
    }

    flushText();
    return segments;
}

export async function renderAstWithSourceReference(
    input: string,
    context: ExecutionContext,
    registry: Map<string, SyntaxDefinition> = SyntaxRegistry
): Promise<RenderAstResult> {
    let output = '';
    let currentContext = context;

    for (const segment of scanSourceSegments(input, registry)) {
        if (segment.kind === 'text') {
            output += segment.text;
            continue;
        }

        if (segment.kind === 'unclosed') {
            output += '[Parse error: Unclosed expression]';
            break;
        }

        const { ast, error } = parse(segment.source, registry);

        if (error) {
            output += `[Parse error: ${error}]`;
            continue;
        }

        const result = await evaluate(ast, currentContext);
        currentContext = result.context;
        output += String(result.value ?? '');
    }

    return {
        parsedText: output,
        context: currentContext
    };
}
