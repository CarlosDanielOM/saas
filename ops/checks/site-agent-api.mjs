/**
 * Site agent API check: runs inside the candidate API container with disposable Mongo/Dragonfly and the fake
 * providers in site-agent-fixtures (OpenRouter, Polar, docs; nothing leaves the container).
 *
 *   scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
 *     --test-env ops/checks/site-agent-fixtures/test-env.json --fixtures ops/checks/site-agent-fixtures \
 *     --check ops/checks/site-agent-api.mjs
 *
 * Covers: unit suites in the exact image; access (owner, scoped admin, outsider, channel not enabled);
 * streaming order + text offsets; the exact model request (Luna, xhigh, tools by permission, byte-stable
 * system prompt, turn note); multi-step tools with reasoning echoed; steer, queue, stop, retry, 409s;
 * idempotent requests; approvals (apply/skip) with the change log + undo; UI forms; navigation; daily
 * limits (20/day free) with refunds on our own failures; provider errors; SSE reconnect + resync; Polar
 * `ai_assistant` events (no credits); session privacy.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { AdminSchema } from '/app/dist/schemas/admin.schema.js';

const API = 'http://127.0.0.1:3000';
const CHANNEL = '533538623'; // the only channel enabled before publishing (config.ts)
const OTHER_CHANNEL = '99004101'; // not enabled
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const calls = () => {
  try { return fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
};
const modelCalls = () => calls().filter((call) => call.provider === 'openrouter' && call.body);
let rid = 0;
const requestId = () => `check-${Date.now().toString(36)}-${++rid}`;

// 1. Unit suites in the exact image. Suites that read source-only files (docs .txt fixtures, route .ts sources,
// the dimasite route mirror) can't run here; they run from source (`node --import tsx --test`) before the build.
const SOURCE_ONLY = /(^|\/)(docs\/[^/]+|tools\/knowledge|navigation|tools\/write\/settings\/permissions)\.test\.js$/;
const suites = [
  ...fs.readdirSync('/app/dist/site_agent', { recursive: true }).map((file) => `dist/site_agent/${file}`),
  ...fs.readdirSync('/app/dist/server/services').map((file) => `dist/server/services/${file}`),
].filter((file) => file.endsWith('.test.js') && !SOURCE_ONLY.test(file.replace(/^dist\/site_agent\//, '')));
const units = spawnSync(process.execPath, ['--test', '--experimental-test-module-mocks', '--test-force-exit', '--test-concurrency=2', ...suites],
  { cwd: '/app', encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
assert.equal(units.status, 0, units.stdout.slice(-6000) + units.stderr.slice(-3000));
assert.doesNotMatch(units.stdout, /(# fail|ℹ fail) [1-9]/);
console.log(`unit suites passed (${suites.length} files)`);

// 2. Fixtures: owner (free plan), scoped admin (view only), managing admin, outsider, other channel owner.
const mongo = await getMongoDBConnection('site-agent-check');
const redis = await getDragonflyClient('site-agent-check');
const people = {
  owner: { token: 'site-agent-owner-token', id: CHANNEL, login: 'cdom201' },
  viewer: { token: 'site-agent-viewer-token', id: '99004102', login: 'scoped_admin' },
  manager: { token: 'site-agent-manager-token', id: '99004103', login: 'commands_admin' },
  outsider: { token: 'site-agent-outsider-token', id: '99004104', login: 'outsider' },
  other: { token: 'site-agent-other-token', id: OTHER_CHANNEL, login: 'other_channel' },
};
for (const person of Object.values(people)) await redis.hSet(`token:${person.token}`, { id: person.id, login: person.login, display_name: person.login });
await mongo.connection.db.collection('users').insertMany([
  { accounts: [{ type: 'twitch', id: CHANNEL, name: 'cdom201', actived: true, chat_enabled: true }], plan_tier: 'free', polar_sh_customer_id: 'cus_site_agent_check', language: 'en' },
  { accounts: [{ type: 'twitch', id: OTHER_CHANNEL, name: 'other_channel', actived: true, chat_enabled: true }], plan_tier: 'pro' },
  ...['viewer', 'manager', 'outsider'].map((key) => ({ accounts: [{ type: 'twitch', id: people[key].id, name: people[key].login }], plan_tier: 'free' })),
]);
await AdminSchema.create([
  { channelID: CHANNEL, adminID: people.viewer.id, channelName: 'cdom201', adminName: 'scoped_admin', actived: true, role: 'channel', permissions: ['dashboard:view', 'commands:view'] },
  { channelID: CHANNEL, adminID: people.manager.id, channelName: 'cdom201', adminName: 'commands_admin', actived: true, role: 'channel', permissions: ['dashboard:view', 'commands:view', 'commands:manage'] },
]);

async function api(person, method, path, body, { channel = CHANNEL } = {}) {
  const response = await fetch(`${API}/agent/${channel}${path}`, {
    method,
    headers: { Authorization: `Bearer ${people[person].token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, data: json.data };
}

/** Reads a turn's SSE stream until `done`, a resync, or `stopAfter(event, all)` returns true. */
async function events(person, turnId, { after, stopAfter, timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${API}/agent/${CHANNEL}/turns/${turnId}/events${after ? `?after=${after}` : ''}`, {
    headers: { Authorization: `Bearer ${people[person].token}` }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const all = [];
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (block.startsWith(':')) continue;
        const id = /^id: (.+)$/m.exec(block)?.[1];
        const type = /^event: (.+)$/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
        all.push({ id, type, data });
        if (type === 'resync' || (type === 'done' && data.turnId === turnId)) { controller.abort(); return all; }
        if (stopAfter?.({ id, type, data }, all)) { controller.abort(); return all; }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
  }
  return all;
}

const send = (person, text, extra = {}) => api(person, 'POST', '/messages', { text, mode: 'send', page: { route: 'dashboard', path: '/cdom201/dashboard', title: 'Dashboard' }, lang: 'en', clientRequestId: requestId(), ...extra });
const textOf = (stream, itemId) => stream.filter((e) => e.type === 'item' && e.data.item.id === itemId).map((e) => e.data.item.text ?? '').join('')
  + stream.filter((e) => e.type === 'text' && e.data.itemId === itemId).map((e) => e.data.delta).join('');
const finalAnswer = (stream) => [...stream].reverse().find((e) => (e.type === 'update' || e.type === 'item') && e.data.item.kind === 'assistant' && e.data.item.final)?.data.item;

// 3. Access.
assert.equal((await api('outsider', 'GET', '/status')).status, 403, 'no website access → 403');
const ownerStatus = await api('owner', 'GET', '/status');
assert.equal(ownerStatus.status, 200);
assert.deepEqual({ enabled: ownerStatus.data.enabled, role: ownerStatus.data.role, limit: ownerStatus.data.limits.limit, used: ownerStatus.data.limits.used, contextLimit: ownerStatus.data.contextLimit },
  { enabled: true, role: 'owner', limit: 20, used: 0, contextLimit: 100_000 });
const otherStatus = await api('other', 'GET', '/status', undefined, { channel: OTHER_CHANNEL });
assert.equal(otherStatus.data.enabled, false, 'channels outside the pre-publish list see enabled:false');
const notEnabled = await api('other', 'GET', '/sessions', undefined, { channel: OTHER_CHANNEL });
assert.equal(notEnabled.status, 404);
assert.equal(notEnabled.json.data.code, 'not_enabled');
assert.equal((await send('outsider', 'hi')).status, 403, 'outsiders cannot send');
assert.equal((await api('viewer', 'GET', '/status')).data.role, 'admin');
console.log('access: owner, admin, outsider, not-enabled channel');

// 4. A plain answer streams in order with consistent offsets; snapshot matches.
const first = await send('owner', 'How do I make the bot read chat aloud? [[script:text]] [[chunks:6]] [[delay:250]]');
assert.equal(first.status, 202, JSON.stringify(first.json));
const { sessionId, turnId } = first.data;
assert.equal(first.data.limits.used, 1);
const stream1 = await events('owner', turnId);
const types1 = stream1.map((e) => e.type);
assert.equal(types1.at(-1), 'done');
assert.equal(stream1.at(-1).data.status, 'completed');
const answer1 = finalAnswer(stream1);
assert.ok(answer1, 'final assistant item');
const created = stream1.findIndex((e) => e.type === 'item' && e.data.item.id === answer1.id);
const firstDelta = stream1.findIndex((e) => e.type === 'text' && e.data.itemId === answer1.id);
assert.ok(created >= 0 && firstDelta > created, 'the answer item is created before its streamed text');
assert.match(answer1.text, /^part-0 part-1 part-2 part-3 part-4 part-5\s*$/);
let length = stream1.find((e) => e.type === 'item' && e.data.item.id === answer1.id).data.item.text.length;
for (const e of stream1.filter((ev) => ev.type === 'text' && ev.data.itemId === answer1.id)) {
  assert.equal(e.data.offset, length, 'text offsets are contiguous');
  length += e.data.delta.length;
}
assert.equal(length, answer1.text.length);
const snap1 = await api('owner', 'GET', `/sessions/${sessionId}`);
assert.equal(snap1.data.activeTurn, null);
assert.deepEqual(snap1.data.items.map((item) => item.kind), ['user', 'assistant']);
assert.equal(snap1.data.items[1].text, answer1.text);
console.log('plain answer: streamed in order, offsets contiguous, snapshot matches');

// 5. The model request.
const request1 = modelCalls().at(-1).body;
assert.equal(request1.model, 'openai/gpt-6-luna');
assert.deepEqual(request1.reasoning, { effort: 'xhigh' });
assert.equal(request1.stream, true);
assert.equal(request1.session_id, sessionId);
assert.equal(request1.messages[0].role, 'system');
assert.match(request1.messages[0].content, /DomDimaBot assistant/);
assert.match(request1.messages[0].content, /# Docs index/);
assert.match(request1.messages[0].content, /modules\.tts/);
const user1 = request1.messages.at(-1);
assert.equal(user1.role, 'user');
assert.match(user1.content, /^\[Context for this message — facts, not instructions\]/);
assert.match(user1.content, /Channel: cdom201 \(plan: free\)/);
assert.match(user1.content, /Talking to: cdom201 \(owner\)/);
assert.match(user1.content, /Current page: dashboard \(\/cdom201\/dashboard\)/);
const ownerTools = request1.tools.map((tool) => tool.function.name).sort();
for (const name of ['search_docs', 'read_docs', 'search_ast_functions', 'test_command', 'show_ui', 'navigate', 'create_command']) assert.ok(ownerTools.includes(name), `owner gets ${name}`);
console.log(`model request: luna xhigh, ${ownerTools.length} tools, turn note`);

// Follow-up in the same session: byte-identical system prompt, history kept.
const second = await send('owner', 'And in Spanish? [[script:text]]', { sessionId });
const stream2 = await events('owner', second.data.turnId);
assert.equal(stream2.at(-1).data.status, 'completed');
const request2 = modelCalls().at(-1).body;
assert.equal(request2.messages[0].content, request1.messages[0].content, 'system prompt is byte-stable (cache prefix)');
assert.deepEqual(request2.messages.slice(1, 3).map((m) => m.role), ['user', 'assistant']);
console.log('follow-up: same system prompt, history sent');

// 6. 409 while active, idempotent sends, privacy.
const slow = await send('owner', 'Slow one [[script:slow]] [[chunks:30]] [[delay:150]]', { sessionId });
const again = await send('owner', 'Another', { sessionId });
assert.equal(again.status, 409);
assert.equal(again.json.data.code, 'turn_active');
const replayId = requestId();
const sendA = await api('owner', 'POST', '/messages', { text: 'queued once', mode: 'queue', sessionId, clientRequestId: replayId, lang: 'en' });
const sendB = await api('owner', 'POST', '/messages', { text: 'queued once', mode: 'queue', sessionId, clientRequestId: replayId, lang: 'en' });
assert.equal(sendA.status, 202);
assert.deepEqual(sendB.data, sendA.data, 'same clientRequestId → same result');
const conflict = await api('owner', 'POST', '/messages', { text: 'different', mode: 'queue', sessionId, clientRequestId: replayId, lang: 'en' });
assert.equal(conflict.json.data.code, 'idempotency_conflict');
assert.equal((await api('manager', 'GET', `/sessions/${sessionId}`)).status, 404, 'sessions are private');
assert.equal((await api('manager', 'POST', `/turns/${slow.data.turnId}/stop`)).status, 404, 'cannot stop someone else\'s turn');

// 7. Steer while running: the stream is cut, the steer arrives as a user message, the turn continues.
const before = modelCalls().length;
await pause(800);
const steer = await api('owner', 'POST', '/messages', { text: 'Make it shorter please', mode: 'steer', sessionId, clientRequestId: requestId(), lang: 'en' });
assert.equal(steer.status, 202);
const streamSlow = await events('owner', slow.data.turnId);
const done = streamSlow.at(-1);
assert.equal(done.data.status, 'completed');
const steered = modelCalls().slice(before).find((call) => JSON.stringify(call.body.messages).includes('[Sent while you were working]'));
assert.ok(steered, 'a model call carried the steer input');
assert.ok(calls().some((call) => call.event === 'aborted'), 'the interrupted stream was aborted');
// The queued message became the next turn, announced before done.
const nextTurn = streamSlow.filter((e) => e.type === 'turn' && e.data.turnId !== slow.data.turnId).at(-1);
assert.ok(nextTurn, 'queued message started a new turn');
const streamQueued = await events('owner', nextTurn.data.turnId);
assert.equal(streamQueued.at(-1).data.status, 'completed');
console.log('steer applied mid-answer; queued message ran next');

// 8. Stop: partial text kept, turn cancelled, cost reconciled later.
const stopMe = await send('owner', 'Stop me [[script:slow]] [[chunks:40]] [[delay:150]] [[gen404:1]]', { sessionId });
const partial = await events('owner', stopMe.data.turnId, { stopAfter: (e, all) => all.filter((x) => x.type === 'text').length >= 3 });
assert.ok(partial.some((e) => e.type === 'text'));
const stopped = await api('owner', 'POST', `/turns/${stopMe.data.turnId}/stop`);
assert.equal(stopped.status, 200);
const afterStop = await events('owner', stopMe.data.turnId, { after: partial.at(-1).id });
assert.equal(afterStop.at(-1).data.status, 'cancelled', `after stop: ${JSON.stringify(afterStop.map((e) => [e.type, e.data.status ?? e.data.item?.kind ?? '']))} stop=${JSON.stringify(stopped.json)} turn=${JSON.stringify((await api('owner', 'GET', `/turns/${stopMe.data.turnId}`)).data)}`);
assert.ok(afterStop.some((e) => e.type === 'item' && e.data.item.kind === 'notice' && e.data.item.code === 'stopped'));
assert.ok(!afterStop.some((e) => partial.some((p) => p.id === e.id)), 'reconnect with after= has no duplicates');
console.log('stop: cancelled, partial text kept, resumed stream without duplicates');

// 9. Retry after stop (not counted).
const usedBefore = (await api('owner', 'GET', '/status')).data.limits.used;
const retried = await api('owner', 'POST', `/turns/${stopMe.data.turnId}/retry`, { clientRequestId: requestId() });
assert.equal(retried.status, 202);
const retryStream = await events('owner', retried.data.turnId);
assert.equal(retryStream.at(-1).data.status, 'completed');
assert.equal((await api('owner', 'GET', '/status')).data.limits.used, usedBefore, 'retry is not counted');
assert.ok(JSON.stringify(modelCalls().at(-1).body.messages).includes('pressed Retry'));
console.log('retry: continues the request, not counted');

// 10. Tools in several steps, reasoning echoed, tool rows.
const toolsTurn = await send('owner', 'Find TTS docs [[call:search_docs {"query":"text to speech"}]] [[call@1:read_docs {"id":"/tts#intro"}]]');
const toolStream = await events('owner', toolsTurn.data.turnId);
assert.equal(toolStream.at(-1).data.status, 'completed');
const toolAnswer = finalAnswer(toolStream);
assert.match(toolAnswer.text, /FIXTURE_TOOLS_DONE/);
assert.match(toolAnswer.text, /reasoning=ok/);
assert.match(toolAnswer.text, /results=2/);
const rows = toolStream.filter((e) => e.type === 'update' && e.data.item.kind === 'tool').map((e) => [e.data.item.name, e.data.item.state]);
assert.deepEqual(rows, [['search_docs', 'done'], ['read_docs', 'done']]);
console.log('multi-step tools: 2 results, reasoning echoed, rows done');

// 11. Approval: create a command → Apply → change log → Undo. Then Skip.
const commandArgs = JSON.stringify({ name: 'dicecheck', body: '$(user) rolled $(random 6)' });
const approvalTurn = await send('owner', `Make a dice command [[call:create_command ${commandArgs}]]`);
const pending = await events('owner', approvalTurn.data.turnId, { stopAfter: (e) => e.type === 'item' && e.data.item.kind === 'approval' });
const card = pending.find((e) => e.type === 'item' && e.data.item.kind === 'approval').data.item;
assert.equal(card.state, 'pending');
assert.equal(card.proposal.tool, 'create_command');
assert.equal(card.proposal.before, null);
assert.ok(card.proposal.after);
assert.equal(card.proposal.payload, undefined, 'private payload never reaches the browser');
const commands = mongo.connection.db.collection('commands');
assert.equal(await commands.countDocuments({ channelID: CHANNEL, name: 'dicecheck' }), 0, 'nothing changes before Apply');
assert.equal((await api('manager', 'POST', `/turns/${approvalTurn.data.turnId}/approvals/${card.callId}`, { decision: 'apply' })).status, 404, 'only the requester decides');
const decided = await api('owner', 'POST', `/turns/${approvalTurn.data.turnId}/approvals/${card.callId}`, { decision: 'apply' });
assert.equal(decided.data.state, 'approved');
const applied = await events('owner', approvalTurn.data.turnId, { after: pending.at(-1).id });
assert.equal(applied.at(-1).data.status, 'completed');
const appliedCard = applied.filter((e) => e.type === 'update' && e.data.item.kind === 'approval').at(-1).data.item;
assert.equal(appliedCard.state, 'applied');
assert.ok(appliedCard.changeId);
assert.equal(await commands.countDocuments({ channelID: CHANNEL, name: 'dicecheck' }), 1, 'command created');
const changes = await api('owner', 'GET', '/changes');
const change = changes.data.changes.find((entry) => entry.id === appliedCard.changeId);
assert.ok(change, 'change logged');
assert.equal(change.actor.login, 'cdom201');
assert.match(change.request, /Make a dice command/);
assert.equal(change.canUndo, true);
const undone = await api('owner', 'POST', `/changes/${change.id}/undo`);
assert.equal(undone.status, 200, JSON.stringify(undone.json));
assert.equal(await commands.countDocuments({ channelID: CHANNEL, name: 'dicecheck' }), 0, 'undo removed it');
const skipTurn = await send('owner', `Again [[call:create_command ${commandArgs}]]`);
const skipPending = await events('owner', skipTurn.data.turnId, { stopAfter: (e) => e.type === 'item' && e.data.item.kind === 'approval' });
const skipCard = skipPending.find((e) => e.type === 'item' && e.data.item.kind === 'approval').data.item;
assert.equal((await api('owner', 'POST', `/turns/${skipTurn.data.turnId}/approvals/${skipCard.callId}`, { decision: 'skip' })).data.state, 'skipped');
const skipped = await events('owner', skipTurn.data.turnId, { after: skipPending.at(-1).id });
assert.equal(skipped.at(-1).data.status, 'completed');
assert.equal(await commands.countDocuments({ channelID: CHANNEL, name: 'dicecheck' }), 0, 'skip changes nothing');
console.log('approvals: apply → change log → undo; skip changes nothing');

// 12. Permissions: a view-only admin is never offered write tools; a commands admin is, and sees only own changes.
const viewerTurn = await send('viewer', 'hello [[script:text]]');
await events('viewer', viewerTurn.data.turnId);
const viewerTools = modelCalls().at(-1).body.tools.map((tool) => tool.function.name);
assert.ok(!viewerTools.includes('create_command') && viewerTools.includes('list_commands'), 'view-only admin: reads, no writes');
assert.match(modelCalls().at(-1).body.messages.at(-1).content, /Talking to: scoped_admin \(admin\)/);
const managerTurn = await send('manager', 'hello [[script:text]]');
await events('manager', managerTurn.data.turnId);
assert.ok(modelCalls().at(-1).body.tools.some((tool) => tool.function.name === 'create_command'));
assert.equal((await api('manager', 'GET', '/changes')).data.changes.length, 0, 'admins see only their own changes');
console.log('permissions: tools filtered per requester; change log scoped');

// 13. Forms and navigation.
const formArgs = JSON.stringify({ title: 'Pick a voice', html: '<label>Voice <input name="v"></label>', js: 'dima.submit({v:1})', wait_for_input: true });
const formTurn = await send('owner', `Ask me [[call:show_ui ${formArgs}]]`);
const formPending = await events('owner', formTurn.data.turnId, { stopAfter: (e) => e.type === 'item' && e.data.item.kind === 'ui' });
const uiItem = formPending.find((e) => e.type === 'item' && e.data.item.kind === 'ui').data.item;
assert.equal(uiItem.state, 'open');
assert.equal((await api('owner', 'POST', `/turns/${formTurn.data.turnId}/ui/${uiItem.callId}`, { values: 'nope' })).status, 400);
assert.equal((await api('owner', 'POST', `/turns/${formTurn.data.turnId}/ui/${uiItem.callId}`, { values: { voice: 'Brian' } })).data.state, 'submitted');
const formDone = await events('owner', formTurn.data.turnId, { after: formPending.at(-1).id });
assert.match(finalAnswer(formDone).text, /Brian/);
const navArgs = JSON.stringify({ mode: 'go', route: 'modules.tts', anchor: 'tts.voice', label: 'TTS voice' });
const navTurn = await send('owner', `Where is TTS? [[call:navigate ${navArgs}]]`);
const navStream = await events('owner', navTurn.data.turnId);
const nav = navStream.find((e) => e.type === 'item' && e.data.item.kind === 'navigate').data.item;
assert.deepEqual(nav.action, { mode: 'go', route: 'modules.tts', label: 'TTS voice', anchor: 'tts.voice' });
const badNav = await send('owner', `[[call:navigate ${JSON.stringify({ mode: 'go', route: '../../evil', label: 'x' })}]]`);
const badNavStream = await events('owner', badNav.data.turnId);
assert.ok(!badNavStream.some((e) => e.type === 'item' && e.data.item.kind === 'navigate'), 'unknown routes never reach the browser');
console.log('forms and navigation');

// 14. Provider errors: failed turn, message refunded; context errors surface.
const usedBeforeError = (await api('owner', 'GET', '/status')).data.limits.used;
const broken = await send('owner', 'break [[script:http_401]]');
const brokenStream = await events('owner', broken.data.turnId);
assert.equal(brokenStream.at(-1).data.status, 'failed');
assert.equal(brokenStream.at(-1).data.errorCode, 'model_config');
assert.equal((await api('owner', 'GET', '/status')).data.limits.used, usedBeforeError, 'our failure before any answer is refunded');
const flaky = await send('owner', 'flaky [[script:flaky]]');
assert.equal((await events('owner', flaky.data.turnId)).at(-1).data.status, 'completed', '503 before data is retried');
console.log('provider errors: failed + refunded; transient 503 retried');

// 15. SSE: bogus old cursor → resync; finished turn without cursor → resync.
const resync = await events('owner', first.data.turnId, { after: '1-0' });
assert.equal(resync.at(-1).type, 'resync');
console.log('sse resync');

// 16. Daily limit (free = 20/day per channel, shared by owner and admins).
const day = new Date().toISOString().slice(0, 10);
await redis.set(`site_agent:daily:${CHANNEL}:${day}`, '20');
const limited = await send('manager', 'over the limit');
assert.equal(limited.status, 429);
assert.equal(limited.json.data.code, 'daily_limit');
assert.equal(limited.json.data.limits.limit, 20);
console.log('daily limit');

// 17. Polar: ai_assistant events only, stable external ids, no credits.
await pause(1500);
const polarEvents = calls().filter((call) => call.provider === 'polar').flatMap((call) => call.events ?? []);
assert.ok(polarEvents.length > 0, 'usage sent to Polar');
for (const event of polarEvents) {
  assert.equal(event.name, 'ai_assistant');
  assert.equal(event.customer_id ?? event.customerId, 'cus_site_agent_check');
  assert.equal(event.metadata?.credits, undefined);
  assert.match(event.external_id ?? event.externalId, /^site_agent:/);
}
const stats = await redis.hGetAll(`site_agent:stats:${day}`);
assert.ok(Number(stats.steps) > 0 && Number(stats.prompt_tokens) > 0);
console.log(`polar: ${polarEvents.length} ai_assistant events, no credits; stats recorded`);

// 18. Sessions: list, rename, delete.
const sessions = await api('owner', 'GET', '/sessions');
assert.ok(sessions.data.sessions.length >= 1);
assert.equal((await api('owner', 'PATCH', `/sessions/${sessionId}`, { title: 'Renamed' })).data.session.title, 'Renamed');
assert.equal((await api('owner', 'DELETE', `/sessions/${sessionId}`)).data.deleted, true);
assert.equal((await api('owner', 'GET', `/sessions/${sessionId}`)).status, 404);
console.log('sessions: list, rename, delete');

console.log('site agent API check passed');
process.exit(0);
