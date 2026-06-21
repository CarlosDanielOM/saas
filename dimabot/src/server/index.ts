import path from 'path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

//? Imports after dotenv config
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { getQdrantConnection } from '../utils/databases/qdrant.database.js';
import { QdrantStartUp } from '../utils/qdrant/start_up.qdrant.js';
import TwitchStreamers from '../classes/twitch_streamers.class.js';
import { pubSubManager } from '../classes/pubsub_manager.class.js';
import { server } from './server.js';
import { websocket } from './websocket.js';
import { clipQueueHandler } from '../handlers/clip_queue.handler.js';
import { ttsQueueHandler } from '../handlers/tts_queue.handler.js';
import { getPolarShClient } from '../utils/polarsh.js';
import { info, error } from '../utils/logger.js';
import { reconcileLiveSessionsOnStartup, startStreamAnalyticsWorker } from '../utils/stream_analytics.js';
import { startSiteAnalytics, refreshSiteAnalyticsSnapshot } from '../utils/siteanalytics.js';
import startSDKLogger from '../utils/opentelemetry_posthog.js';

await getDragonflyClient('Server');
await getMongoDBConnection('Server');
await getQdrantConnection('Server');
await getPolarShClient('Server');
// Initialize PubSub for clip queue
await pubSubManager.init();
startSDKLogger('Server').start();
//! Qdrant Start Up
await QdrantStartUp();

await TwitchStreamers.getTwitchAccountsFromDB();

try {
    await startSiteAnalytics();
} catch (startError) {
    // Site analytics init failed (e.g. persisted snapshot had a stale
    // schema, Helix call timed out, Mongo connection dropped). The
    // route handlers will still serve the empty-cache default (zeros)
    // and the API server continues to boot, but we want this loud so
    // it shows up in the structured log channel alongside every other
    // dimabot error and is alertable.
    await error(
        {
            function: 'server-bootstrap',
            step: 'site-analytics-init',
            impact: 'landing-page-stats-will-show-zeros-until-recovery',
            error: startError instanceof Error ? startError.message : String(startError)
        },
        { destination: 'both' }
    );

    // Best-effort recovery: try to populate at least the Mongo-derived
    // counts (registeredUsers, totalCommands, totalMessages) so the
    // landing page isn't completely zero. Live channels / viewer count
    // are skipped — they will populate on the next periodic refresh
    // tick once the workers are up.
    try {
        await refreshSiteAnalyticsSnapshot();
        await info(
            {
                function: 'server-bootstrap',
                step: 'site-analytics-recovery',
                message: 'Site analytics recovered via inline refresh after init failure'
            },
            { destination: 'both' }
        );
    } catch (recoveryError) {
        await error(
            {
                function: 'server-bootstrap',
                step: 'site-analytics-recovery',
                error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
            },
            { destination: 'both' }
        );
    }
}

// Initialize clip queue handler
await clipQueueHandler.init();
await ttsQueueHandler.init();

if (process.env.STREAM_ANALYTICS_INLINE === 'true') {
    await reconcileLiveSessionsOnStartup();
    startStreamAnalyticsWorker();
}

// Run startup cleanup for clip queue
// TODO: Reactivate startup cleanup when testing is complete
// await clipQueueHandler.startupCleanup();

const app = await server();
const websocketServer = await websocket(app);

if (websocketServer) {
    websocketServer.listen(3000, () => {
        info({ message: 'Server listening on port 3000' }, { destination: 'console' });
    });
} else {
    await error({ message: 'Failed to initialize websocket server' }, { destination: 'both' });
    process.exit(1);
}
