import { getDragonflyClient } from './databases/dragonfly.database.js';
import { error } from './logger.js';
import fs from 'fs/promises';
import path from 'path';
import { getDirname } from './pollyfills.js';
import { randomUUID } from 'node:crypto';
import { pubSubManager } from '../classes/pubsub_manager.class.js';
import { resetTtsSession } from './tts/tts_session.util.js';

export const TTS_SESSION_ENDED = 'tts:session-ended:v1';

const __dirname = getDirname(import.meta.url);
const speechPublicDir = path.resolve(__dirname, '../server/routes/public/speech');

export async function clearSpeechFiles(channelID: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('clearSpeechFiles');
        const session = randomUUID();
        const channelDir = path.join(speechPublicDir, channelID);
        const oldFiles = await fs.readdir(channelDir, { withFileTypes: true }).catch(() => []);
        const queueKeys = await cache.keys(`twitch:${channelID}:tts:queue:data:*`);
        await resetTtsSession(cache, channelID, session, queueKeys);
        // Remove only files observed before the boundary. A new-session enqueue
        // must survive even if this filesystem cleanup finishes later.
        for (const file of oldFiles) if (file.isFile()) await fs.rm(path.join(channelDir, file.name), { force: true });
        await fs.rmdir(channelDir).catch(() => {}); // Keep a directory containing new files.
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
