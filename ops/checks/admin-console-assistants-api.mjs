// API target only: saas-ops verify api-<id> --dependency mongo --dependency redis \
//   --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-assistants-api.mjs
// The owner's assistants API (`/admin-site/assistant/{summary,turns,turns/:id}`, `/admin-site/docs-assistant/{summary,answers}`):
// owner-only access, strict input, every breakdown against hand-computed fixtures, filters and sorts, failed docs
// questions listed with their reason, expired docs ids trimmed. Dima assistant text: the list gives only a
// 300-character question; the detail gives the whole exchange (message, steers, answer from the chat, tool arguments
// and results), clipped at the documented limits by code points; and what must never be stored (page titles,
// proposal payloads, undo data, form values, approval errors, carrying `SECRET-` markers) is in no response and
// not even in Mongo.
// APP_DIST / ASSISTANTS_FIXTURES / ASSISTANTS_API override the compiled app, fixtures folder and API base for a local run.
import assert from 'node:assert/strict';
const APP_DIST = process.env.APP_DIST || '/app/dist';
const FIXTURES = process.env.ASSISTANTS_FIXTURES || '/tmp/saas-fixtures';
const BASE = process.env.ASSISTANTS_API || 'http://127.0.0.1:3000';
const { getMongoDBConnection } = await import(`${APP_DIST}/utils/databases/mongodb.database.js`);
const { getDragonflyClient } = await import(`${APP_DIST}/utils/databases/dragonfly.database.js`);
const { seedAssistants, ASSISTANT_CHANNELS: C, ASSISTANT_EDITOR, DOCS_IDS, TURN_IDS: T, LONG, JWT } = await import(`${FIXTURES}/seed-assistants.mjs`);

const mongo = await getMongoDBConnection('admin-console-assistants-check');
const redis = await getDragonflyClient('admin-console-assistants-check');
const db = mongo.connection.db;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch { /* not listening yet */ } await sleep(200); } throw new Error(`Timeout: ${label}`); }

await redis.hSet('token:assistants-owner', { id: '533538623', login: 'cdom201', display_name: 'CDOM201' });
await redis.hSet('token:assistants-streamer', { id: '700000001', login: 'some_streamer', display_name: 'Some Streamer' });
const now = new Date();
const seed = await seedAssistants({ db, redis, dist: APP_DIST, now });
const E = seed.expected;
const exact = await db.collection('site_agent_turn_logs').countDocuments({ channelId: { $nin: [C.alpha.id, C.beta.id] } }) === 0;

