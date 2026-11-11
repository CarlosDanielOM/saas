import EventsubSchema from '../../../../schemas/eventsub.schema.js';
import { EventSchema, type IEvent } from '../../../../schemas/event.schema.js';
import {
    createChannelEventsub,
    dedupeNormalizedEventsubs,
    deleteChannelEventsub,
    NON_DISABLEABLE_EVENT_TYPES,
    RAID_EVENT_FIELDS,
    updateChannelEventsub
} from '../../../../server/services/eventsub_config.service.js';
import { canonicalizeEventsubType, getEquivalentEventsubTypes } from '../../../../utils/eventsub.js';
import { getBuiltinChatEvent, withBuiltinChatEvents } from '../../../../utils/chat_event_catalog.js';
import { OUTGOING_RAID_EVENT, isRaidEvent } from '../../../../utils/raid_direction.js';
import { TWITCH_BOT_ACCOUNT_ID } from '../../../../utils/header.js';
import { ToolInputError, type AgentTool, type ChangeProposal, type Lang, type ToolContext } from '../../../types.js';
import { asObject, bool, str } from '../../util.js';
import { PLAN_RANK, assertUnchanged, bodyEffects, conflict, display, hasFullAccess, mergeEffects, needsFullAccessResult, pickPaths, routeMessage, sameValue, tr, type FieldLabel } from './common.js';

/**
 * Chat events (Modules → Chat Events): the messages the bot posts for Twitch events. Each event is
 * a Twitch EventSub subscription. Routes: POST/PATCH/DELETE /eventsubs/:channelID (`eventsubs:manage`).
 */

export const CHAT_EVENT_PERMISSIONS = ['eventsubs:manage'] as const;

type CatalogEvent = Pick<IEvent, 'name' | 'type' | 'version' | 'condition' | 'plan_tier' | 'releaseStage' | 'description' | 'config'>;
const CONTROL_KEY_FALLBACKS: Record<string, string> = { adBeginMessage: 'message', adBreakMessage: 'message', beginMessage: 'message', enableClip: 'clipEnabled' };
const UNAVAILABLE_STAGES = new Set(['coming_soon', 'unavailable', 'deprecated', 'maintenance']);
const MAX_MESSAGE = 500;

/** Same key the page writes for a catalog control. */
export const persistenceKey = (control: { id: string; dbId?: string }): string => control.dbId?.trim() || CONTROL_KEY_FALLBACKS[control.id] || control.id;

/** Catalog events (DB + built-ins), one per canonical type, like GET /site/events. */
export async function chatEventCatalog(): Promise<CatalogEvent[]> {
    const events = withBuiltinChatEvents(await EventSchema.find().sort({ createdAt: -1 }).lean() as CatalogEvent[]) as CatalogEvent[];
    const byType = new Map<string, CatalogEvent>();
    for (const event of events) {
        const key = canonicalizeEventsubType(event.type);
        const previous = byType.get(key);
        if (!previous || (event.type === key && previous.type !== key)) byType.set(key, { ...event, type: key });
    }
    return [...byType.values()];
}

export async function catalogEvent(type: string): Promise<CatalogEvent | null> {
    const canonical = canonicalizeEventsubType(type);
    const rows = await EventSchema.find({ type: { $in: getEquivalentEventsubTypes(canonical) } }).lean() as CatalogEvent[];
    const row = rows.find((event) => event.type === canonical) ?? rows[0] ?? getBuiltinChatEvent(canonical) ?? null;
    return row ? { ...row, type: canonical } : null;
}

/** The channel's config for one chat event type (the one the page shows), or null. */
export async function channelEventsub(channelId: string, type: string): Promise<Record<string, any> | null> {
    const canonical = canonicalizeEventsubType(type);
    const rows = await EventsubSchema.find({
        channelID: channelId,
        type: { $in: getEquivalentEventsubTypes(canonical === OUTGOING_RAID_EVENT ? 'channel.raid' : canonical) },
        ...(isRaidEvent(canonical) ? { [`condition.${canonical === OUTGOING_RAID_EVENT ? 'from' : 'to'}_broadcaster_user_id`]: channelId } : {})
    }).lean();
    return dedupeNormalizedEventsubs(rows as Record<string, any>[]).find((row) => row.type === canonical) ?? null;
}

