/**
 * E2E smoke test: generate an embedding via the LFM2 service through
 * the real dimabot code path, then verify the resulting vector is
 * stored in Qdrant with the right dimension and L2 norm.
 *
 * Run from the dimabot/ directory:
 *   npx tsx src/scripts/smoke_test_lfm2_embeddings.script.ts
 */
import { createHash } from 'crypto';
import { storeChatMessageEmbedding } from '../utils/qdrant/functions/chat_logs/store_chat_log.qdrant.js';
import { generateEmbedding } from '../utils/ai/lfm2_embeddings/index.js';
import { getQdrantConnection } from '../utils/databases/qdrant.database.js';

async function main() {
    const testMessage = `LFM2.5 embeddings smoke test ${Date.now()}`;
    const channelId = 'smoke-test-channel';
    const userId = 'smoke-test-user';
    const timestamp = Date.now();

    console.log('Step 1: Direct embedding generation (no DB) ...');
    const direct = await generateEmbedding(testMessage, 'lfm2.5-embedding-350m', 'document');
    if (direct.error || !direct.embedding) {
        console.error('FAIL: direct embedding failed:', direct.message);
        process.exit(1);
    }
    const norm = Math.sqrt(direct.embedding.reduce((s, x) => s + x * x, 0));
    console.log(`  model:   ${direct.model}`);
    console.log(`  dim:     ${direct.embedding.length}`);
    console.log(`  L2 norm: ${norm.toFixed(4)}`);
    if (direct.embedding.length !== 1024) {
        console.error(`FAIL: expected 1024-dim, got ${direct.embedding.length}`);
        process.exit(1);
    }
    if (Math.abs(norm - 1.0) > 0.01) {
        console.error(`FAIL: L2 norm is ${norm}, expected ~1.0`);
        process.exit(1);
    }

    console.log('Step 2: Real code path (storeChatMessageEmbedding) -> Qdrant ...');
    const storeResult = await storeChatMessageEmbedding({
        channel_id: channelId,
        channel_name: 'smoke-test',
        message: testMessage,
        username: 'smoke',
        user_id: userId,
        timestamp,
    });
    if (storeResult.error) {
        console.error('FAIL: store failed:', storeResult.message);
        process.exit(1);
    }
    console.log(`  embedding time: ${storeResult.embeddingTime}ms`);
    console.log(`  qdrant time:    ${storeResult.qdrantTime}ms`);
    console.log(`  total time:     ${storeResult.totalTime}ms`);

    console.log('Step 3: Verify vector exists in Qdrant ...');
    const qc = await getQdrantConnection('smoke-test');
    const hash = createHash('md5')
        .update(`${channelId}:${userId}:${timestamp}`)
        .digest('hex');
    const pointId = parseInt(hash.substring(0, 8), 16);
    const pts = await qc.retrieve('twitch_chat_logs', { ids: [pointId], with_vector: true, with_payload: true });
    if (!pts || pts.length === 0) {
        console.error(`FAIL: point ${pointId} not found in Qdrant`);
        process.exit(1);
    }
    const stored = pts[0];
    const storedVec = stored.vector as number[];
    const storedNorm = Math.sqrt(storedVec.reduce((s, x) => s + x * x, 0));
    console.log(`  point id:     ${pointId}`);
    console.log(`  vector dim:   ${storedVec.length}`);
    console.log(`  L2 norm:      ${storedNorm.toFixed(4)}`);
    console.log(`  payload msg:  ${(stored.payload as any)?.message}`);
    if (storedVec.length !== 1024) {
        console.error(`FAIL: Qdrant vector is ${storedVec.length}-dim, expected 1024`);
        process.exit(1);
    }
    if (Math.abs(storedNorm - 1.0) > 0.01) {
        console.error(`FAIL: stored L2 norm is ${storedNorm}, expected ~1.0`);
        process.exit(1);
    }

    console.log('\nOK: end-to-end LFM2.5 embeddings -> Qdrant verified.');
    process.exit(0);
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
