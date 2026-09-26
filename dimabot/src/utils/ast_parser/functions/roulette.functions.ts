import { registerFunction, type FunctionHandler } from '../evaluator.js';
import { execute, requirePro, snapshot, type Action } from '../../../roulette/service.js';
import { RouletteError, fail, text, integer, find } from '../../../roulette/model.js';

const definitions = [
  ['add', 'roulette_id "item label" [multiplier] [weight]', 'Adds an item; multiplier creates copies, weight sets chance per copy.', 2, 4],
  ['remove', 'roulette_id item_id', 'Removes an item and all its copies.', 2, 2],
  ['update', 'roulette_id item_id multiplier [weight]', 'Updates an item multiplier and optionally its weight.', 3, 4],
  ['shuffle', 'roulette_id', 'Shuffles individual copies without changing odds.', 1, 1],
  ['switch', 'roulette_id', 'Selects the active roulette without changing visibility.', 1, 1],
  ['show', '', 'Shows the active roulette overlay.', 0, 0],
  ['hide', '', 'Hides the roulette overlay without cancelling its draw.', 0, 0],
  ['start', '[roulette_id]', 'Starts the active or specified roulette and saves one authoritative winner.', 0, 1],
  ['result', '[roulette_id]', 'Returns the most recently completed winner label.', 0, 1],
] as const;

export function registerRouletteFunctions(): void {
  for (const [name, syntax, description, min, max] of definitions) {
    const handler: FunctionHandler = async (args, ctx) => {
      try {
        if (args.length < min || args.length > max) fail('arguments', `Usage: $(roulette.${name}${syntax ? ' ' + syntax : ''})`);
        const channel = text(ctx.broadcasterId, 'channel');
        const roulette = args.length ? text(args[0], 'roulette_id') : undefined;
        if (name === 'result') {
          await requirePro(channel);
          const state = await snapshot(channel); const selected = find(state, roulette);
          return state.history.find(draw => draw.rouletteId === selected.id)?.winner.label ?? '';
        }
        const action: Action = { operation: name, ...(roulette ? { roulette } : {}) };
        if (name === 'add') action.data = {
          label: text(args[1], 'item label'),
          multiplier: args[2] === undefined ? 1 : integer(Number(args[2]), 'multiplier'),
          weight: args[3] === undefined ? 1 : integer(Number(args[3]), 'weight'),
        };
        if (name === 'update' || name === 'remove') action.itemId = text(args[1], 'item_id');
        if (name === 'update') action.data = {
          multiplier: integer(Number(args[2]), 'multiplier'),
          ...(args[3] !== undefined ? { weight: integer(Number(args[3]), 'weight') } : {}),
        };
        const result = await execute(channel, action);
        // IDs can be captured in an AST variable; other actions stay silent.
        return name === 'add' ? result.result : '';
      } catch (error) {
        if (error instanceof RouletteError) return `Error: roulette.${name}: ${error.message}`;
        console.error(`roulette.${name} failed`, error instanceof Error ? error.message : 'Unknown error');
        return `Error: roulette.${name}: storage temporarily unavailable`;
      }
    };
    registerFunction(`roulette.${name}`, handler, {
      description, syntax: `roulette.${name}${syntax ? ' ' + syntax : ''}`, category: 'roulette',
      examples: [name === 'add' ? 'roulette.add giveaways "VIP for a day" 3 10' : `roulette.${name}${min ? ' giveaways' : ''}${name === 'remove' ? ' item_id' : name === 'update' ? ' item_id 3 10' : ''}`],
      minUserLevel: name === 'result' ? 1 : 7, destructive: name === 'remove',
      keywords: ['roulette', 'wheel', 'reel', 'ruleta', 'sorteo'],
    });
  }
}