const get = (path, token = 'assistants-owner') => fetch(`${BASE}/admin-site/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const read = async (path) => {
    const res = await get(path);
    const text = await res.text();
    assert.equal(res.status, 200, `${path}: ${text.slice(0, 200)}`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    for (const secret of ['SECRET', 'someone@example.com', 'me@visitor.test', JWT.split('.')[2], 'FORMVALUE', 'tracking123', 'sess-', 'expiresAt', 'reasoningTokens', 'unknownCostSteps', 'modelCosts']) {
        assert.equal(text.includes(secret), false, `${path} leaks ${secret}`);
    }
    const body = JSON.parse(text);
    assert.equal(body.error, false);
    return body.data;
};
const iso = date => encodeURIComponent(date.toISOString());
const keys = value => Object.keys(value).sort();
/** First `max` code points, as the writer clips. */
const clip = (text, max) => Array.from(text).slice(0, max).join('');
const sorted = list => [...list].sort();

await until(async () => (await get('assistant/summary')).status === 200, 'API ready');

// ---- Access and input ----
const paths = ['assistant/summary', 'assistant/turns', `assistant/turns/${T.t1}`, 'docs-assistant/summary', 'docs-assistant/answers'];
for (const path of paths) {
    assert.equal((await get(path, null)).status, 401, `${path} without a token`);
    assert.equal((await get(path, 'assistants-streamer')).status, 403, `${path} for a streamer`);
}
const old = new Date(now.getTime() - 121 * 86_400_000);
const bad = {
    'assistant/summary': ['channel[$ne]=1', 'channel=a.b', 'from=yesterday', `from=${iso(old)}&to=${iso(now)}`, `from=${iso(now)}&to=${iso(new Date(now.getTime() - 1000))}`, 'to[$gt]=1'],
    'assistant/turns': ['status=failed', 'status[$ne]=x', 'level=pro', 'sort=price', 'user=abc', 'user[$ne]=1', 'page=0', 'page=abc', 'limit=51', 'limit=0',
        `from=${iso(new Date(now.getTime() - 91 * 86_400_000))}&to=${iso(now)}`, 'channel=1&channel=2'],
    'docs-assistant/summary': [`from=${iso(old)}&to=${iso(now)}`, 'from=2026-13-01'],
    'docs-assistant/answers': ['lang=fr', 'lang[$ne]=en', 'feedback=yes', 'sort=oldest', 'limit=51', 'page=-1'],
};
for (const [path, queries] of Object.entries(bad)) {
    for (const q of queries) {
        const res = await get(`${path}?${q}`);
        assert.equal(res.status, 400, `${path}?${q}`);
        assert.equal((await res.json()).error, true);
    }
}
assert.equal((await get('assistant/turns?channel=nobody_here')).status, 404, 'unknown channel login');
for (const id of ['abc', T.t1.toUpperCase(), `${T.t1}0`, '%24ne', `${T.t1.slice(0, -1)}g`]) {
    assert.equal((await get(`assistant/turns/${id}`)).status, 400, `detail id ${id}`);
}
assert.equal((await get(`assistant/turns/${T.missing}`)).status, 404, 'unknown turn');

// ---- Dima assistant summary ----
const summary = await read('assistant/summary');
assert.deepEqual(keys(summary), sorted(['byChannel', 'byLevel', 'byModel', 'byTool', 'daily', 'errors', 'from', 'limitsToday', 'recordsSince', 'refusals', 'to', 'totals']));
assert.equal(summary.daily.length, 31, '30 days back, both ends included');
assert.deepEqual(keys(summary.daily[0]), sorted(['cachedTokens', 'cancelled', 'completed', 'completionTokens', 'date', 'failed', 'helpful', 'promptTokens', 'providerUSD', 'steps', 'toolCalls', 'turns', 'unhelpful']));
const todayRow = summary.daily.find(row => row.date === seed.today);
const yesterdayRow = summary.daily.find(row => row.date === seed.yesterday);
assert.deepEqual(todayRow, { date: seed.today, turns: 3, completed: 1, failed: 1, cancelled: 1, steps: 5, toolCalls: 4, promptTokens: 1700, cachedTokens: 800, completionTokens: 130,
    providerUSD: 0.0135, helpful: 1, unhelpful: 0 });
assert.equal(yesterdayRow.failed, 1, 'interrupted counts as failed');
assert.equal(summary.daily.filter(row => row.turns === 0).length, 29, 'zeros filled');
assert.deepEqual(summary.daily.map(row => row.date), [...summary.daily.map(row => row.date)].sort(), 'oldest first');
assert.equal(summary.totals.turns, 4);
assert.equal(summary.totals.providerUSD, 0.0335);
assert.deepEqual(summary.refusals, { week: 0, total: 0 });
if (exact) {
    assert.equal(summary.totals.channels, E.channels);
    assert.equal(summary.totals.people, E.people);
    assert.deepEqual(summary.byLevel, E.byLevel);
    assert.deepEqual(summary.byModel, E.byModel);
    assert.deepEqual(summary.byChannel, E.byChannel);
    assert.deepEqual(summary.byTool, E.byTool);
    assert.deepEqual(summary.errors, E.errors);
    assert.deepEqual(summary.limitsToday, E.limitsToday);
    assert.equal(summary.recordsSince, E.recordsSince);
}
const alphaOnly = await read(`assistant/summary?channel=${C.alpha.id}`);
assert.deepEqual(alphaOnly.byChannel, [E.byChannel[0]]);
assert.deepEqual(alphaOnly.limitsToday, [E.limitsToday[1]]);
assert.deepEqual(alphaOnly.daily, summary.daily, 'daily stays global with a channel');
assert.equal(alphaOnly.totals.channels, 1);
assert.deepEqual((await read(`assistant/summary?channel=${C.beta.login}`)).byChannel, [E.byChannel[1]], 'by login too');

// ---- Dima assistant turns ----
const turns = await read('assistant/turns');
assert.deepEqual(keys(turns.pagination), sorted(['limit', 'page', 'total', 'totalPages']));
const mine = turns.rows.filter(row => [C.alpha.id, C.beta.id].includes(row.channelID));
assert.deepEqual(mine.map(row => row.id), E.defaultTurns, 'newest first, the 40-day-old turn outside the default window');
// The list stays small: a question preview, no full text.
const listText = JSON.stringify(turns);
for (const text of ['TEXT-STEER', 'TEXT-ARGS', 'TEXT-RESULT', 'TEXT-ANSWER', 'TEXT-INVENTED', LONG.message.slice(0, 301)]) assert.equal(listText.includes(text), false, `list carries ${text.slice(0, 20)}`);
for (const row of turns.rows) {
    for (const field of ['message', 'steers', 'answer']) assert.equal(field in row, false, `list row has ${field}`);
    for (const tool of row.tools) assert.deepEqual(keys(tool), ['approval', 'ms', 'name', 'state']);
}
const t1 = mine[0];
assert.deepEqual(keys(t1), sorted(['activeMs', 'at', 'cachedTokens', 'channel', 'channelID', 'completionTokens', 'durationMs', 'errorCode', 'fellBack', 'feedback', 'id', 'lang', 'level',
    'models', 'pageRoute', 'plan', 'promptTokens', 'providerUSD', 'question', 'status', 'steps', 'textKept', 'tools', 'units', 'user']));
assert.equal(mine[1].question, 'TEXT-MESSAGE what can you do');
assert.deepEqual(t1, {
    id: T.t1, at: new Date(now.getTime() - 3_600_000).toISOString(), channelID: C.alpha.id, channel: C.alpha.login,
    user: { id: C.alpha.id, login: C.alpha.login, name: C.alpha.login.toUpperCase(), role: 'owner' }, plan: 'pro', level: 'expert', fellBack: false,
    models: ['anthropic/claude-haiku-5.5'], status: 'completed', errorCode: null, lang: 'en', pageRoute: 'modules.tts', question: LONG.message.slice(0, 300), steps: 3,
    tools: [{ name: 'search_docs', state: 'done', ms: 250, approval: null }, { name: 'create_command', state: 'done', ms: null, approval: 'applied' }],
    units: 2, promptTokens: 1000, cachedTokens: 800, completionTokens: 100, providerUSD: 0.01, durationMs: 9000, activeMs: 8100, feedback: 'helpful', textKept: true,
});
const t2 = mine[1];
assert.equal(t2.errorCode, 'model_overloaded');
assert.equal(t2.units, 0, 'refunded: our failure before any answer');
assert.equal(t2.providerUSD, 0.0025, 'reconciled step added');
assert.equal(t2.promptTokens, 500);
assert.equal(t2.user.role, 'admin');
assert.deepEqual(mine[2].tools.map(tool => tool.name), ['read_docs', 'unknown_tool', 'get_command', 'recent_chat', 'show_ui'], 'invented tool names are hidden');
assert.equal(mine[2].feedback, 'unhelpful', 'rated before its row was written');
assert.deepEqual(mine[3].models, ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna'], 'a fell-back turn ran both');
assert.equal(mine[3].fellBack, true);
assert.equal(mine[3].units, 4);

const ids = async q => (await read(`assistant/turns?${q}`)).rows.filter(row => [C.alpha.id, C.beta.id].includes(row.channelID)).map(row => row.id);
assert.deepEqual(await ids('status=problems'), [T.t2, T.t4]);
assert.deepEqual(await ids('status=cancelled'), [T.t3]);
assert.deepEqual(await ids('status=completed&level=expert'), [T.t1]);
assert.deepEqual(await ids(`user=${ASSISTANT_EDITOR.id}`), [T.t2]);
assert.deepEqual(await ids(`channel=${C.beta.id}`), [T.t3, T.t4]);
assert.deepEqual(await ids(`channel=${C.alpha.login}&from=${iso(new Date(now.getTime() - 60 * 86_400_000))}`), [T.t1, T.t2, T.t5]);
// Older than 3 days: the text is gone, the numbers stay.
const cleared = (await read(`assistant/turns?channel=${C.alpha.id}&from=${iso(new Date(now.getTime() - 60 * 86_400_000))}`)).rows.find(row => row.id === T.t5);
assert.equal(cleared.question, null);
assert.equal(cleared.textKept, false);
assert.equal(cleared.providerUSD, 0.5);
assert.deepEqual(cleared.tools, [{ name: 'read_docs', state: 'done', ms: 200, approval: null }]);
const clearedDetail = await read(`assistant/turns/${T.t5}`);
assert.equal(clearedDetail.message, null);
assert.equal(clearedDetail.answer, null);
assert.deepEqual(clearedDetail.steers, []);
assert.deepEqual(clearedDetail.tools, [{ name: 'read_docs', state: 'done', ms: 200, approval: null, args: null, result: null }]);
assert.equal(clearedDetail.textKept, false);
assert.equal((await read(`assistant/turns/${T.t1}`)).textKept, true);
assert.deepEqual(await ids(`channel=${C.alpha.id}&sort=cost&from=${iso(new Date(now.getTime() - 60 * 86_400_000))}`), [T.t5, T.t1, T.t2]);
assert.deepEqual(await ids(`channel=${C.beta.id}&sort=slowest`), [T.t4, T.t3]);
const paged = await read(`assistant/turns?channel=${C.beta.id}&limit=1&page=2`);
assert.deepEqual(paged.rows.map(row => row.id), [T.t4]);
assert.deepEqual(paged.pagination, { page: 2, limit: 1, total: 2, totalPages: 2 });
assert.equal(await db.collection('site_agent_turn_logs').countDocuments({ _id: T.t1 }), 1, 'finished twice, one row');
// ---- Dima assistant turn detail: the whole exchange, clipped ----
const detail = await read(`assistant/turns/${T.t1}`);
assert.deepEqual(keys(detail), sorted([...keys(t1), 'message', 'steers', 'answer']));
const { tools: detailTools, message, steers, answer, ...detailRest } = detail;
const { tools: _listTools, ...listRest } = t1;
assert.deepEqual(detailRest, listRest, 'same metadata as the list row');
assert.equal(message, LONG.message.slice(0, 4_000));
assert.deepEqual(steers, LONG.steers.slice(-10).map(text => clip(text, 2_000)), 'the last 10 steers, oldest first, each clipped');
assert.equal(answer, clip(LONG.answers.join('\n\n'), 12_000), "this turn's assistant items, joined with a blank line, clipped");
assert.deepEqual(detailTools, [
    { name: 'search_docs', state: 'done', ms: 250, approval: null, args: clip(LONG.args, 2_000), result: clip(LONG.result, 2_000) },
    { name: 'create_command', state: 'done', ms: null, approval: 'applied', args: '{"name":"!hi"}', result: 'applied' },
]);
assert.equal(detailTools[0].result.endsWith('😀'), true, 'clipped by code points: the emoji at the limit is whole');
const t2Detail = await read(`assistant/turns/${T.t2}`);
assert.equal(t2Detail.answer, null, 'the chat was gone: no answer');
assert.deepEqual(t2Detail.steers, ['TEXT-STEER more please']);
assert.deepEqual(t2Detail.tools, [{ name: 'read_docs', state: 'error', ms: 800, approval: null, args: '{"query":"TEXT-ARGS search"}', result: 'TEXT-RESULT body' }]);
const t3Detail = await read(`assistant/turns/${T.t3}`);
assert.equal(t3Detail.answer, 'Your session token is [redacted token], keep it safe.', 'the JWT in the answer is masked');
assert.deepEqual(t3Detail.tools[1], { name: 'unknown_tool', state: 'error', ms: 100, approval: null, args: '{"invented":"TEXT-INVENTED-ARGS"}', result: 'TEXT-RESULT body' });
assert.deepEqual(t3Detail.tools.slice(2).map(tool => tool.result), [
    '{"response":"$(urlfetch https://api.example.test/x?key=[redacted]) then https://discord.com/api/webhooks/123456789012345678/[redacted]","headers":"Authorization: [redacted]","accessToken":"[redacted]"}',
    '<untrusted_data>viewer1: write to [email] about the raid</untrusted_data>',
    '[form submitted]',
], 'secrets (by shape and by JSON key), the address and the form values masked; the text around them kept');

// A manager who deleted their account while their turn ran on a channel that still exists: no row.
assert.equal(await db.collection('site_agent_turn_logs').countDocuments({ _id: T.gone }), 0, 'no row for a deleted manager');
assert.equal((await get(`assistant/turns/${T.gone}`)).status, 404);

const stored = JSON.stringify(await db.collection('site_agent_turn_logs').find({ channelId: { $in: [C.alpha.id, C.beta.id] } }).toArray());
for (const never of ['SECRET', 'someone@example.com', 'FORMVALUE']) assert.equal(stored.includes(never), false, `${never} is never stored`);
assert.equal(stored.includes('TEXT-ANSWER first'), true, 'the answer is stored');

// ---- Docs assistant ----
const docs = await read('docs-assistant/summary');
assert.deepEqual(keys(docs), sorted(['byLang', 'daily', 'failures', 'from', 'medianDurationMs', 'to', 'topPages', 'totals']));
assert.equal(docs.daily.length, 31);
const docsToday = docs.daily.find(row => row.date === seed.today);
assert.deepEqual(docsToday, { date: seed.today, asked: E.docs.asked, answered: E.docs.answered, failed: E.docs.failed, abandoned: E.docs.abandoned, toolCalls: 2, inputTokens: 3000,
    outputTokens: 300, providerUSD: 0.015, helpful: 1, unhelpful: 0 });
assert.deepEqual(docs.failures, [{ reason: 'timeout', count: 1 }]);
assert.deepEqual(docs.byLang, E.docs.byLang);
assert.deepEqual(docs.topPages, E.docs.topPages);
assert.equal(docs.medianDurationMs, E.docs.medianDurationMs);
assert.equal(docs.totals.abandoned, 1);

const answers = await read('docs-assistant/answers');
assert.deepEqual(keys(answers.rows[0]), sorted(['answer', 'at', 'durationMs', 'failed', 'feedback', 'id', 'inputTokens', 'lang', 'outputTokens', 'page', 'providerUSD', 'question', 'rounds',
    'sources', 'stopReason', 'tools', 'turn']));
assert.deepEqual(answers.rows.map(row => row.question), ['DOCS-FAILED question from [email] with token=[redacted]', 'DOCS-Q one', 'DOCS-Q two', 'DOCS-Q three'],
    'the failed question is stored scrubbed');
const [failed, one, two] = answers.rows;
assert.equal(failed.answer, '');
assert.equal(failed.stopReason, 'timeout');
assert.equal(failed.failed, 'timeout', 'the failure reason is on the row');
assert.equal(failed.page, '/faq/');
assert.equal(failed.durationMs, 60_000);
const storedFailure = await redis.hGetAll(`docs_assistant:answer:${failed.id}`);
assert.equal(storedFailure.page, '/faq/', 'only the page path is stored');
assert.equal(storedFailure.question, 'DOCS-FAILED question from [email] with token=[redacted]');
const twoRows = await read('docs-assistant/answers?limit=2');
assert.equal(twoRows.rows.length, 2, 'never more rows than the page');
assert.equal(twoRows.pagination.total, 4);
assert.deepEqual(one, { id: DOCS_IDS.one, at: one.at, lang: 'en', page: '/ai-assistants/', turn: 1, question: 'DOCS-Q one', answer: 'DOCS-A one',
    sources: ['https://docs.domdimabot.com/ai-assistants/'], tools: ['search_ast_functions', 'test_command'], rounds: 2, durationMs: 12_000, inputTokens: 1000,
    outputTokens: 100, providerUSD: 0.009, stopReason: 'end_turn', failed: null, feedback: 'helpful' });
assert.equal(two.rounds, null, 'old answers have no rounds');
assert.deepEqual(two.tools, []);
assert.equal(two.turn, 3);
assert.deepEqual(answers.pagination, { page: 1, limit: 20, total: 4, totalPages: 1 });
assert.equal((await redis.lRange('docs_assistant:recent', 0, -1)).includes(DOCS_IDS.expired), false, 'expired ids are trimmed');
assert.deepEqual((await read('docs-assistant/answers?lang=es')).rows.map(row => row.id), [DOCS_IDS.two]);
assert.deepEqual((await read('docs-assistant/answers?feedback=helpful')).rows.map(row => row.id), [DOCS_IDS.one]);
assert.equal((await read('docs-assistant/answers?feedback=none')).rows.length, 3);
assert.deepEqual((await read('docs-assistant/answers?sort=slowest&limit=2')).rows.map(row => row.question), ['DOCS-FAILED question from [email] with token=[redacted]', 'DOCS-Q three']);
assert.deepEqual((await read('docs-assistant/answers?sort=cost&limit=1&page=1')).rows.map(row => row.id), [DOCS_IDS.one]);

// A failed question cannot be rated.
const { recordFeedback } = await import(`${APP_DIST}/utils/ai/docs_assistant/docs_assistant.js`);
assert.equal(await recordFeedback(failed.id, true), false);

console.log(`PASS admin console assistants API: access, input, ${mine.length} turns + detail with clipped text, ${answers.rows.length} docs rows, nothing never-stored leaks${exact ? '' : ' (breakdowns not exact: other turn rows present)'}`);
await Promise.allSettled([mongo.disconnect(), redis.quit()]);
process.exit(0);
