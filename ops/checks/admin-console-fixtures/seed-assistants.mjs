// Disposable data for the admin console assistants API (test databases only).
// `seedAssistants({ db, redis, dist, now })` writes Dima assistant turns through the app's own turn-log writer, from
// full turn records: the exchange carries `TEXT-` markers (message, steers, tool arguments and results, and the
// answer in the chat's display items), which the operator may read; what must never be stored carries `SECRET-`
// markers (page title, proposal payload, undo data, form values, approval errors, row summaries). Plus the day
// counters, today's daily-limit counters, and docs assistant answers and one failed question through the app's own
// recorder. It replaces its own rows and keys, and returns the numbers the API must report.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HAIKU = 'anthropic/claude-haiku-5.5';
const LUNA = 'openai/gpt-6-luna';

export const ASSISTANT_CHANNELS = {
    alpha: { id: '9100000101', login: 'agv_alpha', plan: 'pro' },
    beta: { id: '9100000102', login: 'agv_beta', plan: 'premium' },
};
export const ASSISTANT_EDITOR = { id: '9100000201', login: 'agv_editor', name: 'AGV_Editor' };
/** A manager of alpha whose account was deleted while their turn ran: no row may be written for it. */
export const DELETED_MANAGER = { id: '9100000202', login: 'agv_gone', name: 'AGV_Gone' };
/** Turn ids are UUIDs, like `randomUUID`. */
export const TURN_IDS = {
    t1: '5e1a0000-0000-4000-8000-000000000001',
    t2: '5e1a0000-0000-4000-8000-000000000002',
    t3: '5e1a0000-0000-4000-8000-000000000003',
    t4: '5e1a0000-0000-4000-8000-000000000004',
    t5: '5e1a0000-0000-4000-8000-000000000005',
    missing: '5e1a0000-0000-4000-8000-0000000000ff',
    gone: '5e1a0000-0000-4000-8000-000000000006',
};
/** t1's texts, longer than the documented limits (message 4 000, steers 10 × 2 000, tool text 2 000, answer 12 000). */
export const LONG = {
    message: `TEXT-MESSAGE ${'m'.repeat(4_500)}`,
    steers: Array.from({ length: 12 }, (_, index) => `TEXT-STEER ${index} ${'s'.repeat(2_500)}`),
    args: `{"query":"TEXT-ARGS ${'a'.repeat(3_000)}"}`,
    // Code point 2 000 is an emoji: clipping must keep it whole.
    result: `TEXT-RESULT ${'r'.repeat(1_987)}😀tail`,
    answers: [`TEXT-ANSWER first ${'w'.repeat(7_000)}`, `second ${'w'.repeat(7_000)}`],
};
/** Tool results that hold secrets and someone's address: what the operator sees around them stays readable. */
export const SECRET_RESULTS = {
    command: JSON.stringify({ response: '$(urlfetch https://api.example.test/x?key=SECRETKEY123456) then https://discord.com/api/webhooks/123456789012345678/SECRETHOOKabcdefghijklmnopqrstuvwxyz',
        headers: 'Authorization: Bearer SECRETTOKEN123456', accessToken: 'SECRETplainvalue' }),
    chat: '<untrusted_data>viewer1: write to someone@example.com about the raid</untrusted_data>',
};
export const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
export const DOCS_IDS = {
    one: '0f9a3c1e-0000-4000-8000-000000000001',
    two: '0f9a3c1e-0000-4000-8000-000000000002',
    three: '0f9a3c1e-0000-4000-8000-000000000003',
    expired: '0f9a3c1e-0000-4000-8000-0000000000ff',
};

const day = (at) => new Date(at).toISOString().slice(0, 10);

