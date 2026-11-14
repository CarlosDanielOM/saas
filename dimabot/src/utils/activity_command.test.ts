import test from 'node:test';
import assert from 'node:assert/strict';
import {
    botMessageActivity, chatActor, chatOrigin, commandActivity, commandResultOutcome, recordBotMessage, recordCommandActivity
} from './activity_command.js';
import { buildActivityRow, pendingActivityRowsForTests, setActivityLogSinkForTests } from './activity_log.js';
import { deliverAstMessage } from './ast_command_delivery.js';
import type { CommandReferenceRequest } from './ast_parser/types.js';

const chat = {
    message_id: 'msg-1', chatter_user_id: '42', chatter_user_login: 'Some_Viewer', chatter_user_name: 'Some Viewer',
    message: { text: '!so @friend' }
};

test('typed command results keep their reason; an unknown command writes nothing', () => {
    assert.deepEqual(commandResultOutcome('success', false), { outcome: 'ok', reason: null });
    assert.deepEqual(commandResultOutcome(null, false), { outcome: 'ok', reason: null });
    assert.deepEqual(commandResultOutcome('command_cooldown', true), { outcome: 'skipped', reason: 'cooldown' });
    assert.deepEqual(commandResultOutcome('command_disabled', true), { outcome: 'skipped', reason: 'disabled' });
    assert.deepEqual(commandResultOutcome('permission_denied', true), { outcome: 'blocked', reason: 'permission_denied' });
    assert.deepEqual(commandResultOutcome('error_retrieving_command', true), { outcome: 'failed', reason: 'error_retrieving_command' });
    assert.deepEqual(commandResultOutcome(undefined, true), { outcome: 'failed', reason: 'error' });
    assert.equal(commandResultOutcome('command_not_found', true), null);
});

test('a command row carries the chatter, the chat line, the message id and the trigger', () => {
    const input = commandActivity({
        channelID: '100', name: '!so', trigger: 'chat', func: 'shoutout', event: chat,
        outcome: 'blocked', reason: 'permission_invalid', durationMs: 4
    });
    assert.equal(input.kind, 'command');
    assert.deepEqual(input.actor, { id: '42', login: 'Some_Viewer', name: 'Some Viewer' });
    assert.equal(input.text, '!so @friend');
    assert.equal(input.ref, 'msg-1');
    assert.deepEqual(input.data, { func: 'shoutout', trigger: 'chat' });
    const row = buildActivityRow(input)!;
    assert.equal(row.outcome, 'blocked');
    assert.equal(row.reason, 'permission_invalid');
    assert.equal(row.actorLogin, 'some_viewer');
});

test('the dedupe key is stable per message and command, and differs per trigger or key', () => {
    const base = { channelID: '100', name: '!So', trigger: 'chat' as const, event: chat, outcome: 'ok' as const, reason: null };
    const first = buildActivityRow(commandActivity(base))!;
    const retry = buildActivityRow(commandActivity({ ...base, name: '!so', durationMs: 99 }))!;
    assert.equal(first._id, retry._id);
    assert.notEqual(first._id, buildActivityRow(commandActivity({ ...base, trigger: 'keyword' }))!._id);
    assert.notEqual(first._id, buildActivityRow(commandActivity({ ...base, key: 'other' }))!._id);
    assert.notEqual(first._id, buildActivityRow(commandActivity({ ...base, event: { ...chat, message_id: 'msg-2' } }))!._id);
    // A timer has no chat message: every firing is its own row.
    const timer = { channelID: '100', name: 'hydrate', trigger: 'timer' as const, outcome: 'ok' as const, reason: null };
    const timerInput = commandActivity(timer);
    assert.equal(timerInput.dedupeKey, null);
    assert.equal(timerInput.actor, null);
});

test('actors come from chat fields, then from other event fields; nothing when there are none', () => {
    assert.deepEqual(chatActor({ user_id: '7', user_login: 'x', user_name: 'X' }), { id: '7', login: 'x', name: 'X' });
    assert.equal(chatActor({}), null);
    assert.equal(chatActor(null), null);
    assert.equal(chatActor('text'), null);
});

