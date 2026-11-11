import {
    ChannelTtsSettingsSchema,
    getChannelTtsSettings,
    normalizeChannelTtsSettings,
    upsertChannelTtsSettings,
    type ChannelTtsSettingsData
} from '../../schemas/channel_tts_settings.schema.js';
import { resolveKokoroVoice } from '../../utils/tts/kokoro_voices.util.js';
import { FISH_VOICES } from './tts/fish_tts.service.js';
import { resolveFishVoice, getFishVoice } from './tts/fish_voice_catalog.service.js';

/**
 * Channel TTS settings save shared by `PUT /speech/settings/:channelID` and the site assistant
 * (`site_agent/tools/write/settings/tts.ts`). Callers check `tts:manage` first.
 */

export type TtsSettingsSaveResult =
    | { ok: true; settings: ChannelTtsSettingsData }
    | { ok: false; status: number; body: Record<string, unknown> };

/** Checks a new Fish voice like the full save: it must resolve and, unless built in, exist in the catalog. */
async function checkFishVoice(selected: string, previous: string | undefined): Promise<TtsSettingsSaveResult | null> {
    if (selected === previous) return null;
    const voiceId = resolveFishVoice(selected);
    if (!voiceId) return { ok: false, status: 400, body: { error: true, status: 400, code: 'invalid_voice', message: 'Invalid Fish voice' } };
    if (!Object.hasOwn(FISH_VOICES, selected)) await getFishVoice(voiceId);
    return null;
}

/**
 * Saves a full settings body (normalized like the page sends it). A new Fish voice must resolve and,
 * unless it is a built-in voice, exist in the Fish catalog (`getFishVoice` throws VoiceRequestError).
 */
export async function saveChannelTtsSettings(channelID: string, channelName: string, body: Partial<ChannelTtsSettingsData> | null | undefined): Promise<TtsSettingsSaveResult> {
    if (body?.voices?.kokoroDefault !== undefined && !resolveKokoroVoice(body.voices.kokoroDefault)) {
        return { ok: false, status: 400, body: { error: true, message: 'Invalid Kokoro voice', status: 400 } };
    }
    const nextSettings = normalizeChannelTtsSettings(body, channelID, channelName);
    const previous = await getChannelTtsSettings(channelID, channelName);
    const voiceProblem = await checkFishVoice(nextSettings.voices.cloneDefault!, previous.voices.cloneDefault);
    if (voiceProblem) return voiceProblem;
    return { ok: true, settings: await upsertChannelTtsSettings(channelID, nextSettings, channelName) };
}

type Values = Record<string, unknown>;

function readPath(source: unknown, path: string): unknown {
    let value: unknown = source;
    for (const key of path.split('.')) {
        if (!value || typeof value !== 'object') return undefined;
        value = (value as Values)[key];
    }
    return value;
}

function writePath(target: Values, path: string, value: unknown): void {
    const keys = path.split('.');
    let node = target;
    for (const key of keys.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== 'object') node[key] = {};
        node = node[key] as Values;
    }
    node[keys[keys.length - 1]] = value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export type TtsSettingsConditionalResult =
    | TtsSettingsSaveResult
    /** A path in `expected` reads differently now (`current` = the settings as they are). Nothing was written. */
    | { ok: false; conflict: true; current: ChannelTtsSettingsData };

/**
 * Compare-and-set save for the site assistant: writes only `values` (dotted path → value, e.g.
 * `filters.maxLength`) and only while every `expected` path still reads the same as the page shows it.
 * The check is part of the write filter (the stored values of the expected paths), so an edit that
 * lands in between makes it write nothing; other settings are never rewritten. Values go through the
 * same normalization and voice checks as the full save. A channel without a settings document gets
 * one only if it still has none.
 */
export async function updateChannelTtsSettingsIfUnchanged(channelID: string, channelName: string, expected: Values, values: Values): Promise<TtsSettingsConditionalResult> {
    const kokoro = values['voices.kokoroDefault'];
    if (kokoro !== undefined && !resolveKokoroVoice(kokoro as string)) {
        return { ok: false, status: 400, body: { error: true, message: 'Invalid Kokoro voice', status: 400 } };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        const stored = await ChannelTtsSettingsSchema.findOne({ channelID }).lean<Values | null>();
        const current = stored
            ? normalizeChannelTtsSettings(stored as Partial<ChannelTtsSettingsData>, channelID, channelName)
            : await getChannelTtsSettings(channelID, channelName);
        if (Object.keys(expected).some((path) => !same(readPath(current, path), expected[path]))) return { ok: false, conflict: true, current };

        const merged = structuredClone(current) as unknown as Values;
        for (const [path, value] of Object.entries(values)) writePath(merged, path, value);
        const next = normalizeChannelTtsSettings(merged as Partial<ChannelTtsSettingsData>, channelID, channelName);
        const voiceProblem = await checkFishVoice(next.voices.cloneDefault!, current.voices.cloneDefault);
        if (voiceProblem) return voiceProblem;

        if (!stored) {
            try {
                await ChannelTtsSettingsSchema.create(next);
            } catch (error) {
                if ((error as { code?: number }).code === 11000) continue; // created meanwhile: check it again
                throw error;
            }
        } else {
            const guard = Object.fromEntries(Object.keys(expected).map((path) => [path, readPath(stored, path) ?? null]));
            const $set = Object.fromEntries(Object.keys(values).map((path) => [path, readPath(next, path)]));
            const result = await ChannelTtsSettingsSchema.updateOne({ channelID, ...guard }, { $set });
            if (!result.matchedCount) continue; // changed between the read and the write: check it again
        }
        return { ok: true, settings: await getChannelTtsSettings(channelID, channelName) };
    }
    return { ok: false, conflict: true, current: await getChannelTtsSettings(channelID, channelName) };
}
