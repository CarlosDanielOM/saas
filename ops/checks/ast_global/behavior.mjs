import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { parseSpecialCommands } from '/app/dist/handlers/special_parser.handler.js';

const mongoose = createRequire('/app/package.json')('mongoose');

await mongoose.connect(process.env.MONGO_URI);
const redis = await getDragonflyClient('AST global behavior check');
const collection = mongoose.connection.db.collection('astvariables');

async function run(source, channelID, scopeType, scopeName, userId = 'viewer-id', userLogin = 'viewer') {
    const result = await parseSpecialCommands(source, { channelID, scopeType, scopeName,
        eventData: { user_id: userId, user_login: userLogin }, userPlan: 'pro' });
    return result.parsedText;
}

try {
    assert.equal(await run('%(*shield 5) %(**shield 2) %(#shield 9) %(##shield 3)', 'new-channel', 'redemption', 'Buy Shield'), '   ');
    for (const [type, name] of [['command', 'shields'], ['event', 'raid'], ['timer', 'daily']]) {
        assert.equal(await run('%(*shield) %(**shield) %(#shield) %(##shield)', 'new-channel', type, name), '5 2 9 3');
    }
    assert.equal(await run('%(*shield) %(**shield) %(#shield) %(##shield)', 'other-channel', 'command', 'shields'), '   ');
    assert.equal(await run('%(*shield) %(**shield) %(#shield) %(##shield)', 'new-channel', 'command', 'shields', 'other-id', 'other'), '5  9 ');
    assert.equal(await run('%(**shield(alice) 7) %(##shield(alice) 8)', 'new-channel', 'redemption', 'Buy Shield'), ' ');
    assert.equal(await run('%(**shield(alice)) %(##shield(alice))', 'new-channel', 'command', 'shields'), '7 8');
    assert.equal(await run('%(**shield) %(##shield)', 'new-channel', 'command', 'shields'), '2 3');

    const older = new Date('2025-01-01T00:00:00Z');
    const newer = new Date('2025-02-01T00:00:00Z');
    await collection.insertMany([
        { channelID: 'legacy-channel', scopeType: 'redemption', scopeName: 'Buy Shield', userId: 'viewer-id', userLogin: 'viewer', variables: { shield: '2', coins: '4' }, updatedAt: older },
        { channelID: 'legacy-channel', scopeType: 'command', scopeName: 'shields', userId: 'viewer-id', userLogin: 'viewer', variables: { shield: '5' }, updatedAt: newer }
    ]);
    assert.equal(await run('%(**shield) %(**coins)', 'legacy-channel', 'event', 'raid'), '5 4');

    const script = '/app/dist/scripts/migrate_ast_variables_global.script.js';
    const env = { ...process.env, NODE_OPTIONS: '' };
    for (const args of [[], ['--apply']]) {
        const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    const global = await collection.findOne({ channelID: 'legacy-channel', scopeType: 'global', scopeName: 'global', userId: 'viewer-id' });
    assert.equal(global.variables.shield, '5');
    assert.equal(global.variables.coins, '4');
    assert.equal(await run('%(**shield) %(**coins)', 'legacy-channel', 'command', 'shields'), '5 4');
    assert.equal(await run('%del(**shield)', 'legacy-channel', 'event', 'raid'), '');
    assert.equal(await run('%(**shield)', 'legacy-channel', 'redemption', 'Buy Shield'), '');

    console.log('AST channel/user storage, cross-entry reads, newest legacy value, migration, and deletion passed');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    // This check runs in a disposable container; stop its process even if a
    // library keeps background timers alive after all assertions finish.
    redis.destroy();
    process.exit(process.exitCode || 0);
}