interface FieldSpec { key: string; type: 'text' | 'number' | 'checkbox' | 'select'; label: FieldLabel; defaultValue: unknown }

/** Editable fields of an event: its catalog controls (Bits rules have their own tools), plus on/off. */
export function eventFields(event: CatalogEvent): FieldSpec[] {
    const fields = (event.config ?? []).filter((control) => control.type !== 'message-tiers' && control.id !== 'cheerTiers').map((control) => ({
        key: persistenceKey(control), type: control.type as FieldSpec['type'],
        label: { en: control.label?.EN ?? control.id, es: control.label?.ES ?? control.id }, defaultValue: control.value
    }));
    const unique = fields.filter((field, index) => fields.findIndex((other) => other.key === field.key) === index);
    return isRaidEvent(event.type) ? unique.filter((field) => RAID_EVENT_FIELDS.has(field.key)) : unique;
}

const ENABLED_LABEL: FieldLabel = { en: 'On', es: 'Activado' };
function labelsOf(fields: FieldSpec[]): Record<string, FieldLabel> {
    return { enabled: ENABLED_LABEL, ...Object.fromEntries(fields.map((field) => [field.key, field.label])) };
}

function checkFieldValues(event: CatalogEvent, raw: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!raw) return {};
    const specs = new Map(eventFields(event).map((field) => [field.key, field]));
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        const spec = specs.get(key);
        if (!spec) throw new ToolInputError(`${event.type} has no field "${key}". Fields: ${[...specs.keys()].join(', ') || 'none (only on/off)'}`);
        if (spec.type === 'checkbox') { if (typeof value !== 'boolean') throw new ToolInputError(`${key} must be true or false`); }
        else if (spec.type === 'number') { if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) throw new ToolInputError(`${key} must be a whole number of 0 or more`); }
        else if (typeof value !== 'string' || value.length > MAX_MESSAGE) throw new ToolInputError(`${key} must be text up to ${MAX_MESSAGE} characters`);
        values[key] = value;
    }
    return values;
}

function planBlock(event: CatalogEvent, ctx: Pick<ToolContext, 'plan' | 'lang'>): string | null {
    const required = event.plan_tier === 'premium' || event.plan_tier === 'pro' ? event.plan_tier : 'free';
    return PLAN_RANK[ctx.plan] >= PLAN_RANK[required] ? null
        : tr(ctx.lang, `This event needs the ${required === 'pro' ? 'Pro' : 'Premium'} plan.`, `Este evento necesita el plan ${required === 'pro' ? 'Pro' : 'Premium'}.`);
}

/** Effects of the text fields (messages can run $(...) functions when the event fires). */
async function messageEffects(values: Record<string, unknown>, fields: FieldSpec[], ctx: Pick<ToolContext, 'plan' | 'lang'>) {
    const parts = await Promise.all(fields.filter((field) => field.type === 'text' && typeof values[field.key] === 'string')
        .map((field) => bodyEffects(values[field.key] as string, ctx, field.label[ctx.lang])));
    return mergeEffects(...parts);
}

function eventName(event: CatalogEvent | null, type: string): string { return event?.name ?? type; }

interface TypeInput { type: string; enabled?: boolean; fields?: Record<string, unknown> }

function typeInput(raw: unknown, mode: 'create' | 'update' | 'delete'): TypeInput {
    const input = asObject(raw);
    const type = str(input, 'type', { required: true, max: 100 })!;
    const fields = input.fields === undefined || input.fields === null ? undefined : asObject(input.fields);
    const value: TypeInput = { type: canonicalizeEventsubType(type), enabled: mode === 'delete' ? undefined : bool(input, 'enabled'), fields: mode === 'delete' ? undefined : fields };
    if (mode === 'update' && value.enabled === undefined && !Object.keys(fields ?? {}).length) throw new ToolInputError('Give enabled or at least one field to change');
    return value;
}

