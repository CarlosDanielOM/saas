import { getDragonflyClient } from './databases/dragonfly.database.js';
import { error } from './logger.js';
import fs from 'fs/promises';
import path from 'path';
import { getDirname } from './pollyfills.js';
import { randomUUID } from 'node:crypto';
import { pubSubManager } from '../classes/pubsub_manager.class.js';

export const TTS_SESSION_ENDED = 'tts:session-ended:v1';

const __dirname = getDirname(import.meta.url);
const speechPublicDir = path.resolve(__dirname, '../server/routes/public/speech');

export async function clearSpeechFiles(channelID: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('clearSpeechFiles');
        const session = randomUUID();
        // Durable boundary marker; the API also reconciles it if this hint is lost.
        await cache.set(`twitch:${channelID}:tts:session`, session);

        const queueKeys = await cache.keys(`twitch:${channelID}:tts:queue:data:*`);
        for (const key of queueKeys) {
            await cache.del(key);
        }

        await cache.del(`twitch:${channelID}:tts:queue`);
        await cache.del(`twitch:${channelID}:tts:processing`);
        await cache.del(`twitch:${channelID}:tts:connected`);
        await cache.del(`twitch:${channelID}:tts:last_cleanup`);

        const channelDir = path.join(speechPublicDir, channelID);
        if (await fileExists(channelDir)) {
            await fs.rm(channelDir, { recursive: true, force: true });
        }
        // Publish after removal so the API cannot advance an old queued item
        // while this consumer is still clearing the stream's backlog.
        await pubSubManager.publish(TTS_SESSION_ENDED, { channelID, session });
    } catch (err) {
        await error({ 
            function: 'clearSpeechFiles', 
            channelID, 
            error: err instanceof Error ? err.message : String(err) 
        });
        throw err;
    }
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}