function turn({ id, channel, message = 'TEXT-MESSAGE what can you do', steers = ['TEXT-STEER more please'], user, role = 'owner', plan, level, status, createdAt, durationMs, steps = 1, answeredSteps = steps, errorCode, fellBack, cost = 1, levelCost = cost,
    countedDay, extraCharged, calls = [], usage }) {
    return {
        id, sessionId: `sess-${id}`, channelId: channel.id, userId: user.id, userLogin: user.login, userDisplayName: user.name ?? user.login, role, plan, lang: 'en',
        page: { route: 'modules.tts', path: `/${channel.login}/modules/tts?SECRET-PATH=1`, title: 'SECRET-TITLE page' },
        status, revision: 5, inputRevision: 1, createdAt, startedAt: createdAt + 20, endedAt: createdAt + durationMs,
        userMessage: message, userItemId: `item-${id}`, mode: 'send', countedDay: countedDay ?? day(createdAt), level, cost, levelCost,
        answeredSteps, ...(extraCharged ? { extraCharged, extraDay: day(createdAt) } : {}), ...(fellBack ? { fellBack: true } : {}), ...(errorCode ? { errorCode } : {}),
        userAdded: true, lastPromptTokens: 0, lastPromptItems: 0, stopRequested: status === 'cancelled', steps, toolCallCount: calls.length, activeMs: Math.round(durationMs * 0.9),
        inputs: steers.map((text, index) => ({ id: `in-${id}-${index}`, text, at: createdAt + 5 + index, applied: true, itemId: `item2-${id}-${index}` })),
        calls: calls.map((call, index) => ({
            id: `${id}-c${index}`, args: JSON.stringify({ query: 'TEXT-ARGS search' }), itemId: null, inputRevision: 1, result: 'TEXT-RESULT body', summary: 'SECRET-SUMMARY',
            startedAt: createdAt + 100, ...call,
        })),
        usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, unknownSteps: 0, ...usage },
    };
}

