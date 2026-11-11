import * as domain from '../../../../roulette/model.js';
import type { Item, Roulette, State } from '../../../../roulette/model.js';
import { execute, RouletteChannel, type Action } from '../../../../roulette/service.js';
import { parse } from '../../../../utils/ast_parser/parser.js';
import { ToolConflictError, ToolInputError, type AgentTool, type ChangeProposal, type Lang, type ToolContext } from '../../../types.js';
import { createHash } from 'node:crypto';
import { asObject, bool, int, oneOf, stableJson, str } from '../../util.js';
import { bodyEffects, conflict, mergeEffects, sameValue, tr } from './common.js';

/**
 * Roulettes (Modules → Roulette). Routes: /roulettes/:channelID/... need `*` (owner or full-access
 * admin) and accept an If-Match revision. All changes go through roulette/service.ts `execute`.
 */

export const ROULETTE_PERMISSIONS = ['*'] as const;

const DESIGNS = ['wheel', 'cards', 'reel', 'elimination'] as const;
const CARD_SIZES = ['large', 'medium', 'small'] as const;
const MAX_ITEMS_PER_CALL = 200;

/** Saved state without creating the channel document (GET would create it). */
export async function readRouletteState(channelId: string): Promise<{ revision: number; state: State }> {
    const doc = await RouletteChannel.findById(channelId).lean();
    return { revision: doc?.revision ?? 0, state: (doc?.state as State | undefined) ?? domain.emptyState() };
}

export function findRoulette(state: State, reference: string): Roulette | undefined {
    return state.roulettes.find((roulette) => roulette.id === reference || roulette.alias === reference);
}

export const configView = (r: Roulette) => ({ name: r.name, alias: r.alias, design: r.design, cardSize: r.cardSize, colors: r.colors, durationSeconds: r.durationSeconds, settings: r.settings });
export const itemView = (item: Item) => ({ label: item.label, weight: item.weight, count: item.multiplier, winnerAction: item.action ?? '' });
/** Fingerprint of a roulette's prizes (a roulette can hold thousands, too many to keep on a proposal). */
const itemsHash = (r: Roulette) => createHash('sha256').update(stableJson(r.items.map((item) => ({ id: item.id, ...itemView(item) })))).digest('hex');

function domainCheck<T>(run: () => T): T {
    try { return run(); }
    catch (error) { if (error instanceof domain.RouletteError) throw new ToolInputError(error.message); throw error; }
}

function checkAction(source: string | undefined, label: string): void {
    if (source && source.trim() && parse(source.trim()).error) throw new ToolInputError(`Winner action for "${label}" has invalid AST syntax`);
}

/**
 * Runs one roulette operation with compare-and-set on the revision just read. No idempotency key:
 * the runner never re-applies an approval, and a reused key would silently replay an older result.
 */
async function run(ctx: Pick<ToolContext, 'channelId' | 'lang'>, action: Action, revision: number): Promise<string> {
    return (await runAt(ctx, action, revision)).result;
}

/** `run` that also returns the revision the write produced (for the next step of a multi-step change). */
async function runAt(ctx: Pick<ToolContext, 'channelId' | 'lang'>, action: Action, revision: number): Promise<{ result: string; revision: number }> {
    try {
        const done = await execute(ctx.channelId, action, undefined, revision);
        return { result: done.result, revision: done.revision };
    } catch (error) {
        if (error instanceof domain.RouletteError && error.code === 'revision_conflict') {
            throw new ToolConflictError(tr(ctx.lang, 'The roulette changed while saving. Nothing was changed; try again.', 'La ruleta cambió mientras se guardaba. No se cambió nada; inténtalo de nuevo.'));
        }
        if (error instanceof domain.RouletteError) throw new Error(error.message);
        throw error;
    }
}

