import type { ExecutionContext } from '../types.js';
import { registerFunction, type FunctionHandler } from '../evaluator.js';

const countHandler: FunctionHandler = async (args, ctx) => {
    let incrementArg = String(args[0] || ctx.argument || '0');
    if (incrementArg !== '0') {
        incrementArg = incrementArg.replace(/\+/g, '');
    }
    const increment = parseInt(incrementArg, 10) || 0;
    const newCount = ctx.count + increment;
    ctx.count = newCount;
    ctx.countModified = true;
    return String(newCount);
};

const scountHandler: FunctionHandler = async (_args, ctx) => {
    ctx.count = ctx.count + 1;
    ctx.countModified = true;
    return String(ctx.count);
};

const bitsHandler: FunctionHandler = async (_args, ctx) => {
    if (ctx.extraContext?.bits !== undefined) {
        return String(ctx.extraContext.bits);
    }
    return '0';
};

export function registerCountFunctions(): void {
    registerFunction('count', countHandler, {
        description: 'Persistent per-command counter: adds the increment to the stored count and returns the new value.',
        syntax: 'count [increment]',
        category: 'counters',
        examples: ['count', 'count 5', 'count +3'],
        keywords: ['counter', 'contador', 'increment', 'times used', 'veces usado'],
        surfaces: ['authoring']
    });
    registerFunction('scount', scountHandler, {
        description: 'Simple counter: increments the per-command count by 1 and returns the new value.',
        syntax: 'scount',
        category: 'counters',
        examples: ['scount'],
        keywords: ['counter', 'contador', 'increment by one'],
        surfaces: ['authoring']
    });
    registerFunction('bits', bitsHandler, {
        description: 'Returns the bits amount of the current cheer event context (0 outside cheer events).',
        syntax: 'bits',
        category: 'counters',
        examples: ['bits'],
        keywords: ['bits', 'cheer', 'cheer amount'],
        surfaces: ['authoring']
    });
}
