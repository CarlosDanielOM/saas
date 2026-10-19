import TwitchStreamers from '../../classes/twitch_streamers.class.js';
import { getUrl } from '../../utils/dev.js';

export type TtsControlAction = 'skip' | 'clear' | 'refresh';

/** Use the existing owner-token API boundary; chatter levels never authorize HTTP requests. */
export async function controlTts(channelID: string, action: TtsControlAction): Promise<{ error: boolean; message: string }> {
    try {
        const token = await TwitchStreamers.getAccountTokenById(channelID, 'twitch');
        if (!token) return { error: true, message: 'Reconnect the channel owner’s account in the dashboard' };
        const base = process.env.INTERNAL_API_URL || (process.env.NODE_ENV === 'production' ? 'http://dima-server:3000' : getUrl());
        const response = await fetch(`${base}/speech/${encodeURIComponent(channelID)}/control`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action }), signal: AbortSignal.timeout(10000)
        });
        const result = await response.json() as { error?: boolean; message?: string };
        return { error: !response.ok || !!result.error, message: result.message || 'TTS control failed' };
    } catch {
        return { error: true, message: 'TTS controls are temporarily unavailable' };
    }
}
