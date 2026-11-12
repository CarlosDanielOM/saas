// Records the read answers of `memory.service.ts` over a sample of real channels of the local
// production copy (`domdimabot`, read only: no index creation, no write). The fixture holds ids,
// numbers and SHA-256 hashes only: memory text is personal and never leaves the database.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//       "$REPO/dima-rust/crates/ai/tests/memory_store_real.mts" \
//       "$REPO/dima-rust/crates/ai/tests/memory_store_real.json"
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const root = process.env.DIMABOT_DIR!;
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

function load(rel: string, mapping: Record<string, unknown>) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} as Record<string, any> };
    vm.compileFunction(js, ['exports', 'require', 'module'])(module.exports, (spec: string) => {
        if (spec in mapping) return mapping[spec];
        throw new Error(`unexpected import ${spec}`);
    }, module);
    return module.exports;
}
const real = (rel: string) => import(path.join(root, rel));
const silent = async () => {};
const refuse = () => { throw new Error('no writes'); };
const hash = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

await mongoose.connect(process.env.DIMA_TEST_MONGO_URI!, { dbName: 'domdimabot', autoIndex: false, autoCreate: false });
const { ChannelAIMemorySchema } = await real('src/schemas/channel_ai_memory.schema.ts');
const { ChannelAIPersonalitySchema } = await real('src/schemas/channel_ai_personality.schema.ts');
const service = load('src/utils/ai/memory/memory.service.ts', {
    'node:crypto': crypto, mongoose: { Types: mongoose.Types },
    '../../../classes/twitch_streamers.class.js': { __esModule: true, default: { getTwitchAccountById: refuse } },
    '../../../schemas/channel_ai_memory.schema.js': { ChannelAIMemorySchema },
    '../../../schemas/channel_ai_personality.schema.js': { ChannelAIPersonalitySchema },
    '../../qdrant/functions/memory/sync_memory.qdrant.js': { upsertChannelMemoryEmbedding: refuse, deleteChannelMemoryEmbedding: refuse },
    '../../qdrant/qdrant_point_id.js': await real('src/utils/qdrant/qdrant_point_id.ts'),
    '../../logger.js': { error: silent, warn: silent },
    './memory_policy.js': await real('src/utils/ai/memory/memory_policy.ts'),
    './memory_time.js': await real('src/utils/ai/memory/memory_time.ts'),
});

const memories = mongoose.connection.db.collection('channelaimemories');
const channels: string[] = (await memories.distinct('channelID')).sort();
const step = Math.max(1, Math.floor(channels.length / 12));
const withFacts: string[] = (await memories.aggregate([
    { $match: { type: 'known_user_fact', status: 'confirmed', 'subject.userID': { $nin: ['', null] } } },
    { $group: { _id: '$channelID', n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }, { $limit: 4 }]).toArray()).map((g: any) => g._id);
const sample = [...new Set([...channels.filter((_, i) => i % step === 0).slice(0, 12), ...withFacts])];
const policies = [
    { allowSensitiveMemories: false, allowUserPreferenceMemories: true, allowRunningJokes: true },
    { allowSensitiveMemories: true, allowUserPreferenceMemories: false, allowRunningJokes: false },
];
const cases: any[] = [];
const total = await memories.countDocuments();
try {
    for (const [ci, channelID] of sample.entries()) {
        const lists = [
            { channelID },
            { channelID, statuses: ['confirmed'], limit: 20, skip: 5 },
            { channelID, statuses: ['pending_review', 'archived'] },
            { channelID, type: 'known_user_fact', limit: 200 },
        ].map(async (input) => {
            const r = await service.listChannelMemories(input);
            const items = JSON.parse(JSON.stringify(r.items));
            return { input, error: r.error, total: r.total, ids: items.map((i: any) => i._id), hashes: items.map(hash) };
        });
        const users: string[] = (await memories.distinct('subject.userID', { channelID, type: 'known_user_fact' })).filter(Boolean).sort().slice(0, 2);
        const known = [];
        for (const userID of users) for (const allowSensitiveMemories of [false, true]) {
            const r = await service.getKnownUserMemoryContext({ channelID, userID, limit: 5, allowSensitiveMemories });
            known.push({ input: { channelID, userID, limit: 5, allowSensitiveMemories },
                result: r.map((x: any) => ({ ...x, summary: hash(x.summary) })) });
        }
        const own = (await memories.find({ channelID }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(12).toArray()).map((d: any) => String(d._id));
        const other = sample[(ci + 1) % sample.length];
        const foreign = (await memories.find({ channelID: other }, { projection: { _id: 1 } }).limit(3).toArray()).map((d: any) => String(d._id));
        const candidates = [...own, ...foreign, 'bad'].map((memory_id, i) => ({ memory_id, score: 1 - i / 50 }));
        const validate = [];
        for (const policy of policies) {
            const r = await service.validateChannelMemoryContext({ channelID, candidates, limit: 6, policy });
            validate.push({ input: { channelID, candidates, limit: 6, policy }, result: r.map((x: any) => ({ ...x, summary: hash(x.summary) })) });
        }
        cases.push({ channelID, lists: await Promise.all(lists), pending: await service.getChannelMemoryPendingCount(channelID), known, validate });
    }
} finally {
    await mongoose.disconnect();
}
fs.writeFileSync(process.argv[2], JSON.stringify({ reference: '0c71108e', documents: total, cases }, null, 1) + '\n');
