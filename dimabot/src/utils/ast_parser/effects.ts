import { createHash } from 'node:crypto';
import type { AdmitPetActionInput } from '../../pets/admission.js';

declare const effectAuthority: unique symbol;
/** Live authority, deliberately opaque and nonserializable. Never put it in eventData/extraContext. */
export interface AstEffectContext { readonly [effectAuthority]: true }
interface EffectState {
    channelId: string;
    origin: AdmitPetActionInput['origin'];
    actor: AdmitPetActionInput['actor'];
    path: string[];
    next: number;
    goalNext: number;
    signalNext: number;
    /** Shared by every scoped/forked copy of one run (references can't reset it). */
    budget: { signals: number };
}
/** Widget signals one command run (with its references) may send. */
export const WIDGET_SIGNALS_PER_RUN = 5;
const authorities = new WeakMap<AstEffectContext, EffectState>();
function mint(state: EffectState): AstEffectContext {
    const authority = Object.freeze(Object.create(null)) as AstEffectContext;
    authorities.set(authority, state);
    return authority;
}

/** Called only by verified Twitch ingress or the gated durable event consumer. No parser infers this. */
export function createTwitchEffectContext(input: Pick<AdmitPetActionInput, 'channelId' | 'origin' | 'actor'>): AstEffectContext | undefined {
    if (typeof input.channelId !== 'string' || !/^\d{1,30}$/.test(input.channelId)
        || typeof input.origin?.id !== 'string' || !input.origin.id.trim() || input.origin.id.length > 200
        || typeof input.origin.occurredAt !== 'string' || !Number.isFinite(Date.parse(input.origin.occurredAt))
        || !['chat-command', 'twitch-event'].includes(input.origin.kind)
        || typeof input.actor?.userId !== 'string' || !input.actor.userId.trim() || input.actor.userId.length > 100
        || typeof input.actor.displayName !== 'string' || input.actor.displayName.length > 100) return;
    const chat = input.origin.kind === 'chat-command' && input.actor.chat;
    const safeChat = chat && /^[a-z0-9_]{1,25}$/i.test(chat.login) && typeof chat.message === 'string' && chat.message.length > 0 && chat.message.length <= 2000 && Array.isArray(chat.badges) && chat.badges.length <= 50
        ? { login: chat.login, message: chat.message, badges: chat.badges.map(b => ({ set_id: String(b.set_id || '').slice(0, 80), id: String(b.id || '').slice(0, 80), info: String(b.info || '').slice(0, 80) })) } : undefined;
    return mint({ channelId: input.channelId, origin: { ...input.origin }, actor: { userId: input.actor.userId, displayName: input.actor.displayName, ...(safeChat ? { chat: safeChat } : {}) }, path: [], next: 0, goalNext: 0, signalNext: 0, budget: { signals: 0 } });
}

/** Config IDs come from stored command/EventSub configuration, never tag arguments. */
export function scopeAstEffectContext(effect: AstEffectContext | undefined, channelId: string, configId: string): AstEffectContext | undefined {
    const state = effect && authorities.get(effect);
    if (!state || state.channelId !== channelId || !configId) return;
    return mint({ ...state, path: [...state.path, configId], next: 0, goalNext: 0, signalNext: 0 });
}

/** Reserve a branch while evaluating the reference, before deferred delivery. */
export function forkAstEffectContext(effect: AstEffectContext | undefined): AstEffectContext | undefined {
    const state = effect && authorities.get(effect);
    if (!state || !state.path.length) return;
    return mint({ ...state, path: [...state.path, `reference:${state.next++}`], next: 0, goalNext: 0, signalNext: 0 });
}

export function nextPetAction(effect: AstEffectContext | undefined, channelId: string): Pick<AdmitPetActionInput, 'origin' | 'actor' | 'actionKey'> | undefined {
    const state = effect && authorities.get(effect);
    if (!state || state.channelId !== channelId || !state.path.length || !Number.isSafeInteger(state.next)) return;
    const actionKey = `pet:v1:${createHash('sha256').update(JSON.stringify([state.path, state.next++])).digest('hex')}`;
    return { origin: { ...state.origin }, actor: { ...state.actor }, actionKey };
}

/** Reserve a goal invocation without altering the existing pet action counter. */
export function nextGoalContribution(effect: AstEffectContext | undefined, channelId: string): {
    origin: EffectState['origin']; actor: EffectState['actor']; actionKey: string; eventsubConfig: boolean;
} | undefined {
    const state = effect && authorities.get(effect);
    if (!state || state.channelId !== channelId || !state.path.length || !Number.isSafeInteger(state.goalNext)) return;
    const actionKey = `goal:v1:${createHash('sha256').update(JSON.stringify([state.path, state.goalNext++])).digest('hex')}`;
    return { origin: { ...state.origin }, actor: { ...state.actor }, actionKey, eventsubConfig: state.path[0].startsWith('eventsub:') };
}

/**
 * A widget signal from verified Twitch provenance: who sent it (from signed ingress, never the authored body's elevated
 * identity), a stable key for de-duplication, or `limit` once this run (references included) used its budget.
 */
export function nextWidgetSignal(effect: AstEffectContext | undefined, channelId: string): {
    origin: EffectState['origin']; actor: EffectState['actor']; actionKey: string;
} | 'limit' | undefined {
    const state = effect && authorities.get(effect);
    if (!state || state.channelId !== channelId || !state.path.length || !Number.isSafeInteger(state.signalNext)) return;
    if (state.budget.signals >= WIDGET_SIGNALS_PER_RUN) return 'limit';
    state.budget.signals++;
    const actionKey = `signal:v1:${createHash('sha256').update(JSON.stringify([state.origin.id, state.path, state.signalNext++])).digest('hex')}`;
    return { origin: { ...state.origin }, actor: { ...state.actor, ...(state.actor.chat ? { chat: { ...state.actor.chat, badges: [...state.actor.chat.badges] } } : {}) }, actionKey };
}
