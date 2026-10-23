/** Seed only disposable startup state BEFORE the API imports its runtime. */
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
if (process.env.DIMA032_SEED_STARTUP === 'true' && (process.argv[1] || '').endsWith('/dist/server/index.js')) {
    if (!/^mongodb:\/\/mongo:27017\/saas_ops_[a-z_]+_test$/.test(process.env.MONGO_URI || '')) throw new Error('Disposable startup URI required');
    const { MongoClient, ObjectId } = require('mongodb'), { createClient } = require('redis');
    const client = new MongoClient(process.env.MONGO_URI); await client.connect(); const db = client.db();
    const redis = createClient({ url: 'redis://redis:6379' }); await redis.connect();
    const channel = '99003212', owner = new ObjectId(), image = new ObjectId().toHexString(), barrier = new Date(Date.now() + 45000);
    await db.collection('users').insertOne({ _id: owner, name: 'DIMA032 startup', plan_tier: 'premium', accounts: [{ type: 'twitch', id: channel, name: 'startup_fixture' }] });
    await db.collection('asset_libraries').insertOne({ _id: channel, usedBytes: 1, assets: [{ id: image, state: 'ready', kind: 'image', mime: 'image/gif', bytes: 1 }] });
    await db.collection('pet_settings').insertOne({ userId: owner, revision: 1, updatedAt: new Date(), settings: {
        enabled: true, name: 'Dima', sources: { independent: false, readTts: true }, ttsAudio: 'pet', appearance: { kind: 'png', idleAssetId: image, talkingAssetId: image },
        playback: { target: 'browser', desktopSessionId: null, vtsSessionId: null }, tts: { enabled: false, provider: 'piper', language: 'en', voice: 'en_US-ryan-medium' },
        personality: { source: 'custom', profileId: '', prompt: 'Fixture' }, rules: [], behavior: { respondToChat: true, respondToEvents: true, cooldownSeconds: 0, maxReplyLength: 280 }
    } });
    await db.collection('pet_runtimes').insertOne({ _id: String(owner), channelId: channel, generation: 7, activeRequestId: 'restart-possibly-heard',
        lease: { leaseId: 'old-process-lease', holderPeerId: 'gone-process', expiresAt: barrier }, notBefore: new Date(0), lastAcceptedAt: null,
        ttsReservation: { speechId: 'old-process-speech', token: 'old-process-token', expiresAt: new Date(Date.now() + 240000) }, tokenHash: null, overlayToken: null });
    await db.collection('pet_requests').insertOne({ _id: 'restart-possibly-heard', ownerId: String(owner), channelId: channel, operation: 'tts', generation: 7,
        settingsRevision: 1, status: 'ready', version: 1, deliveryAttempted: true, admitted: true,
        origin: { kind: 'tts-queue', id: 'old-process-speech', occurredAt: new Date().toISOString() }, actionKey: 'tts', phaseDeadline: barrier, expiresAt: new Date(Date.now() + 86400000) });
    await redis.set(`twitch:${channel}:tts:queue:data:restart-backlog`, JSON.stringify({ channelID: channel, speechID: 'restart-backlog', timestamp: Date.now(), source: 'chat-command', mode: 'speak', provider: 'piper', text: 'Unheard durable backlog after restart', language: 'en', voice: 'en_US-ryan-medium' }));
    await redis.zAdd(`twitch:${channel}:tts:queue`, { score: Date.now(), value: 'restart-backlog' });
    await redis.set('dima032:test:startup', JSON.stringify({ channel, ownerId: String(owner), notBefore: barrier.getTime() }));
    await redis.quit(); await client.close();
}
