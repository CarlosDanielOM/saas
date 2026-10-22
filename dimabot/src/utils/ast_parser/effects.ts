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
}
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
    return mint({ channelId: input.channelId, origin: { ...input.origin }, actor: { ...input.actor }, path: [], next: 0 });
}

/** Config IDs come from stored command/EventSub configuration, never tag arguments. */
export function scopeAstEffectContext(effect: AstEffectContext | undefined, channelId: string, configId: string): AstEffectContext | undefined {
    const state = effect && authorities.get(effect);
    if (!state || state.channelId !== channelId || !configId) return;
    return mint({ ...state, path: [...state.path, configId], next: 0 });
}

/** Reserve a branch while evaluating the reference, before deferred delivery. */
export function forkAstEffectContext(effect: AstEffectContext | undefined): AstEffectContext | undefined {
    const state = effect && authorities.get(effect);
    if (!state || !state.path.length) return;
    return mint({ ...state, path: [...state.path, `reference:${state.next++}`], next: 0 });
}

export function nextPetAction(effect: AstEffectContext | undefined, channelId: string): Pick<AdmitPetActionInput, 'origin' | 'actor' | 'actionKey'> | undefined {
    const state = effect && authorities.get(effect);
    if (!state || state.channelId !== channelId || !state.path.length || !Number.isSafeInteger(state.next)) return;
    const actionKey = `pet:v1:${createHash('sha256').update(JSON.stringify([state.path, state.next++])).digest('hex')}`;
    return { origin: { ...state.origin }, actor: { ...state.actor }, actionKey };
}
