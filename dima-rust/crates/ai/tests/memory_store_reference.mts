// Records `memory.service.ts` (and the Qdrant memory functions it calls) against scratch stores.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//       "$REPO/dima-rust/crates/ai/tests/memory_store_reference.mts" \
//       "$REPO/dima-rust/crates/ai/tests/memory_store_reference.json"
//
// Stores: a MongoDB database and a Qdrant collection named `dima_test_ai_<random>`, both dropped
// at the end (also on failure). The service's hard-coded collection `twitch_channel_memories` is
// reached through a loopback proxy that renames it to the scratch collection. The LFM2 embedding
// service is a loopback mock returning fixed 4-dimensional vectors (`vectorFor`, mirrored by the
// Rust test). `Date` is frozen per step (node:test MockTimers) and new ObjectIds are
// `<seconds><counter>`, so the Rust run can reproduce every id, time and Qdrant point id.
//
// Evaluated reference files (transpiled; their imports mapped): memory.service.ts,
// sync_memory.qdrant.ts, retrieve_memory_context.qdrant.ts, lfm2_embeddings.client.ts,
// fetch.utils.ts. Real modules: the two schemas, qdrant.database.ts, qdrant_point_id.ts,
// memory_policy.ts, memory_time.ts, memory_relevance.ts. Stubs: the logger (silent), the
// streamer lookup (`NAMES`). All text is synthetic.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { mock } from 'node:test';
import { createRequire } from 'node:module';

const root = process.env.DIMABOT_DIR!;
const out = process.argv[2];
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const mongoose = require('mongoose');
const { EJSON } = mongoose.mongo.BSON;

const SOURCES = [
    'src/utils/ai/memory/memory.service.ts',
    'src/utils/qdrant/functions/memory/sync_memory.qdrant.ts',
    'src/utils/qdrant/functions/memory/retrieve_memory_context.qdrant.ts',
    'src/utils/ai/lfm2_embeddings/lfm2_embeddings.client.ts',
    'src/utils/ai/fetch.utils.ts',
    'src/schemas/channel_ai_memory.schema.ts',
    'src/schemas/channel_ai_personality.schema.ts',
    'src/utils/databases/qdrant.database.ts',
    'src/utils/qdrant/qdrant_point_id.ts',
    'src/utils/ai/memory/memory_policy.ts',
    'src/utils/ai/memory/memory_time.ts',
    'src/utils/ai/memory/memory_relevance.ts',
    'src/utils/account_deletion.ts',
];
const sha = (rel: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');

const run = crypto.randomBytes(6).toString('hex');
const SCRATCH = `dima_test_ai_${run}`;
const QDRANT = process.env.DIMA_TEST_QDRANT_URL!;
const QKEY = process.env.DIMA_TEST_QDRANT_API_KEY || '';
const T0 = 1_763_000_000_000;
const NAMES: Record<string, string> = { '1001': 'alpha_channel', '2002': 'beta_channel' };

// ---- Shared with the Rust test: the mock embedding vector of a text. -------------------------
export function vectorFor(text: string): number[] {
    if (text.includes('EMPTYVEC')) return [];
    const t = text.toLowerCase();
    const has = (w: string) => (t.includes(w) ? 1 : 0);
    const v = [has('tea'), has('game'), has('music'), 0];
    if (v[0] + v[1] + v[2] === 0) v[3] = 1;
    return v;
}

// ---- Event log: Mongo writes, Qdrant requests and embeddings, in order. ----------------------
let events: any[] = [];
let embeddings: any[] = [];

const embedServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    embeddings.push(body);
    events.push({ embed: body.kind });
    const embedding = vectorFor(String(body.input));
    res.setHeader('content-type', 'application/json');
    res.setHeader('connection', 'close');
    res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding }], model: body.model, usage: { prompt_tokens: 1, total_tokens: 1 } }));
});

