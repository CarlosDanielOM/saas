import type { FunctionHandler } from '../evaluator.js';
import { registerFunction } from '../evaluator.js';

const MAX_DELAY_SECONDS = 60;

const delayHandler: FunctionHandler = async (args) => {
    if (args.length === 0) {
        return 'delay: missing argument (seconds)';
    }

    const raw = args[0];
    const seconds = Number(raw);

    if (!Number.isFinite(seconds)) {
        return `delay: "${raw}" is not a valid number`;
    }

    if (seconds < 0 || seconds > MAX_DELAY_SECONDS) {
        return `delay: must be between 0 and ${MAX_DELAY_SECONDS} seconds`;
    }

    const ms = Math.round(seconds * 1000);
    await new Promise(resolve => setTimeout(resolve, ms));
    return '';
};

const breakHandler: FunctionHandler = async (_args, ctx) => {
    ctx.loopExit = 'break';
    return '';
};

const continueHandler: FunctionHandler = async (_args, ctx) => {
    ctx.loopExit = 'continue';
    return '';
};

export function registerDelayFunctions(): void {
    registerFunction('delay', delayHandler, {
        description: 'Pauses execution for the given number of seconds (0-60). Used to sequence multi-step command flows.',
        syntax: 'delay seconds',
        category: 'flow',
        examples: ['delay 3'],
        keywords: ['delay', 'wait', 'pause', 'esperar', 'pausa', 'segundos'],
        surfaces: ['authoring']
    });
    registerFunction('break', breakHandler, {
        description: 'Exits the current loop immediately.',
        syntax: 'break',
        category: 'flow',
        examples: ['break'],
        keywords: ['break', 'exit loop', 'salir del bucle'],
        surfaces: ['authoring']
    });
    registerFunction('continue', continueHandler, {
        description: 'Skips the rest of the current loop iteration and continues with the next one.',
        syntax: 'continue',
        category: 'flow',
        examples: ['continue'],
        keywords: ['continue', 'skip iteration', 'continuar bucle'],
        surfaces: ['authoring']
    });
}
