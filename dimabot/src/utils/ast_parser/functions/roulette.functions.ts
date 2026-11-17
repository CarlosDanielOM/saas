import { registerFunction, type FunctionHandler } from '../evaluator.js';
import { execute, snapshot, type Action } from '../../../roulette/service.js';
import { RouletteError, fail, text, integer, find } from '../../../roulette/model.js';
import { recordActivity } from '../../activity_log.js';

// name, syntax, description, minimum and maximum argument count.
const definitions = [
  ['create', 'roulette_id ["Name"]', 'Creates an empty roulette with the default wheel design. The ID starts with a lowercase letter and uses letters, numbers, _ or -; the name defaults to the ID. Returns an error when a roulette with that ID already exists. Up to 20 roulettes per channel.', 1, 40],
  ['delete', 'roulette_id', 'Deletes a roulette with all its prizes and settings. This cannot be undone. Refused while a roulette is spinning.', 1, 1],
  ['clear', 'roulette_id', 'Removes every prize and keeps the roulette, its design and its settings. Refused while a roulette is spinning.', 1, 1],
  ['fill', 'roulette_id list', 'Replaces every prize with the given list in one save: one slot of weight 1 per entry. The list is a list value such as $(poll.tied), %(names) or %[a, b], or several quoted labels. Refused while a roulette is spinning.', 2, 500],
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
type RouletteFunction = typeof definitions[number][0];

const EXAMPLES: Partial<Record<RouletteFunction, string[]>> = {
  create: ['roulette.create polls "Poll tie-breaker"'],
  delete: ['roulette.delete polls'],
  clear: ['roulette.clear polls'],
  fill: ['roulette.fill polls $(poll.tied)', 'roulette.fill polls "Pizza" "Tacos"'],
  add: ['roulette.add giveaways "VIP for a day" 3 10'],
  remove: ['roulette.remove giveaways item_id'],
  update: ['roulette.update giveaways item_id 3 10'],
};
const KEYWORDS: Partial<Record<RouletteFunction, string[]>> = {
  create: ['create roulette', 'new wheel', 'crear ruleta'],
  delete: ['delete roulette', 'remove wheel', 'eliminar ruleta', 'borrar ruleta'],
  clear: ['empty roulette', 'remove all prizes', 'vaciar ruleta', 'limpiar ruleta'],
  fill: ['replace prizes', 'set prizes', 'tie breaker', 'llenar ruleta', 'desempate'],
};
/** Changes that throw data away; the editors mark them and AI-written commands double-check them. */
const DESTRUCTIVE = new Set<RouletteFunction>(['remove', 'delete', 'clear', 'fill']);

/**
 * Prize labels of `roulette.fill`: one list value (an AST list, or the JSON text a list function or
 * list variable prints) or one argument per prize. Blank entries are dropped.
 */
export function fillLabels(values: unknown[]): string[] {
  let entries: unknown[] = values;
  if (values.length === 1) {
    const only = values[0];
    if (Array.isArray(only)) entries = only;
    else if (typeof only === 'string' && only.trim().startsWith('[')) {
      try { const parsed = JSON.parse(only); if (Array.isArray(parsed)) entries = parsed; } catch { /* a label that starts with "[" */ }
    }
  }
  return entries.flatMap(entry => Array.isArray(entry) ? entry : [entry]).map(entry => String(entry ?? '').trim()).filter(Boolean);
}

export function registerRouletteFunctions(): void {
  for (const [name, syntax, description, min, max] of definitions) {
    const handler: FunctionHandler = async (args, ctx) => {
      try {
        if (args.length < min || args.length > max) fail('arguments', `Usage: $(roulette.${name}${syntax ? ' ' + syntax : ''})`);
        const channel = text(ctx.broadcasterId, 'channel');
        const roulette = args.length ? text(args[0], 'roulette_id') : undefined;
        if (name === 'result') {
          const state = await snapshot(channel); const selected = find(state, roulette);
          return state.history.find(draw => draw.rouletteId === selected.id)?.winner.label ?? '';
        }
        if (name === 'create') {
          const alias = roulette!.toLowerCase();
          const title = args.slice(1).map(value => String(value ?? '')).join(' ').trim();
          await execute(channel, { operation: 'create', data: { alias, name: title || alias } });
          return '';
        }
        if (name === 'delete') {
          // Read first for the record: once deleted, its name and size are gone.
          const selected = find(await snapshot(channel), roulette);
          await execute(channel, { operation: 'delete', roulette: selected.id });
          recordActivity({
            kind: 'system', name: 'roulette.delete', channelID: channel,
            actor: ctx.userId ? { id: ctx.userId, login: ctx.userLogin, name: ctx.userDisplayName } : null,
            text: `Roulette “${selected.name}” (${selected.alias}) was deleted by a command`,
            data: { alias: selected.alias, roulette: selected.name, prizes: selected.items.length,
              command: ctx.commandName || null, source: ctx.scopeType || null },
          });
          return '';
        }
        if (name === 'fill') {
          const labels = fillLabels(args.slice(1));
          if (!labels.length) fail('arguments', 'the list is empty; give at least one prize');
          await execute(channel, { operation: 'import', roulette, data: { replace: true, items: labels.map(label => ({ label })) } });
          return '';
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
        const result = await execute(channel, action, undefined, undefined, name === 'start' ? { userId: ctx.userId ?? '', userLogin: ctx.userLogin ?? '', userDisplayName: ctx.userDisplayName ?? '', argument: (ctx.argument ?? '').slice(0, 2000) } : undefined);
        // IDs can be captured in an AST variable; other actions stay silent.
        return name === 'add' ? result.result : '';
      } catch (error) {
        if (error instanceof RouletteError) {
          if (name === 'create' && error.code === 'alias_conflict') return 'Error: roulette.create: Roulette with that name already exists';
          return `Error: roulette.${name}: ${error.message}`;
        }
        console.error(`roulette.${name} failed`, error instanceof Error ? error.message : 'Unknown error');
        return `Error: roulette.${name}: storage temporarily unavailable`;
      }
    };
    registerFunction(`roulette.${name}`, handler, {
      description, syntax: `roulette.${name}${syntax ? ' ' + syntax : ''}`, category: 'roulette',
      examples: EXAMPLES[name] ?? [`roulette.${name}${min ? ' giveaways' : ''}`],
      minUserLevel: name === 'result' ? 1 : 7, destructive: DESTRUCTIVE.has(name),
      keywords: ['roulette', 'wheel', 'reel', 'ruleta', 'sorteo', ...(KEYWORDS[name] ?? [])],
    });
  }
}