const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    const target = String(req.url).replace('/collections/twitch_channel_memories', `/collections/${SCRATCH}`);
    const route = String(req.url).split('?')[0];
    if (route !== '/collections') events.push({ qdrant: `${req.method} ${route.replace('/collections/twitch_channel_memories', '')}` });
    const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
    if (QKEY) headers['api-key'] = QKEY;
    // node:http, no keep-alive: undici's connection timers read the frozen `Date`.
    const upstream = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const r = http.request(QDRANT + target, { method: req.method, headers, agent: false }, async (resp) => {
            const parts: Buffer[] = [];
            for await (const c of resp) parts.push(c as Buffer);
            resolve({ status: resp.statusCode ?? 500, body: Buffer.concat(parts) });
        });
        r.on('error', reject);
        r.end(text || undefined);
    });
    res.statusCode = upstream.status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('connection', 'close');
    res.end(upstream.body);
});

const listen = (s: http.Server) => new Promise<number>(r => s.listen(0, '127.0.0.1', () => r((s.address() as any).port)));
const embedPort = await listen(embedServer);
const proxyPort = await listen(proxy);
process.env.LFM2_EMBEDDINGS_URL = `http://127.0.0.1:${embedPort}/v1/embeddings`;
process.env.LFM2_EMBEDDINGS_RETRIES = '0';
process.env.QDRANT_HOST = '127.0.0.1';
process.env.QDRANT_PORT = String(proxyPort);
process.env.QDRANT_API_KEY = 'proxy';