export async function seedAssistants({ db, redis, dist, now = new Date() }) {
    const { writeTurnLog, setTurnLogFeedback, addReconciledStep, clearExpiredTurnText } = await import(`${dist}/site_agent/turn_log.js`);
    const { recordFailure } = await import(`${dist}/utils/ai/docs_assistant/docs_assistant.js`);
    const t = now.getTime();
    const A = ASSISTANT_CHANNELS.alpha, B = ASSISTANT_CHANNELS.beta;
    const ownerOf = (channel) => ({ id: channel.id, login: channel.login, name: channel.login.toUpperCase() });
    const today = day(t), yesterday = day(t - DAY);

    // ---- Replace earlier seed ----
    const channelIds = [A.id, B.id];
    await db.collection('site_agent_turn_logs').deleteMany({ channelId: { $in: channelIds } });
    await db.collection('users').deleteMany({ 'accounts.id': { $in: [...channelIds, ASSISTANT_EDITOR.id, DELETED_MANAGER.id] } });
    await redis.del([`sess-${TURN_IDS.t1}`, `sess-${TURN_IDS.t3}`].flatMap((sid) => [`site_agent:s:${sid}:items`, `site_agent:s:${sid}:items:order`]));
    await redis.del([`site_agent:stats:${today}`, `site_agent:feedback:${TURN_IDS.t3}`, ...Object.values(TURN_IDS).map((id) => `site_agent:turnlog:late:${id}`), `site_agent:stats:${yesterday}`, `site_agent:daily:${A.id}:${today}`, `site_agent:daily:${B.id}:${today}`,
        `docs_assistant:stats:${today}`, 'docs_assistant:recent', ...Object.values(DOCS_IDS).map((id) => `docs_assistant:answer:${id}`)]);

    await db.collection('users').insertMany([A, B].map((channel) => ({
        accounts: [{ type: 'twitch', id: channel.id, name: channel.login }], plan_tier: channel.plan, email: `SECRET-${channel.login}@example.test`,
    })));
    // The editor has an account; the deleted manager has none any more.
    await db.collection('users').insertOne({ accounts: [{ type: 'twitch', id: ASSISTANT_EDITOR.id, name: ASSISTANT_EDITOR.login }], email: 'SECRET-editor@example.test' });

    // ---- Dima assistant turns ----
    // The answer lives in the chat's display items: t1's chat has two answer parts (and items of other turns and
    // kinds); t3's chat holds a tool row only; the other chats are gone.
    const items = (sid, list) => Promise.all([
        redis.hSet(`site_agent:s:${sid}:items`, Object.fromEntries(list.map((item) => [item.id, JSON.stringify(item)]))),
        redis.rPush(`site_agent:s:${sid}:items:order`, list.map((item) => item.id)),
    ]);
    await items(`sess-${TURN_IDS.t1}`, [
        { kind: 'assistant', id: 'x0', turnId: 'another-turn', text: 'not this turn', at: 1, final: true },
        { kind: 'user', id: 'x1', turnId: TURN_IDS.t1, text: 'TEXT-MESSAGE', mode: 'send', at: 2 },
        { kind: 'assistant', id: 'x2', turnId: TURN_IDS.t1, text: LONG.answers[0], at: 3, final: true },
        { kind: 'tool', id: 'x3', turnId: TURN_IDS.t1, callId: 'c', name: 'search_docs', label: 'SECRET-SUMMARY label', state: 'done', at: 4 },
        { kind: 'assistant', id: 'x4', turnId: TURN_IDS.t1, text: LONG.answers[1], at: 5, final: true },
    ]);
    await items(`sess-${TURN_IDS.t3}`, [{ kind: 'tool', id: 'y1', turnId: TURN_IDS.t3, callId: 'c', name: 'read_docs', label: 'SECRET-SUMMARY', state: 'interrupted', at: 1 },
        { kind: 'assistant', id: 'y2', turnId: TURN_IDS.t3, text: `Your session token is ${JWT}, keep it safe.`, at: 2, final: true }]);
    const known = { knownTool: (name) => ['search_docs', 'create_command', 'read_docs', 'get_command', 'recent_chat', 'show_ui'].includes(name) };
    const turns = {
        t1: turn({ id: TURN_IDS.t1, channel: A, user: ownerOf(A), plan: 'pro', level: 'expert', status: 'completed', createdAt: t - HOUR, durationMs: 9_000, steps: 3, cost: 2,
            message: LONG.message, steers: LONG.steers,
            calls: [{ name: 'search_docs', state: 'done', endedAt: t - HOUR + 350, args: LONG.args, result: LONG.result },
                { name: 'create_command', state: 'done', args: '{"name":"!hi"}', result: 'applied',
                    proposal: { title: 'SECRET-PROPOSAL', payload: { response: 'SECRET-PAYLOAD' }, undo: { previous: 'SECRET-UNDO' } },
                    approval: { state: 'applied', changeId: 'ch-1', error: 'SECRET-APPROVAL' } }],
            usage: { promptTokens: 1_000, cachedTokens: 800, completionTokens: 100, reasoningTokens: 10, costUsd: 0.01 } }),
        t2: turn({ id: TURN_IDS.t2, channel: A, user: ASSISTANT_EDITOR, role: 'admin', plan: 'pro', level: 'standard', status: 'failed', errorCode: 'model_overloaded',
            createdAt: t - 2 * HOUR, durationMs: 3_000, steps: 1, answeredSteps: 0, calls: [{ name: 'read_docs', state: 'error', endedAt: t - 2 * HOUR + 900 }],
            usage: { promptTokens: 400, completionTokens: 20, costUsd: 0.002, unknownSteps: 1 } }),
        t3: turn({ id: TURN_IDS.t3, channel: B, user: ownerOf(B), plan: 'premium', level: 'standard', status: 'cancelled', createdAt: t - 3 * HOUR, durationMs: 1_500,
            calls: [{ name: 'read_docs', state: 'interrupted' }, { name: 'SECRET-NAME invented_tool', state: 'error', endedAt: t - 3 * HOUR + 200, args: '{"invented":"TEXT-INVENTED-ARGS"}' },
                // Realistic results: a command holding a keyed URL and a bearer token, a chat line with an address, a submitted form.
                { name: 'get_command', state: 'done', endedAt: t - 3 * HOUR + 110, result: SECRET_RESULTS.command },
                { name: 'recent_chat', state: 'done', endedAt: t - 3 * HOUR + 110, result: SECRET_RESULTS.chat },
                { name: 'show_ui', state: 'done', endedAt: t - 3 * HOUR + 600, args: '{"title":"Pick a time"}', result: '{"submitted":true,"values":{"when":"FORMVALUE-8e8"}}',
                    ui: { state: 'submitted', values: { when: 'SECRET-UI' } } }],
            usage: { promptTokens: 300, completionTokens: 10, costUsd: 0.001 } }),
        t4: turn({ id: TURN_IDS.t4, channel: B, user: ownerOf(B), plan: 'premium', level: 'expert', status: 'interrupted', errorCode: 'interrupted', fellBack: true,
            createdAt: t - 26 * HOUR, durationMs: 30_000, steps: 2, cost: 2, extraCharged: 2, usage: { promptTokens: 5_000, cachedTokens: 1_000, completionTokens: 200, costUsd: 0.02 } }),
        // Outside the default 30 days, inside the 90 kept.
        // Older than the 3 days chats are kept: the text sweep blanks it (the numbers stay).
        t5: turn({ id: TURN_IDS.t5, channel: A, user: ownerOf(A), plan: 'pro', level: 'standard', status: 'completed', createdAt: t - 40 * DAY, durationMs: 2_000,
            calls: [{ name: 'read_docs', state: 'done', endedAt: t - 40 * DAY + 300 }], usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.5 } }),
    };
    await writeTurnLog(turns.t1, { ...known, models: [HAIKU], channelLogin: A.login });
    // Rated before its row was written: the writer picks the rating up.
    await redis.hSet(`site_agent:feedback:${TURN_IDS.t3}`, { rating: 'unhelpful' });
    for (const key of ['t2', 't3', 't5']) await writeTurnLog(turns[key], known);
    await writeTurnLog(turn({ id: TURN_IDS.gone, channel: A, user: DELETED_MANAGER, role: 'admin', plan: 'pro', level: 'standard', status: 'completed', createdAt: t - 30 * 60_000,
        durationMs: 1_000, usage: { costUsd: 0.003 } }), known);
    // Fell back: each model with its own cost (the runner's split).
    await writeTurnLog(turns.t4, { ...known, models: [HAIKU, LUNA], modelCosts: [{ model: HAIKU, steps: 1, costUsd: 0.018 }, { model: LUNA, steps: 1, costUsd: 0.002 }] });
    // Finished twice (recovery): still one row.
    await writeTurnLog(turns.t1, { ...known, models: [HAIKU], channelLogin: A.login });
    await setTurnLogFeedback(turns.t1.id, 'helpful');
    // The app's own 3-day text sweep, at the seed's instant: only t5 is old enough.
    await clearExpiredTurnText(t);
    // t2's unknown step is reconciled later.
    await addReconciledStep(turns.t2.id, `site_agent:${turns.t2.id}:0`, { promptTokens: 100, cachedTokens: 0, completionTokens: 5, reasoningTokens: 0, upstreamCostUsd: 0.0005, routerCostUsd: 0, source: 'reconciled', isByok: true }, 0.0005, LUNA);
    // The same step reported twice: added once.
    await addReconciledStep(turns.t2.id, `site_agent:${turns.t2.id}:0`, { promptTokens: 100, cachedTokens: 0, completionTokens: 5, reasoningTokens: 0, upstreamCostUsd: 0.0005, routerCostUsd: 0, source: 'reconciled', isByok: true }, 0.0005, LUNA);

    await redis.hSet(`site_agent:stats:${today}`, { turns: '3', turns_completed: '1', turns_failed: '1', turns_cancelled: '1', steps: '5', compactions: '1', tool_calls: '4',
        prompt_tokens: '1700', cached_tokens: '800', completion_tokens: '130', cost_micro_usd: '13500', helpful: '1', messages: '3' });
    await redis.hSet(`site_agent:stats:${yesterday}`, { turns: '1', turns_interrupted: '1', steps: '2', prompt_tokens: '5000', cached_tokens: '1000', completion_tokens: '200', cost_micro_usd: '20000' });
    await redis.set(`site_agent:daily:${A.id}:${today}`, '30');
    await redis.set(`site_agent:daily:${B.id}:${today}`, '100');

    // ---- Docs assistant ----
    const answer = (id, minutesAgo, fields) => redis.hSet(`docs_assistant:answer:${id}`, {
        at: new Date(t - minutesAgo * 60_000).toISOString(), turn: '1', sources: '[]', input_tokens: '1000', output_tokens: '100', stop_reason: 'end_turn', ...fields,
    });
    await answer(DOCS_IDS.one, 10, { lang: 'en', page: 'https://docs.domdimabot.com/ai-assistants/?ref=tracking123#top', question: 'DOCS-Q one', answer: 'DOCS-A one',
        sources: '["https://docs.domdimabot.com/ai-assistants/"]', duration_ms: '12000', cost_usd: '0.009000', rounds: '2',
        tool_calls: JSON.stringify([{ name: 'search_ast_functions', input: { query: 'x' } }, { name: 'test_command', input: {} }]), feedback: 'helpful' });
    // Answers from before 2026-11-02 have empty rounds/tool_calls.
    await answer(DOCS_IDS.two, 20, { lang: 'es', page: 'https://docs.domdimabot.com/es/', question: 'DOCS-Q two', answer: 'DOCS-A two', duration_ms: '5000',
        cost_usd: '0.002000', rounds: '', tool_calls: '', turn: '3' });
    await answer(DOCS_IDS.three, 30, { lang: 'en', page: '/', question: 'DOCS-Q three', answer: 'DOCS-A three', duration_ms: '20000', cost_usd: '0.004000', rounds: '1', tool_calls: '[]' });
    for (const id of [DOCS_IDS.expired, DOCS_IDS.three, DOCS_IDS.two, DOCS_IDS.one]) await redis.lPush('docs_assistant:recent', id);
    for (const id of Object.values(DOCS_IDS)) if (id !== DOCS_IDS.expired) await redis.expire(`docs_assistant:answer:${id}`, 30 * 86_400);
    await redis.hSet(`docs_assistant:stats:${today}`, { asked: '5', answered: '3', tool_calls: '2', input_tokens: '3000', output_tokens: '300', cost_micro_usd: '15000', helpful: '1' });
    // A question that timed out, through the app's own recorder (adds failed + failed_timeout and its record).
    await recordFailure({ messages: [{ role: 'user', content: 'DOCS-FAILED question from me@visitor.test with token=SECRETDOCS1234' }], page: { lang: 'en', url: 'https://docs.domdimabot.com/faq/?session=tracking123' } },
        'timeout', { id: null, durationMs: 60_000 });

    return {
        today, yesterday, turns,
        expected: {
            defaultTurns: [TURN_IDS.t1, TURN_IDS.t2, TURN_IDS.t3, TURN_IDS.t4],
            byLevel: [
                { level: 'expert', turns: 2, failed: 1, providerUSD: 0.03, avgDurationMs: 19_500 },
                { level: 'standard', turns: 2, failed: 1, providerUSD: 0.0035, avgDurationMs: 2_250 },
            ],
            // Each model its own cost: a fell-back turn is not counted in full twice.
            byModel: [{ model: LUNA, turns: 3, providerUSD: 0.0055 }, { model: HAIKU, turns: 2, providerUSD: 0.028 }],
            byChannel: [
                { channelID: A.id, channel: A.login, plan: 'pro', turns: 2, failed: 1, cancelled: 0, units: 2, providerUSD: 0.0125, lastAt: new Date(t - HOUR).toISOString() },
                { channelID: B.id, channel: B.login, plan: 'premium', turns: 2, failed: 1, cancelled: 1, units: 5, providerUSD: 0.021, lastAt: new Date(t - 3 * HOUR).toISOString() },
            ],
            byTool: [{ name: 'read_docs', calls: 2, failed: 1 }, { name: 'create_command', calls: 1, failed: 0 }, { name: 'get_command', calls: 1, failed: 0 },
                { name: 'recent_chat', calls: 1, failed: 0 }, { name: 'search_docs', calls: 1, failed: 0 }, { name: 'show_ui', calls: 1, failed: 0 }, { name: 'unknown_tool', calls: 1, failed: 1 }],
            errors: [{ code: 'interrupted', count: 1, lastAt: new Date(t - 26 * HOUR).toISOString() }, { code: 'model_overloaded', count: 1, lastAt: new Date(t - 2 * HOUR).toISOString() }],
            limitsToday: [{ channelID: B.id, channel: B.login, used: 100, limit: 100 }, { channelID: A.id, channel: A.login, used: 30, limit: 400 }],
            channels: 2, people: 3,
            recordsSince: new Date(t - 40 * DAY).toISOString(),
            docs: { asked: 5, answered: 3, failed: 1, abandoned: 1, medianDurationMs: 12_000, byLang: [{ lang: 'en', answers: 2 }, { lang: 'es', answers: 1 }],
                topPages: [{ page: '/', answers: 1 }, { page: '/ai-assistants/', answers: 1 }, { page: '/es/', answers: 1 }] },
        },
    };
}
