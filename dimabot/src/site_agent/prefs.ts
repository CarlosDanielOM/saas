/**
 * Assistant preferences per person per channel: `persona` = answer in the channel's chat-bot personality
 * (Premium/Pro); `level` = Standard or Expert (Premium/Pro). Kept without expiry (tiny hash); removed with the
 * account.
 */
import { readChannelPersonality } from '../server/services/ai_personality.service.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { AGENT_LEVELS, effectiveLevel, isAgentLevel, PERSONA_PLANS, SITE_AGENT_KEYS as K, SITE_AGENT_PLANS, type AgentLevel } from './config.js';
import type { PlanTier } from './types.js';

export interface AgentPrefs {
    persona: boolean;
    /** What the person picked last; the plan may not allow it (see `effectiveLevel`). */
    level: AgentLevel;
}

export interface LevelView {
    /** The level the next message runs on (Standard when the pick is not on this plan). */
    current: AgentLevel;
    options: { id: AgentLevel; available: boolean; cost: number; contextLimit: number | null }[];
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
    const [persona, level] = await (await getDragonflyClient('site-agent-prefs')).hmGet(K.prefs(channelId, userId), ['persona', 'level']);
    return { persona: persona === '1', level: isAgentLevel(level) ? level : 'standard' };
}

export async function writePrefs(channelId: string, userId: string, prefs: Partial<AgentPrefs>): Promise<AgentPrefs> {
    const client = await getDragonflyClient('site-agent-prefs');
    if (typeof prefs.persona === 'boolean') await client.hSet(K.prefs(channelId, userId), 'persona', prefs.persona ? '1' : '0');
    if (isAgentLevel(prefs.level)) await client.hSet(K.prefs(channelId, userId), 'level', prefs.level);
    return readPrefs(channelId, userId);
}

/** Standard/Expert for the panel: which the next message uses, what each costs, and the plan's options. */
export function levelView(plan: PlanTier, picked: AgentLevel): LevelView {
    const levels = SITE_AGENT_PLANS[plan].levels;
    return {
        current: effectiveLevel(plan, picked),
        options: AGENT_LEVELS.map((id) => {
            const config = levels[id];
            // Locked options still show their cost so the upgrade note can say it; the limit is plan-specific.
            return { id, available: !!config, cost: config?.cost ?? (id === 'expert' ? 2 : 1), contextLimit: config?.contextLimit ?? null };
        }),
    };
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