const qdrant = async (method: string, p: string, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (QKEY) headers['api-key'] = QKEY;
    const r = await fetch(`${QDRANT}/collections/${SCRATCH}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`qdrant ${method} ${p}: ${r.status}`);
    return (await r.json()).result;
};
const PAYLOAD_INDEXES = [['memory_id', 'keyword'], ['channel_id', 'keyword'], ['memory_type', 'keyword'], ['status', 'keyword'],
    ['risk', 'keyword'], ['confidence', 'float'], ['subject_scope', 'keyword'], ['subject_username', 'keyword'],
    ['subject_user_id', 'keyword'], ['updated_at', 'integer']];
const resetQdrant = async () => {
    const headers: Record<string, string> = {};
    if (QKEY) headers['api-key'] = QKEY;
    await fetch(`${QDRANT}/collections/${SCRATCH}`, { method: 'DELETE', headers });
    await qdrant('PUT', '', { vectors: { size: 4, distance: 'Cosine' } });
    for (const [field_name, field_schema] of PAYLOAD_INDEXES) await qdrant('PUT', '/index?wait=true', { field_name, field_schema });
};

// ---- Load the reference. ---------------------------------------------------------------------
function load(rel: string, mapping: Record<string, unknown>) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} as Record<string, any> };
    const req = (spec: string) => {
        if (spec in mapping) return mapping[spec];
        throw new Error(`unexpected import ${spec} in ${rel}`);
    };
    vm.compileFunction(js, ['exports', 'require', 'module'])(module.exports, req, module);
    return module.exports;
}
const real = (rel: string) => import(path.join(root, rel));
const logger = { error: async () => {}, warn: async () => {}, debug: async () => {}, info: async () => {} };

let counter = 0;
class DetObjectId extends mongoose.Types.ObjectId {
    constructor(value?: unknown) {
        if (value === undefined) {
            counter += 1;
            const secs = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
            super(secs + counter.toString(16).padStart(16, '0'));
        } else super(value);
    }
}

await mongoose.connect(process.env.DIMA_TEST_MONGO_URI!, { dbName: SCRATCH, monitorCommands: true });
mongoose.connection.getClient().on('commandStarted', (e: any) => {
    if (['insert', 'update', 'delete', 'findAndModify'].includes(e.commandName) && e.command[e.commandName] === 'channelaimemories') {
        events.push({ mongo: e.commandName });
    }
});
const { ChannelAIMemorySchema } = await real('src/schemas/channel_ai_memory.schema.ts');
const { ChannelAIPersonalitySchema } = await real('src/schemas/channel_ai_personality.schema.ts');
const qdrantDb = await real('src/utils/databases/qdrant.database.ts');
const pointId = await real('src/utils/qdrant/qdrant_point_id.ts');
const policy = await real('src/utils/ai/memory/memory_policy.ts');
const time = await real('src/utils/ai/memory/memory_time.ts');
const relevance = await real('src/utils/ai/memory/memory_relevance.ts');
const fetchUtils = load('src/utils/ai/fetch.utils.ts', {});
const lfm2 = load('src/utils/ai/lfm2_embeddings/lfm2_embeddings.client.ts', { '../../logger.js': logger, '../fetch.utils.js': fetchUtils });
const embeddingsIndex = { generateEmbedding: lfm2.generateEmbedding };
const sync = load('src/utils/qdrant/functions/memory/sync_memory.qdrant.ts', {
    '../../../ai/lfm2_embeddings/index.js': embeddingsIndex, '../../../databases/qdrant.database.js': qdrantDb,
    '../../../logger.js': logger, '../../qdrant_point_id.js': pointId,
});
const retrieve = load('src/utils/qdrant/functions/memory/retrieve_memory_context.qdrant.ts', {
    '../../../ai/lfm2_embeddings/index.js': embeddingsIndex, '../../../databases/qdrant.database.js': qdrantDb,
    '../../../logger.js': logger, '../../../ai/memory/memory_relevance.js': relevance,
});
const service = load('src/utils/ai/memory/memory.service.ts', {
    'node:crypto': crypto,
    mongoose: { Types: { ObjectId: DetObjectId } },
    '../../../classes/twitch_streamers.class.js': { __esModule: true, default: { getTwitchAccountById: async (id: string) => (NAMES[id] ? { name: NAMES[id] } : null) } },
    '../../../schemas/channel_ai_memory.schema.js': { ChannelAIMemorySchema },
    '../../../schemas/channel_ai_personality.schema.js': { ChannelAIPersonalitySchema },
    '../../qdrant/functions/memory/sync_memory.qdrant.js': sync,
    '../../qdrant/qdrant_point_id.js': pointId,
    '../../logger.js': logger,
    './memory_policy.js': policy,
    './memory_time.js': time,
});
await ChannelAIMemorySchema.init();

// ---- Scenarios. ------------------------------------------------------------------------------
const A = '1001', B = '2002';
const oid = (n: number) => (Math.floor(T0 / 1000) - 86400).toString(16).padStart(8, '0') + n.toString(16).padStart(16, '0');
const fp = (channel: string, type: string, scope: string, username: string, summary: string) =>
    crypto.createHash('sha256').update([channel, type, scope, username.toLowerCase(), summary.toLowerCase()].join('|')).digest('hex');
const stored = (n: number, channel: string, extra: Record<string, unknown> = {}) => {
    const summary = String(extra.summary ?? `seeded memory ${n}`);
    const type = String(extra.type ?? 'channel_lore');
    const subject = (extra.subject as any) ?? { scope: 'channel', username: '', userID: '' };
    const doc: Record<string, unknown> = {
        _id: { $oid: oid(n) }, qdrantPointID: 1000 + n, channelID: channel, channel: NAMES[channel], type,
        status: 'confirmed', risk: 'low', confidence: { $numberDouble: '0.9' }, subject,
        content: `seeded content ${n}`, summary, fingerprint: fp(channel, type, subject.scope, subject.username, summary),
        sourceEvidence: [], createdBy: { source: 'system', username: '', userID: '' }, reviewReason: '', useCount: 0,
        createdAt: { $date: { $numberLong: String(T0 - 86_400_000 + n * 1000) } },
        updatedAt: { $date: { $numberLong: String(T0 - 86_400_000 + n * 1000) } }, __v: 0,
    };
    for (const [k, v] of Object.entries(extra)) if (v === '$unset') delete doc[k]; else doc[k] = v;
    return doc;
};
const personality = (channel: string, learningConfig: Record<string, unknown> = {}, memoryPolicy: Record<string, unknown> = {}) =>
    ({ _id: { $oid: oid(900 + Number(channel.slice(-1))) }, channelID: channel, channel: NAMES[channel], learningConfig, memoryPolicy });
const create = (input: Record<string, unknown>) => ({ op: 'create', input: { channelID: A, type: 'channel_lore', confidence: 0.9, ...input } });
const T = (n: number) => 'x'.repeat(n);

const scenarios: any[] = [
    { name: 'create_confirmed_then_list', steps: [
        create({ content: 'The channel drinks tea every stream', summary: 'Channel tea ritual', evidence: [{ username: 'viewer_a', userID: '77', message: 'tea time', messageId: 'm1', timestamp: 1700000000 }], createdBy: { source: 'streamer', username: 'alpha', userID: A } }),
        { op: 'list', input: { channelID: A } }] },
    { name: 'create_pending_low_confidence', steps: [create({ content: 'Maybe the channel likes games', confidence: 0.5 }), { op: 'pending', input: { channelID: A } }] },
    { name: 'create_duplicate_and_near_duplicate', steps: [
        create({ content: 'First wording about tea', summary: 'Likes Tea', confidence: 0.6, evidence: [{ message: 'one' }] }),
        create({ content: 'Second wording about tea', summary: '  likes tea ', confidence: 0.9, evidence: [{ message: 'two', source: 'mod' }] }),
        create({ content: 'Third wording', summary: 'LIKES TEA', preserveConfirmed: true }),
        create({ content: 'A different memory', summary: 'Likes green tea' })] },
    { name: 'create_duplicate_forced_pending', steps: [
        create({ content: 'tea first', summary: 'tea s' }),
        create({ content: 'tea second', summary: 'tea s', forceStatus: 'pending_review', risk: 'low' })] },
    { name: 'create_limits', seed: { personalities: [personality(A, { maxPendingMemories: 2, maxConfirmedMemories: 1 })] }, steps: [
        create({ content: 'p1', confidence: 0.1 }), create({ content: 'p2', confidence: 0.1 }), create({ content: 'p3', confidence: 0.1 }),
        create({ content: 'c1 tea' }), create({ content: 'c2 tea' }), { op: 'pending', input: { channelID: A } }] },
    { name: 'create_rules', seed: { personalities: [personality(B, { enabled: false }, { allowRunningJokes: false })] }, steps: [
        create({ content: '   ' }),
        create({ content: 'user scoped', subject: { scope: 'user', username: 'v' } }),
        create({ content: 'fact', type: 'known_user_fact', subject: { scope: 'channel', userID: '5' } }),
        create({ content: 'sensitive', risk: 'medium' }),
        create({ channelID: B, content: 'learning off' }),
        create({ channelID: B, content: 'learning off bypassed joke', type: 'running_joke', bypassLearningConfig: true }),
        create({ channelID: B, content: 'joke bypassed music', type: 'running_joke', bypassLearningConfig: true, bypassMemoryPolicy: true, forceStatus: 'rejected' })] },
    { name: 'create_user_fact_with_evidence', steps: [
        create({ type: 'known_user_fact', risk: 'low', channelName: '  given_name  ', subject: { scope: 'user', username: ' Viewer_X ', userID: ' 42 ' },
            content: 'Viewer X plays music', summary: 'Viewer X: music', forceStatus: 'pending_review',
            evidence: Array.from({ length: 30 }, (_, i) => ({ username: `u${i}`, userID: String(i), message: ` msg ${i} `, timestamp: i % 3 === 0 ? 0 : 1700000000 + i })),
            createdBy: { source: 'chat', username: 'viewer_x', userID: '42' } }),
        { op: 'status', input: { channelID: A, memoryID: 'last', status: 'confirmed', reviewReason: ' ok ', reviewer: { source: 'streamer', username: 'alpha', userID: A } } }] },
    { name: 'create_long_summary', steps: [create({ content: T(300) + ' tea', summary: 'é'.repeat(100) + '😀'.repeat(50) })] },
    { name: 'status_changes', seed: { memories: [stored(1, B), stored(2, A, { type: 'known_user_fact', status: 'pending_review', subject: { scope: 'user', username: 'v', userID: '' } })] }, steps: [
        create({ content: 'tea status', confidence: 0.5 }),
        { op: 'status', input: { channelID: A, memoryID: 'last', status: 'confirmed', reviewReason: 'looks right', reviewer: { source: 'streamer', username: 'alpha', userID: A } } },
        { op: 'status', input: { channelID: A, memoryID: 'last', status: 'archived', reviewReason: 'auto_archive_weekly', reviewer: { source: 'system', username: 'stream_memory_worker' } } },
        { op: 'status', input: { channelID: A, memoryID: 'last', status: 'confirmed' } },
        { op: 'status', input: { channelID: A, memoryID: oid(1), status: 'archived' } },
        { op: 'status', input: { channelID: A, memoryID: 'not-an-id', status: 'archived' } },
        { op: 'status', input: { channelID: A, memoryID: oid(2), status: 'confirmed' } }] },
    { name: 'update_fields', seed: { memories: [stored(1, B)] }, steps: [
        create({ content: 'Original about tea', summary: 'orig tea' }),
        { op: 'update', input: { channelID: A, memoryID: 'last', content: '  Edited about music  ', summary: '', type: 'preference', risk: 'low', confidence: 2 } },
        { op: 'update', input: { channelID: A, memoryID: 'last', subject: { scope: 'user', username: 'Fan', userID: '9' } } },
        { op: 'update', input: { channelID: A, memoryID: 'last', type: 'known_user_fact', subject: { scope: 'channel', userID: '9' } } },
        { op: 'update', input: { channelID: A, memoryID: oid(1), content: 'cross channel' } },
        { op: 'update', input: { channelID: A, memoryID: 'last', risk: 'high' } }] },
    { name: 'update_pending_memory', steps: [
        create({ content: 'pending game', confidence: 0.2 }),
        { op: 'update', input: { channelID: A, memoryID: 'last', content: 'pending game edited', summary: 'edited' } }] },
    { name: 'update_empty_content_leaves_point_rewritten', steps: [
        create({ content: 'tea body', summary: 'tea sum' }),
        { op: 'update', input: { channelID: A, memoryID: 'last', type: '', risk: 'low', confidence: 0.8, content: '', summary: 'new music summary' } }] },
    { name: 'update_fingerprint_clash_leaves_ghost', steps: [
        create({ content: 'one about tea', summary: 'first' }),
        create({ content: 'two about game', summary: 'second' }),
        { op: 'update', input: { channelID: A, memoryID: 'last', content: 'ghost text about music', summary: 'first' } }] },
    { name: 'create_invalid_type_rolls_back', steps: [
        create({ content: 'bogus type tea', type: 'bogus', forceStatus: 'confirmed', bypassLearningConfig: true })] },
    { name: 'delete_by_id', seed: { memories: [stored(1, B)], points: [1] }, steps: [
        create({ content: 'delete me tea' }),
        { op: 'delete', input: { channelID: A, memoryID: 'last' } },
        { op: 'delete', input: { channelID: A, memoryID: 'last' } },
        { op: 'delete', input: { channelID: A, memoryID: oid(1) } },
        { op: 'delete', input: { channelID: A, memoryID: 'zzz' } }] },
    { name: 'delete_point_without_id_crosses_channels', seed: { memories: [stored(1, B)], points: [1] }, steps: [
        { op: 'rawDeletePoint', input: { qdrantPointID: 1001, channelID: A } }] },
    { name: 'delete_all_of_a_channel', seed: { memories: [stored(1, A), stored(2, A, { status: 'archived' }), stored(3, B)], points: [1, 3] }, steps: [
        { op: 'deleteAll', input: { channelID: A } }] },
    { name: 'list_paging_and_filters', seed: { memories: [
        stored(1, A), stored(2, A, { status: 'pending_review' }), stored(3, A, { type: 'preference' }), stored(4, A, { status: 'archived' }),
        stored(5, A, { updatedAt: { $date: { $numberLong: String(T0) } } }), stored(6, A), stored(7, B)] }, steps: [
        { op: 'list', input: { channelID: A, limit: 3 } },
        { op: 'list', input: { channelID: A, limit: 3, skip: 3 } },
        { op: 'list', input: { channelID: A, statuses: ['confirmed', 'archived'] } },
        { op: 'list', input: { channelID: A, type: 'preference' } },
        { op: 'list', input: { channelID: A, statuses: ['nope'] } },
        { op: 'list', input: { channelID: A, limit: 0, skip: -5 } },
        { op: 'list', input: { channelID: A, limit: 500 } },
        { op: 'list', input: { channelID: A, limit: 2.7, skip: 1.5 } }] },
    { name: 'recall', steps: [
        create({ content: 'Streamer loves tea', summary: 'tea lover' }),
        create({ content: 'Weekly game night', summary: 'game night' }),
        create({ content: 'Music and tea mornings', summary: 'tea music' }),
        create({ content: 'Viewer fact tea', summary: 'viewer tea', type: 'preference', subject: { scope: 'user', username: 'v1', userID: '11' } }),
        create({ channelID: B, content: 'Other channel tea', summary: 'b tea' }),
        create({ content: 'pending tea', summary: 'pending tea', confidence: 0.1 }),
        { op: 'recall', input: { channelID: A, query: 'tea please', limit: 2, mode: 'explicit', subjectScope: 'any' } },
        { op: 'recall', input: { channelID: A, query: 'tea please', limit: 5, mode: 'explicit' } },
        { op: 'recall', input: { channelID: A, query: 'tea', limit: 5, minScore: 0.9, subjectScope: 'any' } },
        { op: 'recall', input: { channelID: A, query: 'tell me about tea lover', limit: 3 } },
        { op: 'recall', input: { channelID: A, query: 'nothing matches', limit: 3, mode: 'explicit' } },
        { op: 'recall', input: { channelID: '3003', query: 'tea', limit: 3, mode: 'explicit' } },
        { op: 'recall', input: { channelID: A, query: 'EMPTYVEC', limit: 3 } },
        { op: 'recall', input: { channelID: A, query: '', limit: 3 } }] },
    { name: 'known_user_facts', seed: { memories: [
        stored(1, A, { type: 'known_user_fact', subject: { scope: 'user', username: 'u', userID: '11' }, confidence: 0.5 }),
        stored(2, A, { type: 'known_user_fact', subject: { scope: 'user', username: 'u', userID: '11' }, risk: 'high', confidence: 0.95 }),
        stored(3, A, { type: 'known_user_fact', subject: { scope: 'user', username: 'u', userID: '11' }, expiresAt: { $date: { $numberLong: String(T0 - 1000) } } }),
        stored(4, A, { type: 'known_user_fact', subject: { scope: 'user', username: 'u', userID: '11' }, expiresAt: { $date: { $numberLong: String(T0 + 86_400_000) } }, confidence: 0.7, lastUsedAt: { $date: { $numberLong: String(T0 - 5000) } } }),
        stored(5, A, { type: 'known_user_fact', subject: { scope: 'user', username: 'w', userID: '12' } }),
        stored(6, B, { type: 'known_user_fact', subject: { scope: 'user', username: 'u', userID: '11' } }),
        stored(7, A, { type: 'known_user_fact', subject: { scope: 'user', username: 'u', userID: '11' }, confidence: 0.7, updatedAt: '$unset' })] }, steps: [
        { op: 'known', input: { channelID: A, userID: '11', limit: 10 } },
        { op: 'known', input: { channelID: A, userID: '11', limit: 2, allowSensitiveMemories: true } },
        { op: 'known', input: { channelID: A, userID: '11', limit: 0 } },
        { op: 'known', input: { channelID: A, userID: '', limit: 3 } }] },
    { name: 'validate_recalled_ids', seed: { memories: [
        stored(1, A), stored(2, A, { status: 'pending_review' }), stored(3, B), stored(4, A, { type: 'running_joke' }),
        stored(5, A, { expiresAt: { $date: { $numberLong: String(T0 - 1) } } }), stored(6, A, { subject: { scope: 'user', username: 'Uu', userID: '6' }, type: 'preference' }), stored(7, A, { risk: 'medium' })] }, steps: [
        { op: 'validate', input: { channelID: A, limit: 10, policy: { allowSensitiveMemories: false, allowUserPreferenceMemories: true, allowRunningJokes: false },
            candidates: [oid(1), oid(2), oid(3), oid(4), oid(5), oid(6), oid(7), 'bad', oid(99)].map((memory_id, i) => ({ memory_id, score: 0.9 - i / 100 })) } },
        { op: 'validate', input: { channelID: A, limit: 1, policy: { allowSensitiveMemories: true, allowUserPreferenceMemories: true, allowRunningJokes: true },
            candidates: [{ memory_id: oid(7), score: 0.5 }, { memory_id: oid(1), score: 0.4 }] } }] },
    { name: 'usage_counts', seed: { memories: [stored(1, A), stored(2, A), stored(3, B)] }, steps: [
        { op: 'usage', input: { channelID: A, memoryIDs: [oid(1), oid(3), ''] } },
        { op: 'usage', input: { channelID: A, memoryIDs: [oid(2), 'bad-id'] } }] },
    { name: 'sync_assigns_missing_point_id', seed: { memories: [stored(1, A, { qdrantPointID: '$unset', content: 'legacy tea memory' }), stored(2, A, { qdrantPointID: '$unset', status: 'archived' })] }, steps: [
        { op: 'sync', input: { channelID: A, memoryID: oid(1) } },
        { op: 'sync', input: { channelID: A, memoryID: oid(2) } }] },
    { name: 'learning_settings', seed: { personalities: [personality(A, { autoConfirmThreshold: 0.5, createMinConfidence: 0.6, autoConfirmEnabled: false })] }, steps: [
        { op: 'learning', input: { channelID: A } }, { op: 'learning', input: { channelID: B } },
        create({ content: 'no auto confirm', confidence: 0.99 })] },
];

// ---- Runner. ---------------------------------------------------------------------------------
const ejson = (v: unknown) => JSON.parse(EJSON.stringify(v, { relaxed: false }));
const plain = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));
const memoryPayload = (m: any) => ({
    qdrantPointID: m.qdrantPointID, memoryId: String(m._id), channelID: m.channelID, memoryType: m.type, status: m.status, risk: m.risk,
    confidence: m.confidence, subjectScope: m.subject.scope, subjectUsername: m.subject.username, subjectUserID: m.subject.userID,
    content: m.content, summary: m.summary, createdAtUnix: Math.floor(m.createdAt.getTime() / 1000), updatedAtUnix: Math.floor(m.updatedAt.getTime() / 1000),
});

const dropScratch = async () => {
    await mongoose.connection.db?.dropDatabase().catch(() => {});
    const headers: Record<string, string> = {};
    if (QKEY) headers['api-key'] = QKEY;
    await fetch(`${QDRANT}/collections/${SCRATCH}`, { method: 'DELETE', headers }).catch(() => {});
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { mock.timers.reset(); dropScratch().finally(() => process.exit(130)); });
}
const recorded: any[] = [];
try {
    mock.timers.enable({ apis: ['Date'], now: T0 });
    for (const scenario of scenarios) {
        counter = 0;
        await mongoose.connection.db.collection('channelaimemories').deleteMany({});
        await mongoose.connection.db.collection('channelaipersonalities').deleteMany({});
        await resetQdrant();
        mock.timers.setTime(T0);
        const seed = scenario.seed ?? {};
        for (const p of seed.personalities ?? []) await mongoose.connection.db.collection('channelaipersonalities').insertOne(EJSON.deserialize(p, { relaxed: false }));
        for (const m of seed.memories ?? []) await mongoose.connection.db.collection('channelaimemories').insertOne(EJSON.deserialize(m, { relaxed: false }));
        for (const n of seed.points ?? []) {
            if (process.env.TRACE) console.log('seed point', n);
            const memory = await ChannelAIMemorySchema.findById(oid(n));
            const r = await sync.upsertChannelMemoryEmbedding(memoryPayload(memory));
            if (r.error) throw new Error(`seed point ${n}: ${r.message}`);
        }
        events = []; embeddings = [];
        let last = '';
        const steps: any[] = [];
        for (const [i, step] of scenario.steps.entries()) {
            const now = T0 + (i + 1) * 1000;
            mock.timers.setTime(now);
            const input = { ...step.input };
            if (input.memoryID === 'last') input.memoryID = last;
            events.push({ step: i });
            if (process.env.TRACE) console.log('step', i, step.op);
            let result: unknown;
            switch (step.op) {
                case 'create': result = plain(await service.createOrUpdateChannelMemory(input)); break;
                case 'status': result = plain(await service.setChannelMemoryStatus(input)); break;
                case 'update': result = plain(await service.updateChannelMemory(input)); break;
                case 'delete': result = plain(await service.deleteChannelMemoryPermanently(input)); break;
                case 'list': result = plain(await service.listChannelMemories(input)); break;
                case 'pending': result = await service.getChannelMemoryPendingCount(input.channelID); break;
                case 'known': result = plain(await service.getKnownUserMemoryContext(input)); break;
                case 'validate': result = plain(await service.validateChannelMemoryContext(input)); break;
                case 'usage': result = plain(await service.recordChannelMemoryUsage(input.channelID, input.memoryIDs)); break;
                case 'recall': result = plain(await retrieve.retrieveChannelMemoryContext(input)); break;
                case 'learning': result = plain(await service.getChannelLearningConfig(input.channelID)); break;
                case 'sync': {
                    const memory = await ChannelAIMemorySchema.findById(input.memoryID);
                    try { await service.syncMemoryToQdrant(memory); result = { error: false }; } catch (e) { result = { error: true, message: (e as Error).message }; }
                    break;
                }
                case 'rawDeletePoint': result = plain(await sync.deleteChannelMemoryEmbedding(input.qdrantPointID, input.channelID)); break;
                case 'deleteAll': {
                    // `account_deletion.ts`: the channel's points, later the documents.
                    const points = plain(await sync.deleteChannelMemoryEmbeddingsByChannel(input.channelID));
                    const docs = await ChannelAIMemorySchema.deleteMany({ channelID: input.channelID });
                    result = { points, deletedCount: docs.deletedCount };
                    break;
                }
                default: throw new Error(step.op);
            }
            const id = (result as any)?.memory?._id;
            if (id) last = String(id);
            steps.push({ op: step.op, at: now, input, result });
        }
        const finalEvents = [...events];
        const documents = (await mongoose.connection.db.collection('channelaimemories').find({}).sort({ _id: 1 }).toArray()).map(ejson);
        const points = ((await qdrant('POST', '/points/scroll', { limit: 1000, with_payload: true, with_vector: true })).points as any[])
            .sort((a, b) => a.id - b.id);
        recorded.push({ name: scenario.name, seed, steps, documents, points, embeddings: [...embeddings], events: finalEvents });
        console.log(`recorded ${scenario.name}`);
    }
} finally {
    mock.timers.reset();
    await dropScratch();
    await mongoose.disconnect();
    embedServer.close(); proxy.close();
}
fs.writeFileSync(out, JSON.stringify({
    reference: '0c71108e',
    sources: Object.fromEntries(SOURCES.map(s => [s, sha(s)])),
    t0: T0, names: NAMES, scenarios: recorded,
}, null, 1) + '\n');