test('bot message rows: origin defaults to bot, every send result maps to its outcome', () => {
    assert.equal(chatOrigin(undefined), 'bot');
    assert.equal(chatOrigin('nonsense'), 'bot');
    assert.equal(chatOrigin('timer'), 'timer');

    const sent = botMessageActivity({ channelID: '100', text: 'hi', replyTo: 'msg-1', result: { status: 'sent', messageId: 'tw-1' } });
    assert.equal(sent.name, 'bot');
    assert.equal(sent.outcome, 'ok');
    assert.equal(sent.ref, 'tw-1');
    assert.deepEqual(buildActivityRow(sent)!.data, { origin: 'bot', messageId: 'tw-1', replyTo: 'msg-1' });

    const held = botMessageActivity({ channelID: '100', text: 'hi', delivery: { origin: 'ai', actor: { id: '42' } },
        result: { status: 'held', messageId: 'tw-2', twitchMessage: 'AutoMod' } });
    assert.deepEqual([held.name, held.outcome, held.reason], ['ai', 'blocked', 'held_for_moderation']);
    assert.deepEqual(held.actor, { id: '42' });
    assert.equal(held.data?.twitchMessage, 'AutoMod');

    const rejected = botMessageActivity({ channelID: '100', text: 'hi', result: { status: 'rejected', httpStatus: 403, twitchMessage: 'banned' } });
    assert.deepEqual([rejected.outcome, rejected.reason, rejected.data?.httpStatus, rejected.data?.twitchMessage],
        ['failed', 'twitch_rejected', 403, 'banned']);
    assert.equal(rejected.ref, null);

    assert.deepEqual([botMessageActivity({ channelID: '1', text: 'x', result: { status: 'no_token' } }).reason,
        botMessageActivity({ channelID: '1', text: 'x', result: { status: 'exception' } }).reason], ['no_token', 'exception']);
});

test('the record wrappers queue rows and never throw on odd input', () => {
    setActivityLogSinkForTests(async () => undefined);
    recordCommandActivity({ channelID: '100', name: '!a', trigger: 'chat', outcome: 'ok', reason: null, event: chat });
    recordBotMessage({ channelID: '100', text: undefined as never, result: { status: 'exception' } });
    recordCommandActivity(null as never);
    recordBotMessage(null as never);
    const rows = pendingActivityRowsForTests();
    assert.deepEqual(rows.map(row => [row.kind, row.name, row.outcome]), [['command', '!a', 'ok'], ['bot_message', 'bot', 'failed']]);
    setActivityLogSinkForTests(null);
});

test('AST delivery tags its send and records referenced commands, but not unknown ones', async () => {
    setActivityLogSinkForTests(async () => undefined);
    const sends: unknown[] = [];
    const reference = (commandName: string): CommandReferenceRequest => ({
        channelID: '100', commandName, argument: '', eventData: chat,
        authorization: { origin: 'authored', identity: {} as never },
        state: { commandRefDepth: 1 } as never
    });
    const results: Record<string, { error: boolean; message: string; type?: string }> = {
        hello: { error: false, message: 'hello back', type: 'success' },
        slow: { error: true, message: 'Command is on cooldown', type: 'command_cooldown' },
        missing: { error: true, message: 'Command does not exist', type: 'command_not_found' }
    };
    await deliverAstMessage('100', {
        parsedText: 'outer', origin: 'command', actor: { id: '42' },
        commandReferences: [reference('hello'), reference('slow'), reference('missing'), reference('boom')]
    }, true, {
        send: async (_channel, text, delivery) => { sends.push([text, delivery]); return { error: false, message: 'sent' }; },
        execute: async request => {
            if (request.commandName === 'boom') throw new Error('kaput');
            return results[request.commandName];
        }
    });
    assert.deepEqual(sends, [
        ['outer', { origin: 'command', actor: { id: '42' } }],
        ['hello back', { origin: 'command', actor: { id: '42', login: 'Some_Viewer', name: 'Some Viewer' } }]
    ]);
    const rows = pendingActivityRowsForTests();
    assert.deepEqual(rows.map(row => [row.name, row.outcome, row.reason, row.data.trigger]), [
        ['!hello', 'ok', '', 'reference'],
        ['!slow', 'skipped', 'cooldown', 'reference'],
        ['!boom', 'failed', 'error', 'reference']
    ]);
    setActivityLogSinkForTests(null);
});

