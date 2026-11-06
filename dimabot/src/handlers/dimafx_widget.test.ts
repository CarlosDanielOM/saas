import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Custom widget `dimafx` events: once per purchase, paid amount from the purchase record, buyer only when shared.
process.env.SECRET_KEY ??= 'a'.repeat(32); // imported services read it at load; nothing is encrypted here
const events: { channel: string; data: Record<string, unknown> }[] = [];
let lookups = 0;
mock.module('../functions/users/get_user_by_id.users.js', { namedExports: { getTwitchUserById: async (id: string) => { lookups++; return { error: false, message: '', data: { id, login: 'ame', display_name: 'Ame' } }; } } });
// Playback jobs in memory: the widget claim is a conditional update on the job, like Mongo's.
const jobs = new Map<string, { channelID: string; widgetSentAt: Date | null }>();
const seed = (...ids: string[]) => { for (const id of ids) jobs.set(id, { channelID: id === 'bits-3' ? 'nobody' : '42', widgetSentAt: null }); };
mock.module('../schemas/dimafx_playback.schema.js', { namedExports: { DimafxPlaybackSchema: {
  updateOne: async (filter: { _id: string; channelID: string; widgetSentAt: null }, update: { $set: { widgetSentAt: Date } }) => {
    const job = jobs.get(filter._id);
    if (!job || job.channelID !== filter.channelID || job.widgetSentAt !== null) return { modifiedCount: 0 };
    job.widgetSentAt = update.$set.widgetSentAt; return { modifiedCount: 1 };
  } } } });
const { DimafxQueueHandler } = await import('./dimafx_queue.handler.js');
const { registerStudioBridge } = await import('../overlays/bridge.js');
registerStudioBridge({ hasSource: () => false, media: async () => {}, trigger: async () => {},
  widgetEvent: (channel, _use, _type, data) => { events.push({ channel, data: data as Record<string, unknown> }); return 1; }, widgetsUse: channel => channel !== 'nobody' });
const handler = new DimafxQueueHandler() as unknown as { publishWidget(channel: string, item: Record<string, unknown>): void };
const item = (extra: Record<string, unknown>) => ({ triggerID: 'bits-1', channelID: '42', itemID: 'i1', name: 'Confetti', category: 'video', volume: 1, durationMs: 1, source: 'bits_purchase', enqueuedAt: 0,
  refundOnFailure: { userID: 'refund-id', priceBits: 999 }, tts: { text: 'fixed item line', voice: 'v', language: 'en' }, ...extra });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('a purchase reaches widgets once, with the ledger price, the shared buyer and only the viewer\'s own text', async () => {
  seed('bits-1');
  handler.publishWidget('42', item({ widget: { bits: 100, credits: null, buyerId: '77', message: 'hi chat' } }));
  handler.publishWidget('42', item({ widget: { bits: 100, credits: null, buyerId: '77', message: 'hi chat' } })); // 5 s redelivery / retry
  await settle();
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0].data, at: 0 }, { id: 'bits-1', item: { id: 'i1', name: 'Confetti', type: 'video' }, source: 'bits', bits: 100, credits: null,
    user: { id: '77', login: 'ame', name: 'Ame' }, message: 'hi chat', at: 0, test: false });
  assert.ok(!JSON.stringify(events).includes('refund-id') && !JSON.stringify(events).includes('fixed item line'), 'never refund data or the item\'s fixed TTS line');
});

test('a job recovered by a new process (API restart) is not announced again', async () => {
  events.length = 0;
  const restarted = new DimafxQueueHandler() as unknown as typeof handler;
  restarted.publishWidget('42', item({ widget: { bits: 100, credits: null, buyerId: '77', message: 'hi chat' } }));
  await settle();
  assert.equal(events.length, 0);
});

test('anonymous buyers stay anonymous; channels without dimafx widgets cost nothing', async () => {
  events.length = 0; lookups = 0; seed('credit-2', 'bits-3');
  handler.publishWidget('42', item({ triggerID: 'credit-2', source: 'credit_purchase', widget: { bits: null, credits: 50, buyerId: null, message: null } }));
  handler.publishWidget('nobody', item({ triggerID: 'bits-3', widget: { bits: 10, credits: null, buyerId: '77', message: null } }));
  await settle();
  assert.deepEqual(events.map(event => [event.data.source, event.data.credits, event.data.user]), [['credits', 50, null]]);
  assert.equal(lookups, 0);
});
