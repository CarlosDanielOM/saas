import type { FunctionHandler } from '../evaluator.js';
import { registerFunction } from '../evaluator.js';

const randomHandler: FunctionHandler = async (args, _ctx) => {
    const maxNumber = parseInt(String(args[0] || '100'), 10) || 100;
    return String(Math.floor(Math.random() * maxNumber));
};

export function registerRandomFunctions(): void {
    registerFunction('random', randomHandler, {
        description: 'Returns a random integer from 0 up to max-1. Max defaults to 100.',
        syntax: 'random [max]',
        category: 'random',
        examples: ['random', 'random 50'],
        keywords: ['dice', 'random number', 'numero aleatorio', 'dado', 'azar']
    });
}