function settingsInput(raw: unknown): Record<string, unknown> | undefined {
    if (raw === undefined || raw === null) return undefined;
    const input = asObject(raw);
    const value: Record<string, unknown> = {
        insertion: oneOf(input, 'insertion', ['append', 'random'] as const),
        duplicate: oneOf(input, 'duplicate', ['separate', 'increase'] as const),
        winnerAction: oneOf(input, 'winnerAction', ['keep', 'remove-copy', 'remove-item'] as const),
        shuffleBeforeDraw: bool(input, 'shuffleBeforeDraw'),
        showOnStart: bool(input, 'showOnStart')
    };
    if (Object.hasOwn(input, 'hideAfterSeconds')) value.hideAfterSeconds = input.hideAfterSeconds === null ? null : int(input, 'hideAfterSeconds', { required: true, min: 1, max: 3600 });
    const clean = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
    return Object.keys(clean).length ? clean : undefined;
}

function configInput(input: Record<string, unknown>, create: boolean): Record<string, unknown> {
    const colors = input.colors;
    if (colors !== undefined && (!Array.isArray(colors) || colors.some((color) => typeof color !== 'string'))) throw new ToolInputError('colors must be a list of hex colors like #cbbaff');
    const value: Record<string, unknown> = {
        name: str(input, 'name', { required: create, max: 120 }),
        alias: str(input, 'alias', { required: create, max: 40 })?.toLowerCase(),
        design: oneOf(input, 'design', DESIGNS),
        cardSize: oneOf(input, 'cardSize', CARD_SIZES),
        durationSeconds: int(input, 'durationSeconds', { min: 1, max: 120 }),
        colors,
        settings: settingsInput(input.settings)
    };
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

interface ItemInput { label: string; weight?: number; count?: number; winnerAction?: string }
function itemInput(raw: unknown): ItemInput {
    const input = asObject(raw);
    return {
        label: str(input, 'label', { required: true, max: 120 })!,
        weight: int(input, 'weight', { min: 1, max: 1_000_000_000 }),
        count: int(input, 'count', { min: 1, max: 10000 }),
        winnerAction: str(input, 'winnerAction', { max: 8000 })
    };
}
const toItemData = (item: Partial<ItemInput>) => Object.fromEntries(Object.entries({ label: item.label, weight: item.weight, multiplier: item.count, action: item.winnerAction }).filter(([, value]) => value !== undefined));

async function actionEffects(items: Array<{ label: string; action?: string }>, ctx: Pick<ToolContext, 'plan' | 'lang'>) {
    const withActions = items.filter((item) => item.action?.trim()).slice(0, 10);
    return mergeEffects(...await Promise.all(withActions.map((item) => bodyEffects(item.action, ctx, tr(ctx.lang, `Winner action "${item.label}"`, `Acción del ganador "${item.label}"`)))));
}

const settingsSchema = { type: 'object', additionalProperties: false, properties: {
    insertion: { type: 'string', enum: ['append', 'random'], description: 'Where new prizes go in the order' },
    duplicate: { type: 'string', enum: ['separate', 'increase'], description: 'A repeated name adds a separate prize or increases the existing one' },
    winnerAction: { type: 'string', enum: ['keep', 'remove-copy', 'remove-item'], description: 'After a spin: keep the winner, remove one copy, or remove the prize' },
    shuffleBeforeDraw: { type: 'boolean' }, showOnStart: { type: 'boolean', description: 'Show the overlay when a spin starts' },
    hideAfterSeconds: { type: ['integer', 'null'], minimum: 1, maximum: 3600, description: 'Hide the overlay this long after a result; null = stay visible' }
} };
const configSchema = {
    name: { type: 'string', maxLength: 120 },
    alias: { type: 'string', maxLength: 40, description: 'Lowercase id for chat commands, e.g. prizes' },
    design: { type: 'string', enum: [...DESIGNS] }, cardSize: { type: 'string', enum: [...CARD_SIZES] },
    durationSeconds: { type: 'integer', minimum: 1, maximum: 120, description: 'Spin length' },
    colors: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
    settings: settingsSchema
};
const itemSchema = { type: 'object', additionalProperties: false, required: ['label'], properties: {
    label: { type: 'string', maxLength: 120 }, weight: { type: 'integer', minimum: 1, description: 'Chance weight per copy (default 1)' },
    count: { type: 'integer', minimum: 1, maximum: 10000, description: 'How many copies (slots) the prize has (default 1)' },
    winnerAction: { type: 'string', maxLength: 8000, description: 'Optional command body (AST) that runs when this prize wins' }
} };
const rouletteRef = { type: 'string', description: 'Roulette id or alias from get_settings area "roulettes"' };

function target(lang: Lang, r: { id: string | null; name: string }) { return { type: 'roulette', id: r.id, label: r.name || tr(lang, 'Roulette', 'Ruleta') }; }

export interface RouletteCreateInput { config: Record<string, unknown> }
export const createRoulette: AgentTool<RouletteCreateInput> = {
    name: 'create_roulette',
    kind: 'write',
    permissions: ROULETTE_PERMISSIONS,
    description: 'Create a roulette (Modules → Roulette): a prize wheel, cards, reel or elimination draw shown in OBS and spun from chat or the page. name and alias (lowercase, unique, used in commands) are required. Add prizes after with add_roulette_items. Up to 20 roulettes. The user approves first; undo deletes it while it is still empty.',
    parameters: { type: 'object', additionalProperties: false, required: ['name', 'alias'], properties: configSchema },
    label: (_input, lang) => tr(lang, 'Preparing the roulette…', 'Preparando la ruleta…'),
    validate: (raw) => ({ config: configInput(asObject(raw), true) }),
    async run(input, ctx) {
        const { state } = await readRouletteState(ctx.channelId);
        if (state.roulettes.length >= 20) throw new ToolInputError('A channel supports up to 20 saved roulettes');
        if (findRoulette(state, input.config.alias as string)) throw new ToolInputError('That alias is already used by another roulette');
        const preview = domainCheck(() => domain.create(structuredClone(input.config)));
        const proposal: ChangeProposal = {
            tool: 'create_roulette',
            title: tr(ctx.lang, `Create the roulette "${preview.name}"`, `Crear la ruleta "${preview.name}"`),
            area: 'roulettes', target: target(ctx.lang, { id: null, name: preview.name }),
            before: null, after: configView(preview), effects: [], warnings: [],
            permissions: [...ROULETTE_PERMISSIONS],
            payload: { config: input.config }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { config } = proposal.payload as { config: Record<string, unknown> };
        const { revision } = await readRouletteState(ctx.channelId);
        const id = await run(ctx, { operation: 'create', data: config }, revision);
        const created = findRoulette((await readRouletteState(ctx.channelId)).state, id);
        return {
            result: { created: true, id },
            change: { area: 'roulettes', target: target(ctx.lang, { id, name: String(config.name) }), before: null, after: proposal.after,
                undo: created ? { id, after: configView(created) } : null, summary: proposal.title }
        };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; after: Record<string, unknown> };
        const { revision, state } = await readRouletteState(ctx.channelId);
        const roulette = findRoulette(state, data.id);
        if (!roulette) conflict(ctx.lang, 'This roulette was already deleted.', 'Esta ruleta ya se eliminó.');
        if (roulette.items.length || !sameValue(configView(roulette), data.after)) conflict(ctx.lang, 'This roulette was changed or got prizes after it was created, so it was not deleted.', 'Esta ruleta cambió o recibió premios después de crearse; no se eliminó.');
        await run(ctx, { operation: 'delete', roulette: data.id }, revision);
    }
};

export interface RouletteUpdateInput { roulette: string; config: Record<string, unknown> }
export const updateRoulette: AgentTool<RouletteUpdateInput> = {
    name: 'update_roulette',
    kind: 'write',
    permissions: ROULETTE_PERMISSIONS,
    description: 'Change a roulette\'s setup (Modules → Roulette): name, alias, design (wheel, cards, reel, elimination), cardSize, spin durationSeconds, colors, and settings (insertion, duplicate names, what happens to the winner, shuffle before each spin, show on start, hide after). Only the fields you send change. Not possible while it is spinning. The user approves first; it can be undone.',
    parameters: { type: 'object', additionalProperties: false, required: ['roulette'], properties: { roulette: rouletteRef, ...configSchema } },
    label: (_input, lang) => tr(lang, 'Preparing the roulette change…', 'Preparando el cambio de la ruleta…'),
    validate(raw) {
        const input = asObject(raw);
        const config = configInput(input, false);
        if (!Object.keys(config).length) throw new ToolInputError('Give at least one roulette setting to change');
        return { roulette: str(input, 'roulette', { required: true, max: 100 })!, config };
    },
    async run(input, ctx) {
        const { state } = await readRouletteState(ctx.channelId);
        const roulette = findRoulette(state, input.roulette);
        if (!roulette) throw new ToolInputError(`No roulette "${input.roulette}". Use get_settings area "roulettes".`);
        if (input.config.alias && state.roulettes.some((r) => r.id !== roulette.id && (r.alias === input.config.alias || r.id === input.config.alias))) throw new ToolInputError('That alias is already used by another roulette');
        const next = structuredClone(roulette);
        domainCheck(() => domain.configure(next, structuredClone(input.config)));
        const before = configView(roulette), after = configView(next);
        if (sameValue(before, after)) return { type: 'result', result: { unchanged: true, message: 'The roulette already has those settings. Nothing to change.' }, summary: tr(ctx.lang, 'Already set', 'Ya estaba así') };
        const proposal: ChangeProposal = {
            tool: 'update_roulette',
            title: tr(ctx.lang, `Change the roulette "${roulette.name}"`, `Cambiar la ruleta "${roulette.name}"`),
            area: 'roulettes', target: target(ctx.lang, roulette),
            before, after, effects: [],
            warnings: state.activeId === roulette.id ? [tr(ctx.lang, 'This is the active roulette: the last result card on the overlay is cleared.', 'Es la ruleta activa: se borra la última tarjeta de resultado del overlay.')] : [],
            permissions: [...ROULETTE_PERMISSIONS],
            payload: { id: roulette.id, config: input.config, expected: before }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, config, expected } = proposal.payload as { id: string; config: Record<string, unknown>; expected: Record<string, unknown> };
        const { revision, state } = await readRouletteState(ctx.channelId);
        const roulette = findRoulette(state, id);
        if (!roulette) conflict(ctx.lang, 'This roulette was deleted in the meantime. Nothing was changed.', 'Esta ruleta se eliminó mientras tanto. No se cambió nada.');
        if (!sameValue(configView(roulette), expected)) conflict(ctx.lang, 'This roulette changed since this was prepared. Nothing was changed; ask again for a fresh proposal.', 'Esta ruleta cambió desde que se preparó este cambio. No se cambió nada; vuelve a pedirlo.');
        await run(ctx, { operation: 'configure', roulette: id, data: config }, revision);
        const saved = findRoulette((await readRouletteState(ctx.channelId)).state, id)!;
        return { result: { saved: true, id }, change: { area: 'roulettes', target: proposal.target, before: proposal.before, after: proposal.after, undo: { id, before: expected, after: configView(saved) }, summary: proposal.title } };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; before: Record<string, unknown>; after: Record<string, unknown> };
        const { revision, state } = await readRouletteState(ctx.channelId);
        const roulette = findRoulette(state, data.id);
        if (!roulette) conflict(ctx.lang, 'This roulette was deleted, so the change cannot be undone.', 'Esta ruleta se eliminó; el cambio no se puede deshacer.');
        if (!sameValue(configView(roulette), data.after)) conflict(ctx.lang, 'This roulette was changed again after this change, so it was not undone.', 'Esta ruleta se volvió a cambiar después de este cambio; no se deshizo.');
        await run(ctx, { operation: 'configure', roulette: data.id, data: data.before }, revision);
    }
};