test('reference rows get one key per invocation path, stable when the same message is delivered again', async () => {
    const reference = (commandName: string): CommandReferenceRequest => ({
        channelID: '100', commandName, argument: '', eventData: chat,
        authorization: { origin: 'authored', identity: {} as never }, state: { commandRefDepth: 1 } as never
    });
    // Delivers `refs` under `root`; `children` gives the references each command's reply makes in turn.
    async function deliver(root: string, refs: string[], children: Record<string, string[]> = {}) {
        setActivityLogSinkForTests(async () => undefined);
        let limitedRuns = 0;
        await deliverAstMessage('100', { parsedText: '', referencePath: root, commandReferences: refs.map(reference) }, true, {
            send: async () => ({ error: false, message: 'sent' }),
            execute: async request => {
                if (request.commandName === 'limited' && ++limitedRuns > 1) {
                    return { error: true, message: 'Command is on cooldown', type: 'command_cooldown' };
                }
                return { error: false, message: '', type: 'success', commandReferences: (children[request.commandName] ?? []).map(reference) };
            }
        });
        const rows = pendingActivityRowsForTests().map(row => ({ id: row._id, name: row.name, outcome: row.outcome }));
        setActivityLogSinkForTests(null);
        return rows;
    }

    const twice = await deliver('chat', ['limited', 'limited']);
    assert.deepEqual(twice.map(row => [row.name, row.outcome]), [['!limited', 'ok'], ['!limited', 'skipped']]);
    assert.notEqual(twice[0].id, twice[1].id, 'the same command referenced twice in one reply keeps both rows');

    const branches = await deliver('chat', ['a', 'b'], { a: ['shared'], b: ['shared'] });
    const shared = branches.filter(row => row.name === '!shared');
    assert.equal(shared.length, 2);
    assert.notEqual(shared[0].id, shared[1].id, 'nested references in two branches do not collide');
    assert.equal(new Set(branches.map(row => row.id)).size, branches.length);

    assert.deepEqual(await deliver('chat', ['limited', 'limited']), twice, 'a redelivered message maps onto the same rows');
    assert.deepEqual(await deliver('chat', ['a', 'b'], { a: ['shared'], b: ['shared'] }), branches);

    const fromKeyword = await deliver('keyword:kw-1', ['limited', 'limited']);
    assert.equal(fromKeyword.some(row => twice.some(other => other.id === row.id)), false,
        'references from a keyword reply and from the command reply on the same message do not collide');
});

test('a delivery reports how many chat messages it really sent, references included', async () => {
    setActivityLogSinkForTests(async () => undefined);
    try {
        const reference = (commandName: string): CommandReferenceRequest => ({
            channelID: '100', commandName, argument: '', eventData: chat,
            authorization: { origin: 'authored', identity: {} as never }, state: { commandRefDepth: 1 } as never
        });
        const dependencies = {
            send: async () => ({ error: false, message: 'sent' }),
            execute: async (request: CommandReferenceRequest) => request.commandName === 'missing'
                ? { error: true, message: 'Command not found', type: 'command_not_found' }
                : request.commandName === 'silent' ? { error: false, message: '   ' }
                : { error: false, message: `reply of ${request.commandName}` }
        };
        const run = (parsedText: string, refs: string[], chatEnabled = true) =>
            deliverAstMessage('100', { parsedText, commandReferences: refs.map(reference) }, chatEnabled, dependencies);
        // Own text plus one reference that answers.
        assert.equal((await run('hello', ['discord'])).sent, 2);
        // Only a reference: nothing of its own, one reply.
        assert.equal((await run('', ['discord'])).sent, 1);
        // Only references that send nothing: a command that does not exist and one whose reply is blank.
        assert.equal((await run('', ['missing', 'silent'])).sent, 0);
        // Chat is off for the channel: references still run, nothing is sent.
        assert.equal((await run('hello', ['discord'], false)).sent, 0);
    } finally { setActivityLogSinkForTests(null); }
});

test('a failed command keeps its own words; a usage reply is not a failure', async () => {
    const { builtInFailureOutcome, errorText } = await import('./activity_command.js');
    assert.equal(errorText(new Error('Twitch said 401')), 'Twitch said 401');
    assert.equal(errorText('  The game does not exist '), 'The game does not exist');
    assert.equal(errorText({ message: 'Keyword is disabled or deleted' }), 'Keyword is disabled or deleted');
    assert.equal(errorText(null), null);
    assert.equal(errorText(''), null);
    assert.deepEqual(builtInFailureOutcome('Usage: !dc <command name>'), { outcome: 'skipped', reason: 'usage' });
    assert.deepEqual(builtInFailureOutcome('The game does not exist'), { outcome: 'failed', reason: 'error' });
    assert.deepEqual(builtInFailureOutcome(undefined), { outcome: 'failed', reason: 'error' });
    const row = buildActivityRow(commandActivity({ channelID: '100', name: '!game', trigger: 'chat', func: 'game', event: chat,
        outcome: 'failed', reason: 'error', error: 'The game does not exist' }))!;
    assert.deepEqual(row.data, { func: 'game', trigger: 'chat', error: 'The game does not exist' });
    const ok = buildActivityRow(commandActivity({ channelID: '100', name: '!so', trigger: 'chat', func: 'shoutout', event: chat, outcome: 'ok', reason: null }))!;
    assert.deepEqual(ok.data, { func: 'shoutout', trigger: 'chat' }, 'no error fact on a run that worked');
});