const typeParameter = { type: 'string', description: 'Event type from get_settings area "chat_events", e.g. channel.follow, channel.raid, channel.raid.outgoing, channel.subscribe, channel.bits.use, channel.ad_break.begin' };
const fieldsParameter = { type: 'object', description: 'Field key → value, using the field keys get_settings lists for that event (e.g. message, minViewers, clipEnabled, endMessage, endEnabled). Messages can use the event variables like $(user).' };

function proposalBase(ctx: ToolContext, tool: string, title: string, event: CatalogEvent | null, type: string, id: string | null): Pick<ChangeProposal, 'tool' | 'title' | 'area' | 'target' | 'permissions'> {
    return { tool, title, area: 'chat_events', target: { type: 'chat_event', id, label: eventName(event, type) }, permissions: [...CHAT_EVENT_PERMISSIONS] };
}

/** Fields stored on the subscription document for `keys`. */
const stored = (doc: Record<string, unknown> | null, keys: string[]) => pickPaths(doc ?? {}, keys);

export const createChatEvent: AgentTool<TypeInput> = {
    name: 'create_chat_event',
    kind: 'write',
    permissions: CHAT_EVENT_PERMISSIONS,
    description: [
        'Turn on a chat event the channel does not have yet (Modules → Chat Events): the bot posts a message in chat when that Twitch event happens (follow, raid, sub, gifted subs, resub, Bits, ad break, Hype Train, shoutout received, stream online/offline...).',
        'This subscribes the channel to the Twitch EventSub event. Needs full access (the bot activated on Twitch). Some events need Premium or Pro.',
        'fields: optional values for the event\'s settings (keys from get_settings area "chat_events"); unset fields use the catalog defaults. An empty message makes the event silent.',
        'If the event already exists, use update_chat_event. The user approves first; it can be undone (removes the subscription).'
    ].join(' '),
    parameters: { type: 'object', additionalProperties: false, required: ['type'], properties: { type: typeParameter, enabled: { type: 'boolean', description: 'Default true' }, fields: fieldsParameter } },
    label: (_input, lang) => tr(lang, 'Preparing the chat event…', 'Preparando el evento de chat…'),
    validate: (raw) => typeInput(raw, 'create'),
    async run(input, ctx) {
        const event = await catalogEvent(input.type);
        if (!event) throw new ToolInputError(`Unknown chat event type ${input.type}. Use get_settings area "chat_events".`);
        if (UNAVAILABLE_STAGES.has(event.releaseStage)) throw new ToolInputError(`${event.name} is not available yet (${event.releaseStage}).`);
        const blocked = planBlock(event, ctx);
        if (blocked) return { type: 'result', result: { planRequired: true, message: blocked }, summary: blocked };
        if (await channelEventsub(ctx.channelId, event.type)) throw new ToolInputError(`${event.name} is already set up on this channel; use update_chat_event.`);
        if (!await hasFullAccess(ctx.channelId)) return needsFullAccessResult(ctx.lang);
        const condition: Record<string, string> = {};
        for (const [key, source] of Object.entries((event.condition ?? {}) as Record<string, string>)) {
            if (source === 'channel') throw new ToolInputError(`${event.name} needs manual setup on the Chat Events page.`);
            condition[key] = source === 'user' ? ctx.channelId : source === 'moderator' ? TWITCH_BOT_ACCOUNT_ID : source;
        }
        const fields = eventFields(event);
        const values = checkFieldValues(event, input.fields);
        const config: Record<string, unknown> = Object.fromEntries(fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.key, field.defaultValue]));
        Object.assign(config, values);
        if (input.enabled === false) config.enabled = false;
        const shownAfter = { enabled: input.enabled ?? true, ...pickPaths(config, fields.map((field) => field.key)) };
        const effects = await messageEffects(config, fields, ctx);
        const proposal: ChangeProposal = {
            ...proposalBase(ctx, 'create_chat_event', tr(ctx.lang, `Turn on the chat event "${event.name}"`, `Activar el evento de chat "${event.name}"`), event, event.type, null),
            before: null,
            after: display(shownAfter, labelsOf(fields), ctx.lang),
            effects: [tr(ctx.lang, `Subscribes the channel to the Twitch event ${event.type} (EventSub)`, `Suscribe el canal al evento de Twitch ${event.type} (EventSub)`), ...effects.effects],
            warnings: effects.warnings,
            payload: { body: { type: event.type, version: event.version || '1', condition, config }, after: shownAfter }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { body, after } = proposal.payload as { body: { type: string; version: string; condition: Record<string, string>; config: Record<string, unknown> }; after: Record<string, unknown> };
        if (await channelEventsub(ctx.channelId, body.type)) conflict(ctx.lang, 'This chat event was set up somewhere else in the meantime. Nothing was changed.', 'Este evento de chat se configuró en otro lugar mientras tanto. No se cambió nada.');
        const result = await createChannelEventsub(ctx.channelId, body);
        if (result.status >= 300) throw new Error(routeMessage(result.body, 'Could not create the chat event'));
        const created = await channelEventsub(ctx.channelId, body.type);
        return {
            result: { created: true, type: body.type },
            change: {
                area: 'chat_events', target: { ...proposal.target, id: created?._id ? String(created._id) : null }, before: null, after: proposal.after,
                undo: { type: body.type, id: created?._id ? String(created._id) : null, after: stored(created, Object.keys(after)) },
                summary: proposal.title
            }
        };
    },
    async undo(change, ctx) {
        const data = change.undo as { type: string; id: string | null; after: Record<string, unknown> };
        const current = await channelEventsub(ctx.channelId, data.type);
        if (!current || (data.id && String(current._id) !== data.id)) conflict(ctx.lang, 'This chat event was already removed.', 'Este evento de chat ya se eliminó.');
        assertUnchanged(current, data.after, ctx.lang, tr(ctx.lang, 'The chat event', 'El evento de chat'));
        const result = await deleteChannelEventsub(ctx.channelId, String(current._id));
        if (result.status >= 300) throw new Error(routeMessage(result.body, 'Could not remove the chat event'));
    }
};

