import { RandomUserSettingsSchema } from '../../schemas/randomuser_settings.schema.js';

export const MAX_RANDOMUSER_BLACKLIST = 200;

export function normalizeRandomUserBlacklist(input: unknown): string[] | null {
    if (!Array.isArray(input) || input.length > MAX_RANDOMUSER_BLACKLIST) return null;
    const names = new Set<string>();
    for (const item of input) {
        if (typeof item !== 'string') return null;
        const name = item.trim().replace(/^@/, '').toLowerCase();
        if (!/^[a-z0-9_]{1,25}$/.test(name)) return null;
        names.add(name);
    }
    return [...names];
}

export async function getRandomUserBlacklist(channelID: string): Promise<string[]> {
    const settings = await RandomUserSettingsSchema.findOne({ channelID }).select('blacklist').lean();
    return settings?.blacklist ?? [];
}