export interface RouletteItemsInput { roulette: string; items: ItemInput[] }
export const addRouletteItems: AgentTool<RouletteItemsInput> = {
    name: 'add_roulette_items',
    kind: 'write',
    permissions: ROULETTE_PERMISSIONS,
    description: `Add prizes to a roulette (Modules → Roulette → prizes, like Import prizes): each item has a label, optional weight (chance per copy, default 1), count (copies/slots, default 1) and winnerAction (a command body that runs when it wins, e.g. $(tts ...) or a timeout: check it carefully). All or nothing, up to ${MAX_ITEMS_PER_CALL} per call. With the "increase" duplicate setting, a repeated label adds copies to the existing prize. Design limits: cards 50–100 copies, reel 60, elimination 100. The user approves first; it can be undone.`,
    parameters: { type: 'object', additionalProperties: false, required: ['roulette', 'items'], properties: { roulette: rouletteRef, items: { type: 'array', minItems: 1, maxItems: MAX_ITEMS_PER_CALL, items: itemSchema } } },
    label: (_input, lang) => tr(lang, 'Preparing the prizes…', 'Preparando los premios…'),
    validate(raw) {
        const input = asObject(raw);
        if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_ITEMS_PER_CALL) throw new ToolInputError(`items must be a list of 1–${MAX_ITEMS_PER_CALL} prizes`);
        return { roulette: str(input, 'roulette', { required: true, max: 100 })!, items: input.items.map(itemInput) };
    },
    async run(input, ctx) {
        const { state } = await readRouletteState(ctx.channelId);
        const roulette = findRoulette(state, input.roulette);
        if (!roulette) throw new ToolInputError(`No roulette "${input.roulette}". Use get_settings area "roulettes".`);
        for (const item of input.items) checkAction(item.winnerAction, item.label);
        const data = { items: input.items.map(toItemData) };
        const next = structuredClone(roulette);
        domainCheck(() => domain.importItems(next, structuredClone(data)));
        const effects = await actionEffects(input.items.map((item) => ({ label: item.label, action: item.winnerAction })), ctx);
        const proposal: ChangeProposal = {
            tool: 'add_roulette_items',
            title: tr(ctx.lang, `Add ${input.items.length} prize(s) to "${roulette.name}"`, `Agregar ${input.items.length} premio(s) a "${roulette.name}"`),
            area: 'roulettes', target: target(ctx.lang, roulette),
            before: { prizes: roulette.items.length, copies: roulette.order.length },
            after: { prizes: next.items.length, copies: next.order.length, added: input.items.map((item) => itemView({ id: '', label: item.label, weight: item.weight ?? 1, multiplier: item.count ?? 1, copies: [], action: item.winnerAction })) },
            effects: effects.effects, warnings: effects.warnings,
            permissions: [...ROULETTE_PERMISSIONS],
            payload: { id: roulette.id, data, expectedItems: itemsHash(roulette) }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, data, expectedItems } = proposal.payload as { id: string; data: Record<string, unknown>; expectedItems: string };
        const { revision, state } = await readRouletteState(ctx.channelId);
        const roulette = findRoulette(state, id);
        if (!roulette) conflict(ctx.lang, 'This roulette was deleted in the meantime. Nothing was changed.', 'Esta ruleta se eliminó mientras tanto. No se cambió nada.');
        if (itemsHash(roulette) !== expectedItems) conflict(ctx.lang, 'The prizes changed since this was prepared. Nothing was changed; ask again for a fresh proposal.', 'Los premios cambiaron desde que se preparó este cambio. No se cambió nada; vuelve a pedirlo.');
        await run(ctx, { operation: 'import', roulette: id, data }, revision);
        const saved = findRoulette((await readRouletteState(ctx.channelId)).state, id)!;
        const known = new Map(roulette.items.map((item) => [item.id, itemView(item)]));
        const added = saved.items.filter((item) => !known.has(item.id)).map((item) => ({ id: item.id, after: itemView(item) }));
        const increased = saved.items.filter((item) => known.has(item.id) && known.get(item.id)!.count !== item.multiplier)
            .map((item) => ({ id: item.id, count: known.get(item.id)!.count, after: itemView(item) }));
        return { result: { added: added.length, increased: increased.length }, change: { area: 'roulettes', target: proposal.target, before: proposal.before, after: proposal.after, undo: { id, added, increased }, summary: proposal.title } };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; added: Array<{ id: string; after: ReturnType<typeof itemView> }>; increased: Array<{ id: string; count: number; after: ReturnType<typeof itemView> }> };
        const read = await readRouletteState(ctx.channelId);
        const roulette = findRoulette(read.state, data.id);
        if (!roulette) conflict(ctx.lang, 'This roulette was deleted, so the prizes cannot be removed.', 'Esta ruleta se eliminó; no se pueden quitar los premios.');
        for (const entry of [...data.added, ...data.increased]) {
            const item = roulette.items.find((candidate) => candidate.id === entry.id);
            if (!item || !sameValue(itemView(item), entry.after)) conflict(ctx.lang, 'Some of these prizes changed or were removed after they were added, so nothing was undone.', 'Algunos de estos premios cambiaron o se quitaron después de agregarse; no se deshizo nada.');
        }
        // One roulette operation per prize. The first writes against the revision checked above and each
        // next one against the revision the previous step produced, so any other save in between stops it.
        const steps: Action[] = [
            ...data.added.map((entry): Action => ({ operation: 'remove', roulette: data.id, itemId: entry.id })),
            ...data.increased.map((entry): Action => ({ operation: 'update', roulette: data.id, itemId: entry.id, data: { multiplier: entry.count } }))
        ];
        let revision = read.revision;
        for (const [index, step] of steps.entries()) {
            try {
                revision = (await runAt(ctx, step, revision)).revision;
            } catch (error) {
                if (!(error instanceof ToolConflictError) || index === 0) throw error;
                throw new ToolConflictError(tr(ctx.lang,
                    `The roulette changed while undoing, so the undo stopped after ${index} of ${steps.length} prizes. Check the roulette page.`,
                    `La ruleta cambió mientras se deshacía, así que se detuvo después de ${index} de ${steps.length} premios. Revisa la página de la ruleta.`));
            }
        }
    }
};

