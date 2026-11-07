import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import express from 'express';
import mongoose, { Types } from 'mongoose';
import type { AddressInfo } from 'node:net';

// Run only against an explicitly supplied, disposable loopback database.
const uri = process.env.DIMAFX_TEST_MONGO_URI;
if (!uri || !/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri)) throw new Error('DIMAFX_TEST_MONGO_URI must identify disposable loopback Mongo');
process.env.DIMAFX_SERVICE_TOKEN = 'fixture-service-token';
process.env.SECRET_KEY = 'fixture-secret';
let connected = true;
let captions = true;
let namesAvailable = true;
let requester = '';
let decisionMode: number | 'refusal' = 0;
let providerCalls = 0;
let synthesisGate: Promise<void> | undefined;
let synthesisStarted = false;
let autoAck: string | undefined = 'completed';
const emissions: { channelID: string; event: string; body: { triggerID: string; durationMs?: number } }[] = [];
let handler: typeof import('../../handlers/dimafx_queue.handler.js').dimafxQueueHandler;
mock.module('../websocket.js', { namedExports: { getIO: () => ({ of: (namespace: string) => ({ sockets: new Map(connected ? [['socket', {
  connected: true, data: { dimafxReady: true, dimafxCaptions: captions }, emit: (event: string, body: { triggerID: string }) => {
    const channelID = namespace.split('/').at(-1)!;
    emissions.push({ channelID, event, body });
    if (event === 'dimafx-play' && autoAck !== 'none') void handler.handleTriggerEnded(channelID, body.triggerID, autoAck);
  },
}]] : []) }) }) } });
mock.module('../../functions/users/get_user_by_id.users.js', { namedExports: { getTwitchUserById: async () => namesAvailable ? { error: false, data: { display_name: 'Viewer Name', login: 'viewername' } } : null } });
mock.module('./media_library.service.js', { namedExports: { buildMediaPlaybackUrl: (id: unknown) => `https://fixture.invalid/media/${id}` } });
mock.module('../../utils/thumbnail_generator.js', { namedExports: { scheduleThumbnailGeneration: () => {} } });
mock.module('../../middleware/auth.middleware.js', { namedExports: { authMiddleware: (req: express.Request & { user?: object }, _res: express.Response, next: express.NextFunction) => { req.user = { id: requester || req.params.channelID }; next(); } } });
mock.module('../../middleware/admin.middleware.js', { namedExports: { hasGlobalChannelOwnerAccess: async () => false } });
mock.module('./tts/piper_tts.service.js', { namedExports: { piperTtsService: { synthesize: async () => { synthesisStarted = true; if (synthesisGate) await synthesisGate; return { error: false, outputPath: '/tmp/dimafx-fixture-nonexistent.wav', publicPath: 'https://fixture.invalid/speech', mimeType: 'audio/wav' }; } } } });
mock.module('../../utils/tts/tts_playback_timeout.util.js', { namedExports: { getAudioFileDurationMs: async () => 50 } });
const { dimafxQueueHandler } = await import('../../handlers/dimafx_queue.handler.js');
handler = dimafxQueueHandler;
const { dimafxRoute, recoverDimafxPurchases } = await import('../routes/dimafx.route.js');
const { ChannelExtensionItemSchema: Items } = await import('../../schemas/channel_extension_item.schema.js');
const { UserExtensionInventorySchema: Wallets } = await import('../../schemas/user_extension_inventory.schema.js');
const { ExtensionWalletTransactionSchema: Ledgers, DimafxTransactionClaimSchema: Claims } = await import('../../schemas/extension_wallet_transaction.schema.js');
const { DimafxPlaybackSchema: Jobs, DimafxQueueGateSchema: Gates, DimafxFreePaceSchema: Pace } = await import('../../schemas/dimafx_playback.schema.js');
const { MediaAssetSchema: Assets } = await import('../../schemas/media_asset.schema.js');
const { refundDeletedDimafxItem } = await import('./dimafx-deletion.service.js');
const { deleteChannelDimafxData } = await import('../../utils/dimafx_data.js');
await mongoose.connect(uri, { dbName: 'dimafx_money_test' });
// Reproduce the actual production legacy NON-UNIQUE transaction index.
await Promise.all([Ledgers.init(), Claims.init(), Jobs.init(), Gates.init(), Wallets.init(), Pace.init(), Items.init()]);
assert.equal((await Ledgers.collection.indexes()).find(index => index.name === 'twitchTransactionID_1')?.unique, undefined);
const app = express(); app.use(express.json()); app.use('/extensions/dimafx', dimafxRoute);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/extensions/dimafx`;
process.env.OPENROUTER_API_KEY = 'fixture-decisions-key';
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://openrouter.ai/api/alpha/decisions') return nativeFetch(url, init);
  providerCalls++;
  const request = JSON.parse(String(init?.body));
  assert.deepEqual(request.provider, { data_collection: 'deny' });
  assert.equal(request.model, 'openai/gpt-6-luna-decisions');
  if (typeof decisionMode === 'number' && decisionMode > 1) return new Response('{}', { status: decisionMode });
  return new Response(JSON.stringify({ id: 'decision-fixture', model: 'openai/gpt-6-luna-decisions-20261006',
    answers: { violation: decisionMode === 'refusal' ? { type: 'refusal' } : { type: 'noul', noul: decisionMode } },
  }), { status: 200 });
};
const wait = async (condition: () => unknown | Promise<unknown>, label = 'condition') => {
  const until = Date.now() + 6000;
  while (!await condition()) { assert.ok(Date.now() < until, label); await new Promise(resolve => setTimeout(resolve, 10)); }
};
let serial = 0;
async function fixture(price = 5) {
  connected = true; captions = true; namesAvailable = true; requester = ''; decisionMode = 0; autoAck = 'completed';
  const channelID = `money-${++serial}`;
  const assetID = new Types.ObjectId();
  await Assets.collection.insertOne({ _id: assetID, s3Key: String(assetID), mimeType: 'video/mp4', deletedAt: null });
  const item = await Items.create({ channelID, channelName: 'fixture', createdByUserID: channelID, assetID, name: 'Fixture', category: 'video', mediaType: 'video', durationMs: 50, bitsPrice: price, sku: price ? 'dimafx_bits_5' : 'free' });
  const wallet = await Wallets.create({ channelID, userID: 'buyer', balance: 100 });
  const post = async (body: object, route = 'purchase', itemID = String(item._id)) => {
    const response = await fetch(`${base}/internal/channels/${channelID}/items/${itemID}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dimafx-service-token': 'fixture-service-token' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const bits = (transactionID: string, extra = {}) => ({ userID: 'buyer', opaqueUserID: 'Ubuyer', identityShared: true, action: 'use_now',
    bitsTransaction: { transactionID, userID: 'buyer', sku: 'dimafx_bits_5', amount: 5, time: new Date().toISOString(), inDevelopment: true }, ...extra });
  const balance = async () => (await Wallets.findById(wallet._id).lean())!.balance;
  const drained = () => wait(async () => !await Jobs.exists({ channelID, state: { $nin: ['completed', 'refunded', 'removed_by_broadcaster'] } }), 'queue drained');
  return { channelID, item, wallet, post, bits, balance, drained };
}
after(async () => {
  connected = false;
  await wait(() => (handler as unknown as { processingChannels: Set<string> }).processingChannels.size === 0, 'queue stopped');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  globalThis.fetch = nativeFetch;
  await mongoose.connection.dropDatabase(); await mongoose.disconnect();
});

