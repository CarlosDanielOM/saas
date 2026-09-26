import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { CommandReferenceRequest } from './types.js';

const commands = new Map<string, Record<string, unknown>>();
const lookups: string[] = [];
const writes: unknown[] = [];
const cooldowns = new Set<string>();
mock.module('../../classes/command.class.js', { defaultExport: {
    getCommandFromDB: async (_channel: string, command: string) => {
        lookups.push(command);
        const value = commands.get(command);
        return value ? { error: false, command: value, status: 200 } : { error: true, message: 'Not found', status: 404 };
    },
    updateCommandInDB: async (...args: unknown[]) => { writes.push(args); }
} });
mock.module('../../classes/twitch_streamers.class.js', { defaultExport: {
    getTwitchAccountById: async () => ({ id: 'fixture', name: 'fixture', plan_tier: 'pro' })
} });
mock.module('../databases/dragonfly.database.js', { namedExports: {
    getDragonflyClient: async () => ({ set: async (key: string) => {
        if (cooldowns.has(key)) return null;
        cooldowns.add(key);
        return 'OK';
    } })
} });
mock.module('./functions/index.js', { namedExports: { registerAllFunctions: () => {} } });
const { commandHandler } = await import('../../handlers/commands.handler.js');
const { deliverAstMessage } = await import('../ast_command_delivery.js');
const { createExecutionContext, evaluate, registerFunction } = await import('./evaluator.js');
const { parse } = await import('./parser.js');
const { createUserIdentity } = await import('../permissions/index.js');

const event = { chatter_user_id: 'viewer-id', chatter_user_login: 'viewer', chatter_user_name: 'Viewer' };
const authorization = { origin: 'chat' as const, identity: createUserIdentity(1) };
const sent: string[] = [];
const dependencies = {
    send: async (_channel: string, message: string) => { sent.push(message); return { error: false, message: 'sent' }; },
    execute: async (request: CommandReferenceRequest) => commandHandler(request.channelID, request.eventData,
        request.commandName, request.argument, request.authorization, request.state)
};
function setup(definitions: Record<string, string>) {
    commands.clear(); lookups.length = 0; writes.length = 0; sent.length = 0; cooldowns.clear();
    for (const [cmd, message] of Object.entries(definitions)) {
        commands.set(cmd, { cmd, message, enabled: true, userLevel: 1, cooldown: 0 });
    }
}
async function run(name: string, argument = '') {
    const result = await commandHandler('fixture', event, name, argument, authorization);
    assert.equal(result.error, false);
    await deliverAstMessage('fixture', { parsedText: result.message, commandReferences: result.commandReferences }, true, dependencies);
    return result;
}

test('sends the outer message before invoking and sending a referenced command', async () => {
    setup({ socials: 'Join us on: #(discord)', discord: 'Discord: https://discord.example/invite' });
    const result = await commandHandler('fixture', event, 'socials', '', authorization);
    assert.equal(result.message, 'Join us on: ');
    assert.deepEqual(lookups, ['socials'], 'reference must not execute during outer rendering');
    await deliverAstMessage('fixture', { parsedText: result.message, commandReferences: result.commandReferences }, true, dependencies);
    assert.deepEqual(sent, ['Join us on:', 'Discord: https://discord.example/invite']);
});

test('reference-only command produces only the referenced message', async () => {
    setup({ socials: '#(discord)', discord: 'Discord' });
    await run('socials');
    assert.deepEqual(sent, ['Discord']);
});

test('direct recursion is stopped before a second command lookup', async () => {
    setup({ loop: 'Once #(loop)' });
    await run('loop');
    assert.deepEqual(sent, ['Once']);
    assert.deepEqual(lookups, ['loop']);
});

test('indirect recursion retains the entire active call path', async () => {
    setup({ a: 'A #(b)', b: 'B #(a)' });
    await run('a');
    assert.deepEqual(sent, ['A', 'B']);
    assert.deepEqual(lookups, ['a', 'b']);
});

test('sibling references can reuse a command without a false cycle', async () => {
    setup({ root: 'Root #(a) #(a)', a: 'A #(b)', b: 'B' });
    await run('root');
    assert.deepEqual(sent, ['Root', 'A', 'B', 'A', 'B']);
});

test('a chain stops after five nested references', async () => {
    setup(Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`c${n}`, `C${n} #(c${n + 1})`])));
    await run('c0');
    assert.deepEqual(sent, ['C0', 'C1', 'C2', 'C3', 'C4', 'C5']);
    assert.equal(lookups.length, 6);
});

test('one shared invocation budget bounds expanding branches', async () => {
    setup({ root: '#(a) '.repeat(40), a: 'A #(b) #(b)', b: 'B' });
    await run('root');
    assert.equal(lookups.length, 51);
});

test('literal arguments and returned AST-looking text are never evaluated twice', async () => {
    setup({ root: '#(echo &t)', echo: 'You said: &t' });
    let effects = 0;
    registerFunction('probe', async () => { effects++; return 'executed'; });
    await run('root', '$(probe)');
    assert.deepEqual(sent, ['You said: $(probe)']);
    assert.equal(effects, 0);
});

test('separate referenced commands preserve their own arguments and variable scopes', async () => {
    setup({ root: '%(v outer) #(echo hello) #(echo goodbye) %(v)', echo: '%(v inner)&p1 %(v)' });
    await run('root');
    assert.deepEqual(sent, ['outer', 'hello inner', 'goodbye inner']);
});

test('missing or disabled commands produce no reference message', async () => {
    setup({ root: 'Root #(missing) #(disabled)', disabled: 'Do not send' });
    commands.get('disabled')!.enabled = false;
    await run('root');
    assert.deepEqual(sent, ['Root']);
});

test('direct invocation and nested reference share the referenced cooldown', async () => {
    setup({ root: 'Root #(limited)', limited: 'Limited' });
    commands.get('limited')!.cooldown = 30;
    await run('limited');
    await run('root');
    assert.deepEqual(sent, ['Limited', 'Root']);
    assert.equal((await commandHandler('fixture', event, 'limited', '', authorization)).type, 'command_cooldown');
});

test('LLM references retain permission checks before dispatch', async () => {
    setup({ restricted: 'Do not send' });
    commands.get('restricted')!.userLevel = 7;
    const context = createExecutionContext({ broadcasterId: 'fixture', userLevel: 1,
        authorization: { origin: 'llm', identity: { level: 1, tags: [] } } });
    await evaluate(parse('#(restricted)').ast, context);
    await deliverAstMessage('fixture', { parsedText: '', commandReferences: context.commandReferences }, true, dependencies);
    assert.deepEqual(sent, []);
});

test('failed outer delivery does not execute its queued commands', async () => {
    setup({ root: 'Root #(a)', a: 'A' });
    const result = await commandHandler('fixture', event, 'root', '', authorization);
    const delivery = await deliverAstMessage('fixture', { parsedText: result.message, commandReferences: result.commandReferences }, true,
        { ...dependencies, send: async () => ({ error: true, message: 'rejected' }) });
    assert.equal(delivery.error, true);
    assert.deepEqual(lookups, ['root']);
});

test('chat suppression still executes referenced actions without sending messages', async () => {
    setup({ root: 'Root #(a)', a: 'A $(probe)' });
    let effects = 0;
    registerFunction('probe', async () => { effects++; return ''; });
    const result = await commandHandler('fixture', event, 'root', '', authorization);
    await deliverAstMessage('fixture', { parsedText: result.message, commandReferences: result.commandReferences }, false, dependencies);
    assert.deepEqual(sent, []);
    assert.equal(effects, 1);
});