export interface RouletteItemUpdateInput { roulette: string; itemId: string; changes: Partial<ItemInput> }
export const updateRouletteItem: AgentTool<RouletteItemUpdateInput> = {
    name: 'update_roulette_item',
    kind: 'write',
    permissions: ROULETTE_PERMISSIONS,
    description: 'Edit one roulette prize (Modules → Roulette): label, weight (chance per copy), count (copies) or winnerAction (command body run when it wins; empty text removes it). Item ids come from get_settings area "roulettes". The user approves first; it can be undone.',
    parameters: { type: 'object', additionalProperties: false, required: ['roulette', 'itemId'], properties: { roulette: rouletteRef, itemId: { type: 'string' }, label: { type: 'string', maxLength: 120 },
        weight: { type: 'integer', minimum: 1 }, count: { type: 'integer', minimum: 1, maximum: 10000 }, winnerAction: { type: 'string', maxLength: 8000 } } },
    label: (_input, lang) => tr(lang, 'Preparing the prize change…', 'Preparando el cambio del premio…'),
    validate(raw) {
        const input = asObject(raw);
        const changes: Partial<ItemInput> = {
            label: str(input, 'label', { max: 120 }), weight: int(input, 'weight', { min: 1, max: 1_000_000_000 }),
            count: int(input, 'count', { min: 1, max: 10000 }),
            winnerAction: typeof input.winnerAction === 'string' ? str(input, 'winnerAction', { max: 8000 }) ?? '' : undefined
        };
        if (!Object.values(changes).some((value) => value !== undefined)) throw new ToolInputError('Give a label, weight, count or winnerAction to change');
        return { roulette: str(input, 'roulette', { required: true, max: 100 })!, itemId: str(input, 'itemId', { required: true, max: 100 })!, changes };
    },
    async run(input, ctx) {
        const { state } = await readRouletteState(ctx.channelId);
        const roulette = findRoulette(state, input.roulette);
        if (!roulette) throw new ToolInputError(`No roulette "${input.roulette}". Use get_settings area "roulettes".`);
        const item = roulette.items.find((candidate) => candidate.id === input.itemId);
        if (!item) throw new ToolInputError(`No prize ${input.itemId} in "${roulette.name}".`);
        checkAction(input.changes.winnerAction, input.changes.label ?? item.label);
        const data = toItemData(input.changes);
        const next = structuredClone(roulette);
        const updated = domainCheck(() => domain.updateItem(next, item.id, structuredClone(data)));
        if (sameValue(itemView(item), itemView(updated))) return { type: 'result', result: { unchanged: true, message: 'The prize already has those values. Nothing to change.' }, summary: tr(ctx.lang, 'Already set', 'Ya estaba así') };
        const effects = input.changes.winnerAction !== undefined ? await actionEffects([{ label: updated.label, action: updated.action }], ctx) : { effects: [], warnings: [] };
        const proposal: ChangeProposal = {
            tool: 'update_roulette_item',
            title: tr(ctx.lang, `Edit the prize "${item.label}"`, `Editar el premio "${item.label}"`),
            area: 'roulettes', target: { type: 'roulette_item', id: item.id, label: `${roulette.name} · ${item.label}` },
            before: itemView(item), after: itemView(updated), effects: effects.effects, warnings: effects.warnings,
            permissions: [...ROULETTE_PERMISSIONS],
            payload: { id: roulette.id, itemId: item.id, data, expected: itemView(item) }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, itemId, data, expected } = proposal.payload as { id: string; itemId: string; data: Record<string, unknown>; expected: ReturnType<typeof itemView> };
        const { revision, state } = await readRouletteState(ctx.channelId);
        const item = findRoulette(state, id)?.items.find((candidate) => candidate.id === itemId);
        if (!item) conflict(ctx.lang, 'This prize was removed in the meantime. Nothing was changed.', 'Este premio se quitó mientras tanto. No se cambió nada.');
        if (!sameValue(itemView(item), expected)) conflict(ctx.lang, 'This prize changed since this was prepared. Nothing was changed; ask again for a fresh proposal.', 'Este premio cambió desde que se preparó este cambio. No se cambió nada; vuelve a pedirlo.');
        await run(ctx, { operation: 'update', roulette: id, itemId, data }, revision);
        const saved = findRoulette((await readRouletteState(ctx.channelId)).state, id)?.items.find((candidate) => candidate.id === itemId);
        return { result: { saved: true, itemId }, change: { area: 'roulettes', target: proposal.target, before: proposal.before, after: proposal.after, undo: saved ? { id, itemId, before: expected, after: itemView(saved) } : null, summary: proposal.title } };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; itemId: string; before: ReturnType<typeof itemView>; after: ReturnType<typeof itemView> };
        const { revision, state } = await readRouletteState(ctx.channelId);
        const item = findRoulette(state, data.id)?.items.find((candidate) => candidate.id === data.itemId);
        if (!item) conflict(ctx.lang, 'This prize was removed, so the change cannot be undone.', 'Este premio se quitó; el cambio no se puede deshacer.');
        if (!sameValue(itemView(item), data.after)) conflict(ctx.lang, 'This prize was changed again after this change, so it was not undone.', 'Este premio se volvió a cambiar después de este cambio; no se deshizo.');
        await run(ctx, { operation: 'update', roulette: data.id, itemId: data.itemId, data: { label: data.before.label, weight: data.before.weight, multiplier: data.before.count, action: data.before.winnerAction } }, revision);
    }
};