test('concurrent first deliveries claim a Twitch transaction exactly once despite the non-unique legacy index', async () => {
  const f = await fixture();
  const responses = await Promise.all(Array.from({ length: 20 }, () => f.post(f.bits('concurrent'))));
  assert.ok(responses.every(result => [200, 503].includes(result.status)), JSON.stringify(responses));
  await f.drained();
  assert.equal(await Claims.countDocuments({ _id: 'concurrent' }), 1);
  assert.equal(await Ledgers.countDocuments({ twitchTransactionID: 'concurrent' }), 1);
  assert.equal(await Jobs.countDocuments({ channelID: f.channelID }), 1);
  const resumed = await f.post(f.bits('concurrent', { sku: 'tampered', transactionID: 'tampered' }));
  assert.equal(resumed.status, 200); assert.equal(resumed.body.data.duplicate, true);
  assert.equal(await f.balance(), 100);
});
test('price changes, deleted/disabled items, wrong SKU, unavailable save and offline overlay make good paid receipts', async () => {
  for (const reason of ['price', 'deleted', 'disabled', 'sku', 'save', 'offline', 'invalid-id']) {
    const f = await fixture();
    if (reason === 'price') await Items.updateOne({ _id: f.item._id }, { $set: { bitsPrice: 10 } });
    if (reason === 'deleted') await Items.updateOne({ _id: f.item._id }, { $set: { deletedAt: new Date() } });
    if (reason === 'disabled') await Items.updateOne({ _id: f.item._id }, { $set: { isEnabled: false } });
    if (reason === 'sku') await Items.updateOne({ _id: f.item._id }, { $set: { sku: 'other' } });
    if (reason === 'offline') connected = false;
    const body = f.bits(`unavailable-${reason}`, reason === 'save' ? { action: 'save', identityShared: false, userID: undefined } : { userID: undefined, identityShared: false });
    const result = await f.post(body, 'purchase', reason === 'invalid-id' ? 'invalid' : undefined);
    assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.data.madeGood.credits, 5);
    assert.equal(result.body.data.inventory.userID, 'buyer'); assert.equal(await f.balance(), 105);
    assert.equal((await f.post(body)).status, 200); assert.equal(await f.balance(), 105);
    assert.equal(await Jobs.countDocuments({ channelID: f.channelID }), 0);
  }
});
test('free route cannot consume a paid SKU or bypass receipts; server IDs and atomic free pacing limit concurrent plays', async () => {
  const paid = await fixture();
  assert.equal((await paid.post({ userID: 'buyer', opaqueUserID: 'Ubuyer', sku: 'dimafx_bits_5', transactionID: 'forged' })).status, 400);
  const f = await fixture(0);
  assert.equal((await f.post({ userID: 'buyer', opaqueUserID: 'Ubuyer', sku: 'dimafx_bits_5' })).status, 400);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.post({ userID: 'buyer', opaqueUserID: 'Ubuyer', sku: 'free', transactionID: 'client-controlled' })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 429).length, 11);
  const success = results.find(result => result.status === 200)!;
  assert.match(success.body.data.triggerID, /^free-/); assert.notEqual(success.body.data.triggerID, 'client-controlled');
  assert.equal(await Ledgers.countDocuments({ channelID: f.channelID }), 0);
  await f.drained();
  await Wallets.updateOne({ _id: f.wallet._id }, { $push: { items: { channelExtensionItemID: f.item._id, quantity: 20, purchasePriceBits: 0, source: 'bits_purchase', acquiredAt: new Date() } } });
  await Pace.deleteMany({ channelID: f.channelID });
  assert.equal((await f.post({ userID: 'buyer', opaqueUserID: 'Ubuyer', sku: 'free', action: 'save' })).status, 429);
});
test('player-reported failure makes good once; legacy acknowledgements still succeed', async () => {
  const f = await fixture(); autoAck = 'failed';
  assert.equal((await f.post(f.bits('player-failure'))).status, 200);
  await f.drained(); assert.equal(await f.balance(), 105);
  const duplicate = await f.post(f.bits('player-failure'));
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.data.madeGood.credits, 5); assert.equal(await f.balance(), 105);
  autoAck = undefined;
  assert.equal((await f.post(f.bits('legacy-success'))).status, 200);
  await f.drained(); assert.equal(await f.balance(), 105);
  assert.equal((await Jobs.findOne({ channelID: f.channelID, state: 'completed' }).lean())?.state, 'completed');
});
test('no acknowledgement is uncertain: stop the timed-out job and make good, then advance', async () => {
  const f = await fixture(); autoAck = 'none';
  const patch = mock.method(handler as unknown as { playbackWaitMs: () => number }, 'playbackWaitMs', () => 35);
  try {
    const first = await f.post(f.bits('timeout-one')); const second = await f.post(f.bits('timeout-two'));
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    await f.drained(); assert.equal(await f.balance(), 110);
    const events = emissions.filter(event => event.channelID === f.channelID);
    assert.ok(events.findIndex(event => event.event === 'dimafx-stop') < events.findIndex(event => event.event === 'dimafx-play' && event.body.triggerID === second.body.data.triggerID));
    assert.equal(events[0].body.durationMs, 50);
  } finally { patch.mock.restore(); }
});
test('atomic queue admission never exceeds 25 parallel reservations', async () => {
  const f = await fixture(); autoAck = 'none';
  const processing = mock.method(handler, 'processNext', async () => {});
  try {
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => handler.enqueue({ channelID: f.channelID, triggerID: `capacity-${i}`, item: f.item.toObject(), asset: { _id: f.item.assetID, mimeType: 'video/mp4' } as never, source: 'test' })));
    assert.equal(results.filter(result => result.ok).length, 25);
    assert.equal((await Gates.findById(f.channelID).lean())?.slots.length, 25);
    assert.equal(await Jobs.countDocuments({ channelID: f.channelID }), 25);
  } finally { processing.mock.restore(); await Jobs.updateMany({ channelID: f.channelID }, { $set: { state: 'completed' } }); }
});
test('credit debit survives crash before enqueue, and persisted-then-thrown enqueue never restores a playable spend', async () => {
  for (const persistFirst of [false, true]) {
    const f = await fixture();
    const original = handler.enqueue.bind(handler);
    const injection = mock.method(handler, 'enqueue', async (input: import('../../handlers/dimafx_queue.handler.js').DimafxEnqueueInput) => { if (persistFirst) await original(input); throw new Error('simulated process interruption'); });
    try { assert.equal((await f.post({ userID: 'buyer', action: 'use_now' }, 'use-credit')).status, 500); }
    finally { injection.mock.restore(); }
    assert.equal(await f.balance(), 95);
    const ledger = await Ledgers.findOne({ channelID: f.channelID, type: 'credit_purchase' }).lean(); assert.ok(ledger);
    await Ledgers.updateOne({ _id: ledger._id }, { $set: { updatedAt: new Date(Date.now() - 31_000) } }, { timestamps: false });
    await recoverDimafxPurchases(f.channelID); await f.drained();
    assert.equal(await f.balance(), 95); assert.equal(await Jobs.countDocuments({ _id: `spend-${ledger._id}` }), 1);
  }
});
test('saved debit survives interruption; definite admission failure restores exactly one copy', async () => {
  const f = await fixture();
  await Wallets.updateOne({ _id: f.wallet._id }, { $push: { items: { channelExtensionItemID: f.item._id, quantity: 2, purchasePriceBits: 5, acquiredAt: new Date(), source: 'bits_purchase' } } });
  const injection = mock.method(handler, 'enqueue', async () => { throw new Error('simulated interruption'); });
  try { assert.equal((await f.post({ userID: 'buyer' }, 'redeem')).status, 500); } finally { injection.mock.restore(); }
  assert.equal((await Wallets.findById(f.wallet._id).lean())!.items[0].quantity, 1);
  const ledger = await Ledgers.findOne({ channelID: f.channelID, type: 'redeem_saved' }).lean(); assert.ok(ledger);
  await Ledgers.updateOne({ _id: ledger._id }, { $set: { updatedAt: new Date(Date.now() - 31_000) } }, { timestamps: false });
  await recoverDimafxPurchases(f.channelID); await f.drained();
  assert.equal((await Wallets.findById(f.wallet._id).lean())!.items[0].quantity, 1);
  const reject = mock.method(handler, 'enqueue', async () => ({ ok: false as const, status: 429, message: 'full' }));
  try { assert.equal((await f.post({ userID: 'buyer' }, 'redeem')).status, 200); } finally { reject.mock.restore(); }
  assert.equal((await Wallets.findById(f.wallet._id).lean())!.items[0].quantity, 1);
  await recoverDimafxPurchases(f.channelID);
  assert.equal((await Wallets.findById(f.wallet._id).lean())!.items[0].quantity, 1);
});
test('claim-only crash recovers its immutable ledger; claim and admission data are deleted with channel data', async () => {
  const f = await fixture();
  const ledgerID = new Types.ObjectId();
  await Claims.create({ _id: 'claim-only', channelID: f.channelID, userID: 'buyer', materialized: false, ledger: {
    _id: ledgerID, platform: 'twitch', userID: 'buyer', channelID: f.channelID, type: 'bits_purchase', amountBits: 5,
    balanceDelta: 0, channelExtensionItemID: f.item._id, twitchTransactionID: 'claim-only', sku: 'dimafx_bits_5', metadata: { fulfillment: 'pending', action: 'use_now', identityShared: true },
  } });
  assert.equal((await f.post(f.bits('claim-only'))).status, 200); await f.drained();
  assert.equal(await Ledgers.countDocuments({ _id: ledgerID }), 1);
  await deleteChannelDimafxData(f.channelID);
  assert.equal(await Claims.countDocuments({ channelID: f.channelID }), 0); assert.equal(await Gates.countDocuments({ _id: f.channelID }), 0);
});
test('delete refunds resume after audit interruption and do not overwrite concurrent wallet changes', async () => {
  const f = await fixture();
  await Wallets.updateOne({ _id: f.wallet._id }, { $push: { items: { channelExtensionItemID: f.item._id, quantity: 3, purchasePriceBits: 5, source: 'bits_purchase', acquiredAt: new Date() } } });
  await Items.updateOne({ _id: f.item._id }, { $set: { deletedAt: new Date(), isEnabled: false, refundSavedPending: true } });
  const original = Ledgers.updateOne.bind(Ledgers);
  const callOriginal = original as unknown as (...args: unknown[]) => ReturnType<typeof Ledgers.updateOne>;
  const fail = mock.method(Ledgers, 'updateOne', (filter: unknown, update: unknown, options?: unknown) => {
    if ((update as { $setOnInsert?: { metadata?: { reason?: string } } }).$setOnInsert?.metadata?.reason === 'channel_extension_item_deleted') throw new Error('audit interrupted');
    return callOriginal(filter, update, options);
  });
  try { await assert.rejects(refundDeletedDimafxItem(f.channelID, String(f.item._id)), /audit interrupted/); } finally { fail.mock.restore(); }
  assert.equal(await f.balance(), 115);
  await Wallets.updateOne({ _id: f.wallet._id }, { $inc: { balance: 7 } });
  await refundDeletedDimafxItem(f.channelID, String(f.item._id));
  await refundDeletedDimafxItem(f.channelID, String(f.item._id));
  assert.equal(await f.balance(), 122);
  assert.equal(await Ledgers.countDocuments({ channelID: f.channelID, type: 'refund_credit' }), 1);
  assert.equal((await Wallets.findById(f.wallet._id).lean())!.dimafxDeletionRefunds.length, 0);
});

