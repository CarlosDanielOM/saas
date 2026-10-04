// Use disposable Mongo/Redis and ops/checks/keywords-fixtures provider mocks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { createTimer, editTimer, deleteTimer } from '/app/dist/commands/timer_manager.command.js';
import { CustomTimerSchema } from '/app/dist/schemas/custom_timer.schema.js';

const unit = spawnSync(process.execPath, ['--test', 'dist/utils/timer_policy.test.js'], { encoding: 'utf8' });
assert.equal(unit.status, 0, unit.stdout + unit.stderr);
const mongo = await getMongoDBConnection('timer-intervals-check');
const redis = await getDragonflyClient('timer-intervals-check');
if (process.env.SAAS_TARGET === 'bot') {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch('http://127.0.0.1:3333/eventsub', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })).status === 403; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'actual bot entrypoint ready');
}
for (const [tier, allowed, rejected] of [
  ['free', [10, 20, 30, 40, 50, 60], [5, 15, 25, 45, 55, 70, 10.5]],
  ['premium', [5, 15, 45, 175, 180], [1, 7, 185]],
  ['pro', [1, 7, 15, 45, 180], [0, 7.5, 181]]
]) {
  const channelID = `timer-intervals-${tier}`;
  await redis.hSet(`accounts:twitch:${channelID}:data`, { id: channelID, name: channelID, plan_tier: tier });
  await redis.sAdd('timer:active', channelID);
  for (const minutes of allowed) {
    const created = await createTimer(channelID, 'boundary', minutes, 'Fixture only');
    assert.equal(created.status, 201, JSON.stringify(created));
    assert.equal(created.timer.frequency, minutes);
    assert.equal(created.timer.frequencyUnit, 'minutes');
    const cached = JSON.parse(await redis.hGet(`timer:channel:${channelID}:timers`, String(created.timer._id)));
    assert.equal(cached.frequency, minutes, 'runtime cache uses exact minutes');
    const edited = await editTimer(channelID, 'boundary', minutes, 'Edited fixture');
    assert.equal(edited.status, 200, JSON.stringify(edited));
    assert.equal(edited.timer.frequency, minutes);
    assert.equal((await deleteTimer(channelID, 'boundary')).status, 200);
  }
  for (const minutes of rejected) {
    assert.equal((await createTimer(channelID, 'rejected', minutes, 'Fixture only')).status, 400);
    assert.equal(await CustomTimerSchema.countDocuments({ channelID, name: 'rejected' }), 0);
  }
  const created = await createTimer(channelID, 'editing', allowed[0], 'Original');
  assert.equal(created.status, 201);
  assert.equal((await editTimer(channelID, 'editing', rejected[0], 'Rejected')).status, 400);
  const saved = await CustomTimerSchema.findOne({ channelID, name: 'editing' });
  assert.equal(saved.frequency, allowed[0]);
  assert.equal(saved.message, 'Original', 'rejected edit preserves persisted timer');
  await deleteTimer(channelID, 'editing');
}
for (const frequency of [15, 45]) {
  const timer = await CustomTimerSchema.create({ channelID: 'timer-intervals-free', channel: 'fixture',
    name: `old${frequency}`, frequency, frequencyUnit: 'minutes', message: 'Old timer', active: true });
  assert.equal((await editTimer(timer.channelID, timer.name, undefined, 'Rejected')).status, 400);
  assert.equal((await editTimer(timer.channelID, timer.name, 10, 'Updated')).status, 200);
}
await mongo.connection.close();
await redis.quit();
console.log('PASS: Free ten-minute options, unchanged paid tiers, create/edit persistence and runtime cache, invalid intervals and grandfathered edits');
process.exit(0);