export const updateChatEvent: AgentTool<TypeInput> = {
    name: 'update_chat_event',
    kind: 'write',
    permissions: CHAT_EVENT_PERMISSIONS,
    description: [
        'Change a chat event the channel already has (Modules → Chat Events): turn it on/off (off keeps the Twitch subscription) or edit its fields, e.g. the message the bot posts, the end message of ad breaks, minimum raid viewers, the raid clip.',
        'Field keys come from get_settings area "chat_events". Stream online/offline cannot be turned off: clear their message to silence them. Bits rules for different amounts use the bits rule tools.',
        'The user approves first; it can be undone.'
    ].join(' '),
    parameters: { type: 'object', additionalProperties: false, required: ['type'], properties: { type: typeParameter, enabled: { type: 'boolean' }, fields: fieldsParameter } },
    label: (_input, lang) => tr(lang, 'Preparing the chat event change…', 'Preparando el cambio del evento de chat…'),
    validate: (raw) => typeInput(raw, 'update'),
    async run(input, ctx) {
        const [event, current] = await Promise.all([catalogEvent(input.type), channelEventsub(ctx.channelId, input.type)]);
        if (!event) throw new ToolInputError(`Unknown chat event type ${input.type}. Use get_settings area "chat_events".`);
        if (!current) throw new ToolInputError(`${event.name} is not set up on this channel yet; use create_chat_event.`);
        if (input.enabled === false && NON_DISABLEABLE_EVENT_TYPES.has(current.type)) {
            throw new ToolInputError(`${event.name} cannot be turned off. Clear its message to silence it.`);
        }
        const blocked = planBlock(event, ctx);
        if (blocked) return { type: 'result', result: { planRequired: true, message: blocked }, summary: blocked };
        const fields = eventFields(event);
        const wanted: Record<string, unknown> = { ...checkFieldValues(event, input.fields), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) };
        const keys = Object.keys(wanted).filter((key) => !sameValue(current[key] ?? null, wanted[key]));
        if (!keys.length) return { type: 'result', result: { unchanged: true, message: `${event.name} already has those values. Nothing to change.` }, summary: tr(ctx.lang, 'Already set', 'Ya estaba así') };
        const after = Object.fromEntries(keys.map((key) => [key, wanted[key]]));
        const before = stored(current, keys);
        const effects = await messageEffects(after, fields, ctx);
        const proposal: ChangeProposal = {
            ...proposalBase(ctx, 'update_chat_event', tr(ctx.lang, `Change the chat event "${event.name}"`, `Cambiar el evento de chat "${event.name}"`), event, event.type, String(current._id)),
            before: display(before, labelsOf(fields), ctx.lang),
            after: display(after, labelsOf(fields), ctx.lang),
            effects: effects.effects,
            warnings: effects.warnings,
            payload: { id: String(current._id), type: event.type, before, after, expected: before }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, type, before, after, expected } = proposal.payload as { id: string; type: string; before: Record<string, unknown>; after: Record<string, unknown>; expected: Record<string, unknown> };
        const current = await EventsubSchema.findOne({ _id: id, channelID: ctx.channelId }).lean();
        if (!current) conflict(ctx.lang, 'This chat event was removed in the meantime. Nothing was changed.', 'Este evento de chat se eliminó mientras tanto. No se cambió nada.');
        assertUnchanged(current, expected, ctx.lang, tr(ctx.lang, 'The chat event', 'El evento de chat'));
        // The fields this change touches must still be as just read when the write lands.
        const result = await updateChannelEventsub(ctx.channelId, id, after, { guard: stored(current, Object.keys(expected)) });
        if (result.status === 409 && result.body.code === 'changed') conflict(ctx.lang, 'This chat event changed while saving. Nothing was changed; ask again for a fresh proposal.', 'Este evento de chat cambió mientras se guardaba. No se cambió nada; vuelve a pedirlo.');
        if (result.status >= 300) throw new Error(routeMessage(result.body, 'Could not update the chat event'));
        return {
            result: { saved: true, type },
            change: { area: 'chat_events', target: proposal.target, before: proposal.before, after: proposal.after, undo: { id, type, before, after }, summary: proposal.title }
        };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; before: Record<string, unknown>; after: Record<string, unknown> };
        const current = await EventsubSchema.findOne({ _id: data.id, channelID: ctx.channelId }).lean();
        if (!current) conflict(ctx.lang, 'This chat event was removed, so the change cannot be undone.', 'Este evento de chat se eliminó; el cambio no se puede deshacer.');
        assertUnchanged(current, data.after, ctx.lang, tr(ctx.lang, 'The chat event', 'El evento de chat'));
        const restore = Object.fromEntries(Object.entries(data.before).filter(([, value]) => value !== null));
        const result = await updateChannelEventsub(ctx.channelId, data.id, restore, { guard: stored(current, Object.keys(data.after)) });
        if (result.status === 409 && result.body.code === 'changed') conflict(ctx.lang, 'This chat event was edited again while undoing, so it was left as it is now.', 'Este evento de chat se volvió a editar mientras se deshacía; se dejó como está ahora.');
        if (result.status >= 300) throw new Error(routeMessage(result.body, 'Could not restore the chat event'));
    }
};