async function customFixture() {
  const f = await fixture();
  await Items.updateOne({ _id: f.item._id }, { $set: { category: 'tts', mediaType: 'audio', assetID: null, tts: { mode: 'custom', text: '', voice: 'fixture-voice', language: 'en' } } });
  return f;
}

test('TTS pre-check and post-payment share one cached decision; allowed viewer jobs persist attribution and moderation', async () => {
  const f = await customFixture();
  const before = providerCalls;
  const check = await f.post({ userID: 'buyer', ttsText: 'Hello everyone' }, 'tts-check');
  assert.equal(check.status, 200); assert.equal(check.body.data.allowed, true); assert.equal(await f.balance(), 100);
  autoAck = 'none';
  const result = await f.post(f.bits('moderated-allowed', { ttsText: 'Hello everyone' }));
  assert.equal(result.status, 200);
  await wait(() => emissions.some(event => event.channelID === f.channelID && event.event === 'dimafx-play'));
  const queue = await handler.snapshot(f.channelID);
  assert.equal(queue.playing?.viewerName, 'Viewer Name'); assert.equal(queue.playing?.text, 'Hello everyone');
  await handler.handleTriggerEnded(f.channelID, result.body.data.triggerID); await f.drained();
  assert.equal(providerCalls - before, 1);
  const job = await Jobs.findOne({ channelID: f.channelID }).lean(); assert.ok(job);
  assert.equal(job.payload.viewer?.name, 'Viewer Name'); assert.equal(job.payload.viewer?.text, 'Hello everyone');
  assert.equal(job.payload.moderation?.model, 'openai/gpt-6-luna-decisions-20261006');
  const ledger = await Ledgers.findOne({ channelID: f.channelID, type: 'bits_purchase' }).lean();
  assert.equal((ledger?.metadata.moderation as { score: number }).score, 0);
});
test('blocked, refusal and unavailable decisions fail closed; credits never debit and paid receipts are made good', async () => {
  for (const mode of [0.5, 'refusal', 400, 402, 429, 500, 524, 529] as const) {
    const f = await customFixture(); decisionMode = mode;
    const text = `Blocked fixture ${mode}`;
    const before = providerCalls;
    const check = await f.post({ userID: 'buyer', ttsText: text }, 'tts-check');
    assert.equal(check.status, 200); assert.equal(check.body.data.allowed, false);
    assert.equal(check.body.data.reason, mode === 0.5 ? 'blocked' : 'unavailable');
    const credit = await f.post({ userID: 'buyer', ttsText: text }, 'use-credit');
    assert.equal(credit.status, 200); assert.equal(credit.body.data.blocked, true); assert.equal(await f.balance(), 100);
    const result = await f.post(f.bits(`moderated-${mode}`, { ttsText: text }));
    assert.equal(result.status, 200); assert.equal(result.body.data.blocked, true); assert.equal(result.body.data.madeGood.credits, 5);
    assert.equal(await f.balance(), 105); assert.equal(await Jobs.countDocuments({ channelID: f.channelID }), 0);
    assert.equal(providerCalls - before, 1);
    assert.equal((await f.post(f.bits(`moderated-${mode}`, { ttsText: text }))).body.data.blocked, true);
  }
});
test('TTS pre-check requires shared identity and enforces ten checks per minute', async () => {
  const f = await customFixture();
  assert.equal((await f.post({ ttsText: 'Hi' }, 'tts-check')).status, 403);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.post({ userID: 'buyer', ttsText: 'Hi' }, 'tts-check')));
  assert.equal(results.filter(result => result.status === 200).length, 10);
  assert.equal(results.filter(result => result.status === 429).length, 2);
});
test('viewer text never reaches a legacy player or plays without a resolvable username', async () => {
  for (const reason of ['legacy', 'no-name']) {
    const f = await customFixture();
    if (reason === 'legacy') captions = false; else namesAvailable = false;
    const result = await f.post(f.bits(`attribution-${reason}`, { ttsText: 'Hi there' }));
    assert.equal(result.status, 200); assert.equal(result.body.data.madeGood.credits, 5);
    assert.equal(await Jobs.countDocuments({ channelID: f.channelID }), 0);
  }
});
test('broadcaster queue APIs expose attribution, enforce permissions, clear only queued entries and skip with no make-good', async () => {
  const f = await fixture(); autoAck = 'none';
  const first = await f.post(f.bits('remove-one')); const second = await f.post(f.bits('remove-two')); const third = await f.post(f.bits('remove-three')); const fourth = await f.post(f.bits('remove-four'));
  const manage = async (path: string, body?: object) => {
    const response = await fetch(`${base}/${f.channelID}/queue${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  await wait(() => emissions.some(event => event.channelID === f.channelID && event.event === 'dimafx-play'));
  const state = await manage(''); assert.equal(state.body.data.playing.id, first.body.data.triggerID); assert.equal(state.body.data.queued.length, 3);
  assert.deepEqual(Object.keys(state.body.data.playing).sort(), ['category', 'createdAt', 'id', 'itemID', 'itemName', 'source', 'text', 'viewerName'].sort());
  requester = 'intruder';
  for (const [path, body] of [['', undefined], ['/skip', {}], ['/clear', {}]] as const) assert.equal((await manage(path, body)).status, 403);
  requester = '';
  const specific = await manage('/skip', { id: second.body.data.triggerID }); assert.equal(specific.body.data.skipped, second.body.data.triggerID);
  const cleared = await manage('/clear', {}); assert.equal(cleared.body.data.removed, 2);
  assert.equal((await Jobs.findById(first.body.data.triggerID).lean())?.state, 'playing');
  const skipped = await manage('/skip', {}); assert.equal(skipped.body.data.skipped, first.body.data.triggerID);
  await f.drained();
  assert.equal(await f.balance(), 100);
  for (const id of [first.body.data.triggerID, second.body.data.triggerID, third.body.data.triggerID, fourth.body.data.triggerID]) assert.equal((await Jobs.findById(id).lean())?.state, 'removed_by_broadcaster');
  assert.ok(emissions.some(event => event.channelID === f.channelID && event.event === 'dimafx-stop'));
  assert.equal((await f.post(f.bits('remove-one'))).body.data.madeGood, undefined);
});

test('a persisted queue reservation survives interruption before job insertion', async () => {
  const f = await fixture();
  const persistence = mock.method(handler as unknown as { persistReservation: (...args: unknown[]) => Promise<void> }, 'persistReservation', async () => { throw new Error('job insertion interrupted'); });
  try { assert.equal((await f.post({ userID: 'buyer', action: 'use_now' }, 'use-credit')).status, 500); } finally { persistence.mock.restore(); }
  assert.equal(await f.balance(), 95);
  assert.equal((await Gates.findById(f.channelID).lean())?.slots.length, 1);
  assert.equal(await Jobs.countDocuments({ channelID: f.channelID }), 0);
  const ledger = await Ledgers.findOne({ channelID: f.channelID, type: 'credit_purchase' }).lean(); assert.ok(ledger);
  await Ledgers.updateOne({ _id: ledger._id }, { $set: { updatedAt: new Date(Date.now() - 31_000) } }, { timestamps: false });
  await recoverDimafxPurchases(f.channelID); await handler.resumeIfIdle(f.channelID); await f.drained();
  assert.equal(await Jobs.countDocuments({ channelID: f.channelID }), 1); assert.equal(await f.balance(), 95);
});
test('interrupted compensation remains a terminal refund decision and never queues the refunded spend', async () => {
  const f = await fixture();
  const enqueue = mock.method(handler, 'enqueue', async () => ({ ok: false as const, status: 429, message: 'full' }));
  const original = Ledgers.updateOne.bind(Ledgers) as unknown as (...args: unknown[]) => ReturnType<typeof Ledgers.updateOne>;
  const finalize = mock.method(Ledgers, 'updateOne', (filter: unknown, update: unknown, options?: unknown) => {
    if ((update as { $set?: Record<string, string> }).$set?.['metadata.fulfillment'] === 'refunded') throw new Error('refund finalization interrupted');
    return original(filter, update, options);
  });
  try { assert.equal((await f.post({ userID: 'buyer', action: 'use_now' }, 'use-credit')).status, 500); }
  finally { enqueue.mock.restore(); finalize.mock.restore(); }
  assert.equal(await f.balance(), 100);
  const ledger = await Ledgers.findOne({ channelID: f.channelID, type: 'credit_purchase' }).lean(); assert.ok(ledger); assert.equal(ledger.metadata.fulfillment, 'refund_pending');
  await Ledgers.updateOne({ _id: ledger._id }, { $set: { updatedAt: new Date(Date.now() - 31_000) } }, { timestamps: false });
  const noEnqueue = mock.method(handler, 'enqueue', async () => { throw new Error('must not enqueue compensated spend'); });
  try { await recoverDimafxPurchases(f.channelID); } finally { noEnqueue.mock.restore(); }
  assert.equal(await f.balance(), 100); assert.equal(await Jobs.countDocuments({ channelID: f.channelID }), 0);
  assert.equal((await Ledgers.findById(ledger._id).lean())?.metadata.fulfillment, 'refunded');
});

test('skip during synthesis advances immediately and the late speech result can never be dispatched', async () => {
  const f = await customFixture(); autoAck = 'none'; synthesisStarted = false;
  let release!: () => void;
  synthesisGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const custom = await f.post(f.bits('skip-synthesis', { ttsText: 'Hello queued speech' }));
    await wait(() => synthesisStarted, 'synthesis started');
    const mediaItem = await Items.create({ channelID: f.channelID, channelName: 'fixture', createdByUserID: f.channelID, assetID: f.item.assetID, name: 'After skipped speech', category: 'video', mediaType: 'video', bitsPrice: 5, sku: 'dimafx_bits_5' });
    const media = await f.post(f.bits('after-synthesis-skip'), 'purchase', String(mediaItem._id));
    assert.equal(await handler.skip(f.channelID), custom.body.data.triggerID);
    await wait(() => emissions.some(event => event.channelID === f.channelID && event.event === 'dimafx-play' && event.body.triggerID === media.body.data.triggerID), 'next job starts before synthesis resolves');
    release(); synthesisGate = undefined;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(emissions.filter(event => event.channelID === f.channelID && event.event === 'dimafx-play' && event.body.triggerID === custom.body.data.triggerID).length, 0);
    await handler.handleTriggerEnded(f.channelID, media.body.data.triggerID); await f.drained();
    assert.equal(await f.balance(), 100);
  } finally { release(); synthesisGate = undefined; }
});

test('broadcaster custom-TTS voice tests use only the application fixed sample', async () => {
  const f = await customFixture(); captions = false;
  const before = providerCalls;
  const response = await fetch(`${base}/${f.channelID}/items/${f.item._id}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ttsText: 'caller text must be ignored' }) });
  assert.equal(response.status, 200); await f.drained();
  const job = await Jobs.findOne({ channelID: f.channelID }).lean(); assert.ok(job);
  assert.equal(job.payload.ttsMode, 'fixed'); assert.equal(job.payload.tts?.text, 'This is a DimaFX test trigger.');
  assert.equal(job.payload.viewer, undefined); assert.equal(providerCalls, before); assert.equal(await f.balance(), 100);
});
