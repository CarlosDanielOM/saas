/**
 * Assistant preferences per person per channel. Today: `persona` = answer in the channel's chat-bot
 * personality (Premium/Pro). Kept without expiry (tiny hash); removed with the account.
 */
import { readChannelPersonality } from '../server/services/ai_personality.service.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { PERSONA_PLANS, SITE_AGENT_KEYS as K } from './config.js';
import type { PlanTier } from './types.js';

export interface AgentPrefs {
    persona: boolean;
}

export interface PersonaView {
    /** The channel's plan allows it. */
    available: boolean;
    /** This person turned it on (only effective when available). */
    on: boolean;
    /** Active profile name, when there is one. */
    name: string | null;
}

export interface Persona {
    name: string;
    personality: string;
}

export const personaAvailable = (plan: PlanTier) => PERSONA_PLANS.includes(plan);

export async function readPrefs(channelId: string, userId: string): Promise<AgentPrefs> {
    const value = await (await getDragonflyClient('site-agent-prefs')).hGet(K.prefs(channelId, userId), 'persona');
    return { persona: value === '1' };
}

export async function writePrefs(channelId: string, userId: string, prefs: Partial<AgentPrefs>): Promise<AgentPrefs> {
    const client = await getDragonflyClient('site-agent-prefs');
    if (typeof prefs.persona === 'boolean') await client.hSet(K.prefs(channelId, userId), 'persona', prefs.persona ? '1' : '0');
    return readPrefs(channelId, userId);
}

/** The channel's active chat-bot personality, or null when there is none worth using. */
export async function loadPersona(channelId: string): Promise<Persona | null> {
    const doc = await readChannelPersonality(channelId).catch(() => null) as
        | { personality?: string; activeProfileId?: string; profiles?: { profileID?: string; name?: string; personality?: string }[] }
        | null;
    if (!doc) return null;
    const active = doc.profiles?.find((profile) => profile.profileID === doc.activeProfileId) ?? doc.profiles?.[0];
    const personality = String(active?.personality ?? doc.personality ?? '').trim();
    if (!personality) return null;
    return { name: String(active?.name ?? 'Default').slice(0, 60), personality: personality.slice(0, 2_000) };
}

export async function personaView(channelId: string, userId: string, plan: PlanTier): Promise<PersonaView> {
    const available = personaAvailable(plan);
    const [prefs, persona] = await Promise.all([
        readPrefs(channelId, userId),
        available ? loadPersona(channelId) : Promise.resolve(null),
    ]);
    return { available, on: available && prefs.persona, name: persona?.name ?? null };
}