export const deleteChatEvent: AgentTool<TypeInput> = {
    name: 'delete_chat_event',
    kind: 'write',
    permissions: CHAT_EVENT_PERMISSIONS,
    description: [
        'Delete a chat event (Modules → Chat Events → Delete Event): removes the channel\'s Twitch EventSub subscription and its saved message and settings. To pause it instead, use update_chat_event with enabled false.',
        'Stream online/offline cannot be deleted. Deleting the outgoing raid event stops outgoing raid tracking (history stays). The user approves first; undo subscribes again with the same settings (needs full access).'
    ].join(' '),
    parameters: { type: 'object', additionalProperties: false, required: ['type'], properties: { type: typeParameter } },
    label: (_input, lang) => tr(lang, 'Preparing to delete the chat event…', 'Preparando la eliminación del evento de chat…'),
    validate: (raw) => typeInput(raw, 'delete'),
    async run(input, ctx) {
        const [event, current] = await Promise.all([catalogEvent(input.type), channelEventsub(ctx.channelId, input.type)]);
        if (!current) throw new ToolInputError(`${eventName(event, input.type)} is not set up on this channel.`);
        if (NON_DISABLEABLE_EVENT_TYPES.has(current.type)) throw new ToolInputError(`${eventName(event, input.type)} cannot be deleted. Clear its message to silence it.`);
        const fields = event ? eventFields(event) : [];
        const keys = ['enabled', ...fields.map((field) => field.key)];
        const before = stored(current, keys);
        const proposal: ChangeProposal = {
            ...proposalBase(ctx, 'delete_chat_event', tr(ctx.lang, `Delete the chat event "${eventName(event, input.type)}"`, `Eliminar el evento de chat "${eventName(event, input.type)}"`), event, input.type, String(current._id)),
            before: display(before, labelsOf(fields), ctx.lang),
            after: null,
            effects: [tr(ctx.lang, `Removes the Twitch EventSub subscription ${input.type}`, `Elimina la suscripción de Twitch EventSub ${input.type}`)],
            warnings: [tr(ctx.lang, 'The bot stops posting this message right away.', 'El bot deja de publicar este mensaje de inmediato.')],
            payload: {
                id: String(current._id), type: input.type, expected: before,
                recreate: { type: input.type, version: current.version || event?.version || '1', condition: current.condition, config: Object.fromEntries(Object.entries(before).filter(([, value]) => value !== null)) }
            }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, type, expected, recreate } = proposal.payload as { id: string; type: string; expected: Record<string, unknown>; recreate: Record<string, unknown> };
        const current = await EventsubSchema.findOne({ _id: id, channelID: ctx.channelId }).lean();
        if (!current) conflict(ctx.lang, 'This chat event was already removed.', 'Este evento de chat ya se eliminó.');
        assertUnchanged(current, expected, ctx.lang, tr(ctx.lang, 'The chat event', 'El evento de chat'));
        const result = await deleteChannelEventsub(ctx.channelId, id);
        if (result.status >= 300) throw new Error(routeMessage(result.body, 'Could not delete the chat event'));
        return {
            result: { deleted: true, type },
            change: { area: 'chat_events', target: proposal.target, before: proposal.before, after: null, undo: { type, recreate }, summary: proposal.title }
        };
    },
    async undo(change, ctx) {
        const data = change.undo as { type: string; recreate: Record<string, unknown> };
        if (await channelEventsub(ctx.channelId, data.type)) conflict(ctx.lang, 'This chat event was set up again already.', 'Este evento de chat ya se volvió a configurar.');
        if (!await hasFullAccess(ctx.channelId)) conflict(ctx.lang, 'Undo needs full access: activate the bot on Twitch first.', 'Deshacer necesita acceso completo: activa el bot en Twitch primero.');
        const result = await createChannelEventsub(ctx.channelId, data.recreate);
        if (result.status >= 300) throw new Error(routeMessage(result.body, 'Could not set the chat event up again'));
    }
};

export const chatEventTools: AgentTool[] = [createChatEvent, updateChatEvent, deleteChatEvent] as unknown as AgentTool[];

/** For get_settings: names of the event's fields in the user's language. */
export function fieldLabels(event: CatalogEvent, lang: Lang): Record<string, string> {
    return Object.fromEntries(eventFields(event).map((field) => [field.key, field.label[lang]]));
}
