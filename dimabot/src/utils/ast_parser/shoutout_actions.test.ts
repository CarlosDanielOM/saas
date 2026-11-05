import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import defaults from '../../config/commands/reservedcommands.json' with { type: 'json' };
let calls: string[] = []; let fail = ''; let nativeFail = false;
mock.module('../header.js', { namedExports: { TWITCH_BOT_ACCOUNT_ID: 'bot' } });
mock.module('../../functions/users/index.js', { namedExports: { getTwitchUserByLogin: async (login: string) => { calls.push(`user:${login}`); return login === 'alice' ? { error: false, data: { id: '42', login, display_name: 'Alice' } } : { error: true }; } } });
mock.module('../../functions/channels/index.js', { namedExports: { getChannelInformation: async () => { calls.push('channel'); return { error: false, data: { broadcaster_name: 'Alice', broadcaster_login: 'alice', game_name: 'Chess' } }; } } });
mock.module('../../functions/chats/index.js', { namedExports: { sendAnnouncement: async (_id: string, mod: string, message: string, color: string) => { calls.push(`announce:${mod}:${color}:${message}`); if (fail === 'throw') throw Error(); return { error: fail === 'structured' }; }, sendShoutout: async (_id: string, user: string, mod: string) => { calls.push(`native:${user}:${mod}`); if (nativeFail) throw Error(); return { error: false }; } } });
mock.module('../../functions/clips/index.js', { namedExports: { createClip: async () => ({}), getClip: async () => ({}), getChannelClips: async (id: string) => { calls.push(`clips:${id}`); return { error: false, data: [{ id: 'clip' }] }; }, showClip: async () => { calls.push('show'); return { error: false }; } } });
mock.module('../../classes/twitch_streamers.class.js', { defaultExport: {} });
const { parse } = await import('./parser.js');
const { evaluate, createExecutionContext } = await import('./evaluator.js');
const { registerChatFunctions } = await import('./functions/chat.functions.js');
const { registerClipFunctions } = await import('./functions/clip.functions.js');
const { registerTwitchFunctions } = await import('./functions/twitch.functions.js');
registerChatFunctions(); registerClipFunctions(); registerTwitchFunctions();
const body = defaults.commands.find(c => c.func === 'shoutout')!.message!;
async function run(source: string, arg = '', level = 7, authored = false) {
 const parsed = parse(source.replace(/&t\b/g, '%(fixture_arg)')); assert.equal(parsed.error, undefined);
 const ctx = createExecutionContext({ broadcasterId: 'channel', userLevel: level, enforceFunctionPermissions: !authored }); ctx.variables.set('fixture_arg', arg);
 return String((await evaluate(parsed.ast, ctx)).value).trim();
}
test('default AST uses normalized target for announcement, shoutout and clip', async () => {
 calls = []; fail = ''; nativeFail = false; assert.equal(await run(body, '@Alice'), '');
 assert.deepEqual(calls, ['user:alice', 'channel', 'announce:bot:purple:Check out Alice at https://twitch.tv/alice and give them a follow! They were last playing Chess', 'native:42:bot', 'clips:42', 'show']);
});
test('announcement failure returns text and native failure does not stop clip', async () => {
 for (const mode of ['structured', 'throw']) { calls = []; fail = mode; nativeFail = true;
 assert.equal(await run(body, 'alice'), 'Check out Alice at https://twitch.tv/alice and give them a follow! They were last playing Chess');
 assert.equal(calls.filter(c => c.startsWith('announce:')).length, 1); assert.ok(calls.includes('show')); }
});
test('invalid and literal injected targets cause no actions', async () => {
 for (const arg of ['', '@', 'not valid', 'unknown', '$(shoutout alice)']) { calls = []; assert.match(await run(body, arg), /valid user/); assert.ok(!calls.some(c => /^(announce|native|clips|show)/.test(c))); }
});
test('direct AI action permissions and authored command override', async () => {
 fail = ''; nativeFail = false;
 for (const action of ['announcement hello', 'shoutout alice', 'show.clip alice']) {
 calls = []; await run(`$(${action})`, '', 1); assert.deepEqual(calls, []);
 calls = []; await run(`$(${action})`, '', 7); assert.ok(calls.length);
 calls = []; await run(`$(${action})`, '', 1, true); assert.ok(calls.length); }
});

test('announcement accepts default color, quoted text, nested values and aliases', async () => {
 calls = []; fail = ''; nativeFail = false;
 assert.equal(await run('$(announcement "Hello  everyone!")'), '');
 assert.equal(calls[0], 'announce:bot:primary:Hello  everyone!');
 calls = []; assert.equal(await run('$(chat.announcement green "Welcome ${$(twitch.channel alice)}!")'), '');
 assert.ok(calls.includes('announce:bot:green:Welcome Alice!'));
});
