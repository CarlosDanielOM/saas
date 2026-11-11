/**
 * The assistant must never do more than the requester could do by hand: every tool's permissions
 * must match the route the page uses. This test pins both the tool table and the route source.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SECRET_KEY ??= 'tool-test-secret';

const { settingsTools, SETTINGS_TOOL_PERMISSIONS } = await import('./index.js');
const { streamTools, STREAM_TOOL_PERMISSIONS } = await import('../../stream.js');
const { settingsReadTools, SETTINGS_READ_PERMISSIONS } = await import('../../settings_read.js');

const route = (file: string) => readFileSync(new URL(`../../../../server/routes/${file}`, import.meta.url), 'utf8');
/** Source of one handler: from its registration to the next router registration. */
function handler(source: string, start: string): string {
    const at = source.indexOf(start);
    assert.ok(at >= 0, `missing handler ${start}`);
    const next = source.slice(at + start.length).search(/\n\s*(router|[a-zA-Z]+Route)\.(get|post|put|patch|delete|use)\(/);
    return source.slice(at, next < 0 ? undefined : at + start.length + next);
}

test('settings tools carry exactly the permissions of the routes their pages use', () => {
    assert.deepEqual(settingsTools.map((tool) => tool.name).sort(), Object.keys(SETTINGS_TOOL_PERMISSIONS).sort());
    for (const tool of settingsTools) {
        assert.deepEqual([...tool.permissions], [...SETTINGS_TOOL_PERMISSIONS[tool.name]], tool.name);
        assert.equal(tool.kind, 'write', tool.name);
        assert.equal(typeof tool.apply, 'function', tool.name);
        assert.equal(tool.minPlan, undefined, `${tool.name}: plan gates are per field/feature, enforced by the shared services`);
    }
    const speech = route('speech.route.ts');
    assert.match(handler(speech, "router.put('/settings/:channelID'"), /getTtsAccess\(requesterID, channelID, 'tts:manage'\)/);
    assert.match(handler(route('moderation.route.ts'), "router.put('/:channelID/settings'"), /validateAccess\(req, res, channelID, 'moderation:manage'\)/);
    assert.match(route('follow_defense.route.ts'), /req\.method === 'GET' \? 'moderation:view' : 'moderation:manage'/);
    assert.match(handler(route('aiPersonality.route.ts'), "router.put('/:channelID'"), /getChannelAccessContext\(req\.user\?\.id, channelID, 'ai:manage'\)/);
    const eventsub = route('eventsub.route.ts');
    for (const start of ["router.post('/:channelID', ", "router.patch('/:channelID/:id'", "router.delete('/:channelID/:id'"]) {
        assert.match(handler(eventsub, start), /getAccess\(requesterID, channelIdStr, 'eventsubs:manage'\)/, start);
    }
    assert.match(route('bits-rules.route.ts'), /getEventsubAccess\(requester, channel, 'eventsubs:manage'\)/);
    assert.match(route('goals.route.ts'), /req\.method === 'GET' \? 'dashboard:view' : '\*'/);
    assert.match(route('roulette.route.ts'), /getChannelAccessContext\(req\.user\?\.id, req\.params\.channelID as string, '\*'\)/);
});

test('stream tools: permissions, kind, owner-only test alert, and no undo where Twitch cannot undo', () => {
    assert.deepEqual(streamTools.map((tool) => tool.name).sort(), Object.keys(STREAM_TOOL_PERMISSIONS).sort());
    for (const tool of streamTools) {
        assert.deepEqual([...tool.permissions], [...STREAM_TOOL_PERMISSIONS[tool.name]], tool.name);
        assert.equal(tool.kind, 'stream', tool.name);
    }
    const byName = new Map(streamTools.map((tool) => [tool.name, tool]));
    for (const name of ['send_test_alert', 'set_stream_info', 'create_poll', 'create_prediction']) assert.equal(byName.get(name)!.undo, undefined, name);
    for (const name of ['create_reward', 'update_reward']) assert.equal(typeof byName.get(name)!.undo, 'function', name);
    assert.match(route('overlay-studio.route.ts'), /req\.user\?\.id !== req\.params\.channelID/);
    const rewards = route('reward.route.ts');
    assert.match(handler(rewards, "router.post('/:channelID'"), /'rewards:manage'/);
    assert.match(handler(rewards, "router.patch('/:channelID/:id'"), /'rewards:manage'/);
});

test('get_settings reads with the permission of each area\'s GET route', () => {
    assert.deepEqual(settingsReadTools.map((tool) => [tool.name, [...tool.permissions], tool.kind]), [['get_settings', [], 'read']]);
    assert.deepEqual(SETTINGS_READ_PERMISSIONS, {
        tts: 'tts:view', moderation: 'moderation:view', follow_defense: 'moderation:view', ai_personality: 'ai:view',
        chat_events: 'eventsubs:view', goals: 'dashboard:view', bits_rules: 'eventsubs:view', roulettes: '*'
    });
    assert.match(route('speech.route.ts'), /permission: TtsAccessPermission = 'tts:view'/);
    assert.match(handler(route('moderation.route.ts'), "router.get('/:channelID/settings'"), /'moderation:view'/);
    assert.match(handler(route('aiPersonality.route.ts'), "router.get('/:channelID'"), /'ai:view'/);
    assert.match(handler(route('eventsub.route.ts'), "router.get('/:channelID'"), /getAccess\(requesterID, channelIdStr\);/);
    assert.match(readFileSync(new URL('../../../../utils/eventsub_access.ts', import.meta.url), 'utf8'), /permission: 'eventsubs:view' \| 'eventsubs:manage' = 'eventsubs:view'/);
});

test('names are unique snake_case, descriptions are written for the model, and forbidden actions do not exist', () => {
    const all = [...settingsTools, ...streamTools, ...settingsReadTools];
    assert.equal(new Set(all.map((tool) => tool.name)).size, all.length);
    for (const tool of all) {
        assert.match(tool.name, /^[a-z][a-z0-9_]*$/);
        assert.ok(tool.description.length > 120, `${tool.name} description`);
        assert.equal((tool.parameters as { type?: string }).type, 'object', tool.name);
        assert.doesNotMatch(tool.name, /(^|_)(ban|unban|timeout|raid|mod|vip|editor|editors|admin|admins|billing|account|bot)(_|$)/, tool.name);
        assert.ok(tool.label({} as never, 'es').length > 0);
    }
});