export interface RouletteItemRemoveInput { roulette: string; itemId: string }
export const removeRouletteItem: AgentTool<RouletteItemRemoveInput> = {
    name: 'remove_roulette_item',
    kind: 'write',
    permissions: ROULETTE_PERMISSIONS,
    description: 'Remove one prize (and all its copies) from a roulette (Modules → Roulette). Item ids come from get_settings area "roulettes". The user approves first; undo adds the prize back (as a new prize at the end).',
    parameters: { type: 'object', additionalProperties: false, required: ['roulette', 'itemId'], properties: { roulette: rouletteRef, itemId: { type: 'string' } } },
    label: (_input, lang) => tr(lang, 'Preparing to remove the prize…', 'Preparando para quitar el premio…'),
    validate(raw) {
        const input = asObject(raw);
        return { roulette: str(input, 'roulette', { required: true, max: 100 })!, itemId: str(input, 'itemId', { required: true, max: 100 })! };
    },
    async run(input, ctx) {
        const { state } = await readRouletteState(ctx.channelId);
        const roulette = findRoulette(state, input.roulette);
        if (!roulette) throw new ToolInputError(`No roulette "${input.roulette}". Use get_settings area "roulettes".`);
        const item = roulette.items.find((candidate) => candidate.id === input.itemId);
        if (!item) throw new ToolInputError(`No prize ${input.itemId} in "${roulette.name}".`);
        const proposal: ChangeProposal = {
            tool: 'remove_roulette_item',
            title: tr(ctx.lang, `Remove the prize "${item.label}"`, `Quitar el premio "${item.label}"`),
            area: 'roulettes', target: { type: 'roulette_item', id: item.id, label: `${roulette.name} · ${item.label}` },
            before: itemView(item), after: null, effects: [], warnings: [],
            permissions: [...ROULETTE_PERMISSIONS],
            payload: { id: roulette.id, itemId: item.id, expected: itemView(item) }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, itemId, expected } = proposal.payload as { id: string; itemId: string; expected: ReturnType<typeof itemView> };
        const { revision, state } = await readRouletteState(ctx.channelId);
        const item = findRoulette(state, id)?.items.find((candidate) => candidate.id === itemId);
        if (!item) conflict(ctx.lang, 'This prize was already removed.', 'Este premio ya se quitó.');
        if (!sameValue(itemView(item), expected)) conflict(ctx.lang, 'This prize changed since this was prepared. Nothing was changed; ask again for a fresh proposal.', 'Este premio cambió desde que se preparó este cambio. No se cambió nada; vuelve a pedirlo.');
        await run(ctx, { operation: 'remove', roulette: id, itemId }, revision);
        return { result: { removed: true, itemId }, change: { area: 'roulettes', target: proposal.target, before: proposal.before, after: null, undo: { id, item: expected }, summary: proposal.title } };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; item: ReturnType<typeof itemView> };
        const { revision, state } = await readRouletteState(ctx.channelId);
        if (!findRoulette(state, data.id)) conflict(ctx.lang, 'This roulette was deleted, so the prize cannot come back.', 'Esta ruleta se eliminó; el premio no puede volver.');
        await run(ctx, { operation: 'add', roulette: data.id, data: { label: data.item.label, weight: data.item.weight, multiplier: data.item.count, ...(data.item.winnerAction ? { action: data.item.winnerAction } : {}) } }, revision);
    }
};

export const rouletteTools: AgentTool[] = [createRoulette, updateRoulette, addRouletteItems, updateRouletteItem, removeRouletteItem] as unknown as AgentTool[];
