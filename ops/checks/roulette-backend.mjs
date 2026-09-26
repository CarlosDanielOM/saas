// Actual service entrypoints run against disposable Mongo/Redis and provider fixtures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const require = createRequire('/app/package.json');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const svc = await import('/app/dist/roulette/service.js');
const { parse } = await import('/app/dist/utils/ast_parser/parser.js');
const { createExecutionContext, evaluate } = await import('/app/dist/utils/ast_parser/evaluator.js');
const { registerAllFunctions } = await import('/app/dist/utils/ast_parser/functions/index.js');
const mongo = await getMongoDBConnection('roulette-check');
const redis = await getDragonflyClient('roulette-check');
await svc.RouletteChannel.init();
await redis.set('app:twitch:token','fixture-app-token');
const channel = '990011';
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: channel }], plan_tier: 'pro' });
await redis.hSet('token:roulette-owner-test', { id: channel, login: 'fixture', display_name: 'Fixture' });
await redis.hSet('token:roulette-other-test', { id: '990012', login: 'other', display_name: 'Other' });
let base = 'http://127.0.0.1:3000';
let testServer, io;
if (process.env.SAAS_TARGET !== 'api') {
  if (process.env.SAAS_TARGET === 'bot') {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; } catch {}
      if (ready) break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert(ready, 'actual bot entrypoint ready');
  }
  const express = require('express');
  const { rouletteRoute } = await import('/app/dist/server/routes/roulette.route.js');
  const { registerRouletteOverlay } = await import('/app/dist/server/services/roulette-overlay.service.js');
  const app = express(); app.use(express.json()); app.use('/roulettes', rouletteRoute);
  testServer = createServer(app); io = new (require('socket.io').Server)(testServer, { connectionStateRecovery: {} }); registerRouletteOverlay(io);
  await new Promise(resolve => testServer.listen(3210, '127.0.0.1', resolve)); base = 'http://127.0.0.1:3210';
}
const root = `/roulettes/${channel}`;
async function request(method, path, body, status = 200, token = 'roulette-owner-test', extra = {}) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result.data;
}
await request('GET', root, undefined, 401, '');
await request('GET', root, undefined, 403, 'roulette-other-test');
const created = await request('POST', root + '/roulettes', { name: 'Giveaways', alias: 'giveaways', design: 'reel', durationSeconds: 1, settings: { winnerAction: 'remove-copy', hideAfterSeconds: 1 } });
const id = created.result; const path = root + '/roulettes/' + id;
await request('POST', root + '/roulettes', { name: 'Duplicate', alias: 'giveaways' }, 409);
const added = await request('POST', path + '/items', { label: 'VIP (day 2)', multiplier: 3, weight: 10 }, 200, 'roulette-owner-test', { 'Idempotency-Key': 'add-once' });
const repeated = await request('POST', path + '/items', { label: 'VIP (day 2)', multiplier: 3, weight: 10 }, 200, 'roulette-owner-test', { 'Idempotency-Key': 'add-once' });
assert.equal(repeated.result, added.result); assert(repeated.replayed);
await request('POST', path + '/items', { label: 'Different' }, 409, 'roulette-owner-test', { 'Idempotency-Key': 'add-once' });
await request('POST', path + '/items', { label: 'Bad', multiplier: 0 }, 400);
await request('POST', path + '/items', { label: 'Bad', multiplier: null }, 400);
await request('POST', path + '/items', { label: 'Huge', multiplier: 58 }, 400);
let state = await request('GET', root); assert.equal(state.roulettes[0].order.length, 3);
await request('PATCH', path, { name: 'Stale' }, 409, 'roulette-owner-test', { 'If-Match': '0' });
const concurrent = await Promise.all(Array.from({ length: 10 }, (_, i) => svc.execute(channel, { operation: 'add', roulette: id, data: { label: `Concurrent ${i}` } }, `concurrent-${i}`)));
assert.equal(new Set(concurrent.map(r => r.result)).size, 10);
state = await svc.snapshot(channel); assert.equal(state.roulettes[0].order.length, 13);
assert.equal(await svc.authorizeOverlay(channel, 'wrong'), false);
const token = (await request('POST', root + '/overlay-token', {})).token;
const overlay = await request('GET', root + '/overlay', undefined, 200, token);
assert.equal(overlay.roulette.id, id); assert.equal(overlay.tokenHash, undefined); assert.equal(overlay.roulettes, undefined);
await request('POST', path + '/items', { label: 'Unauthorized' }, 401, '');
assert.equal(await svc.authorizeOverlay('990012', token), false);

// Use the Engine.IO websocket transport directly, avoiding another test dependency.
async function connectOverlay(token, recovery = {}) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
  const messages = []; let closed = false;
  const namespace = `/overlays/roulette/${channel}`;
  ws.addEventListener('close', () => { closed = true; });
  ws.addEventListener('message', event => {
    const data = String(event.data);
    if (data.startsWith('0')) ws.send(`40${namespace},${JSON.stringify({ token, ...recovery })}`);
    else if (data === '2') ws.send('3');
    else messages.push(data);
  });
  async function wait(predicate) {
    for (let i = 0; i < 100; i++) {
      const match = messages.find(predicate); if (match) return match;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Websocket timeout: ' + JSON.stringify(messages));
  }
  const states = () => messages.filter(m => m.startsWith(`42${namespace},`)).map(m => JSON.parse(m.slice(m.indexOf(',') + 1))).filter(e => e[0] === 'roulette-state').map(e => e[1]);
  return { ws, wait, states, closed: () => closed };
}
const invalidSocket = await connectOverlay('bad'); await invalidSocket.wait(m => m.startsWith('44')); invalidSocket.ws.close();
const socket = await connectOverlay(token); await socket.wait(m => m.includes('roulette-state'));
const recoverySocket = await connectOverlay(token);
const connectionPacket = await recoverySocket.wait(m => m.startsWith('40'));
const statePacket = await recoverySocket.wait(m => m.includes('roulette-state'));
const recovery = { pid: JSON.parse(connectionPacket.slice(connectionPacket.indexOf(',') + 1)).pid,
  offset: JSON.parse(statePacket.slice(statePacket.indexOf(',') + 1)).at(-1) };
recoverySocket.ws.close();
await request('POST', root + '/actions/show', {});
const starts = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => svc.execute(channel, { operation: 'start', roulette: id }, `start-${i}`)));
assert.equal(starts.filter(r => r.status === 'fulfilled').length, 1, 'only one simultaneous start wins');
state = await svc.snapshot(channel); const draw = state.draw; assert.equal(draw.slots.length, 13);
await request('POST', root + '/actions/switch', { roulette: id }, 409);
await request('PATCH', path, { design: 'wheel' }, 409);
await request('POST', root + '/actions/hide', {});
await request('POST', path + '/items', { label: 'Next round' });
const reconnect = await connectOverlay(token); await reconnect.wait(m => m.includes('roulette-state'));
assert.equal(reconnect.states().at(-1).draw.id, draw.id);
assert.equal(reconnect.states().at(-1).draw.slots.length, 13);
await new Promise(resolve => setTimeout(resolve, 2200));
await svc.settleDue();
state = await svc.snapshot(channel); assert.equal(state.history.length, 1); assert.equal(state.visible, false);
assert.equal(state.roulettes[0].order.length, 13, 'one added and exactly one winning copy removed');
await svc.settleDue(); assert.equal((await svc.snapshot(channel)).history.length, 1);
const acceptedIndex = starts.findIndex(r => r.status === 'fulfilled');
const replay = await svc.execute(channel, { operation: 'start', roulette: id }, `start-${acceptedIndex}`);
assert.equal(replay.result, draw.id); assert(replay.replayed, 'retry after completion cannot reroll');
await request('POST', root + '/overlay-token', {});
await request('GET', root + '/overlay', undefined, 401, token);
await socket.wait(m => m.startsWith('41')); socket.ws.close(); reconnect.ws.close();
const revokedRecovery = await connectOverlay(token, recovery);
await revokedRecovery.wait(m => m.startsWith('44'));
assert.equal(revokedRecovery.states().length, 0, 'recovery must not bypass revoked-token authentication');
revokedRecovery.ws.close();

registerAllFunctions();
async function ast(source, restricted = false) {
  const ctx = createExecutionContext(); ctx.broadcasterId = channel; ctx.enforceFunctionPermissions = restricted; ctx.userLevel = 1;
  const parsed = parse(source); assert.equal(parsed.error, undefined); return (await evaluate(parsed.ast, ctx)).value;
}
assert.match(String(await ast('$(roulette.add giveaways "Quoted item 42" 2 5)', true)), /permission denied/);
const astItem = await ast('$(roulette.add giveaways "Quoted item 42" 2 5)');
state = await svc.snapshot(channel); const found = state.roulettes[0].items.find(i => i.id === astItem);
assert.equal(found.label, 'Quoted item 42'); assert.equal(found.multiplier, 2); assert.equal(found.weight, 5);
assert.match(String(await ast('$(roulette.add giveaways "Bad" 0)')), /^Error:/);
assert.equal(await ast(`$(roulette.update giveaways ${astItem} 3 7)`), '');
await ast('$(roulette.shuffle giveaways)');
assert.equal(await ast(`$(roulette.remove giveaways ${astItem})`), '');
assert(!(await svc.snapshot(channel)).roulettes[0].items.some(i => i.id === astItem));
assert.equal(await ast('$(roulette.result giveaways)'), draw.winner.label);
await ast('$(roulette.hide)'); await ast('$(roulette.show)');
await ast('$(roulette.switch giveaways)');
assert.equal(await ast('$(roulette.start giveaways)'), '');
assert.match(String(await ast('$(roulette.start giveaways)')), /spinning/);
assert.equal((await svc.snapshot('990012')).roulettes.length, 0, 'channel isolation');
await assert.rejects(() => svc.execute('990012', { operation: 'remove', roulette: id, itemId: added.result }));

// A new service process recovers the same durable in-flight draw.
const beforeRestart = (await svc.snapshot(channel)).draw.id;
const { execFileSync } = await import('node:child_process');
const child = execFileSync('node', ['--input-type=module', '-e', `import {snapshot} from '/app/dist/roulette/service.js'; console.log('DRAW='+(await snapshot('${channel}')).draw.id); process.exit(0);`], { encoding: 'utf8' });
assert(child.includes('DRAW=' + beforeRestart));
// Prove the completion worker works without readers or an OBS connection.
const workerChannel = '990014';
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: workerChannel }], plan_tier: 'pro' });
await svc.execute(workerChannel, { operation: 'create', data: { name: 'Worker', alias: 'worker', durationSeconds: 1, settings: { winnerAction: 'remove-item' } } });
await svc.execute(workerChannel, { operation: 'add', roulette: 'worker', data: { label: 'Only' } });
await svc.execute(workerChannel, { operation: 'start', roulette: 'worker' });
await Users.updateOne({ 'accounts.id': workerChannel }, { $set: { plan_tier: 'free' } });
await new Promise(resolve => setTimeout(resolve, 2200));
if (process.env.SAAS_TARGET !== 'cron') execFileSync('node', ['/app/dist/workers/roulette.worker.js', '--once'], { encoding: 'utf8' });
const workerState = await svc.RouletteChannel.findById(workerChannel).lean();
assert.equal(workerState.state.history.length, 1, 'worker completes independently of clients');
assert.equal(workerState.state.roulettes[0].items.length, 0);
// Multiple saved roulettes share one active overlay without losing either list.
const second = (await request('POST', root + '/roulettes', { name: 'Second', alias: 'second', design: 'wheel' })).result;
const secondPath = root + '/roulettes/' + second;
await request('POST', secondPath + '/items', { label: 'Many', multiplier: 61 });
await request('PATCH', secondPath, { design: 'reel' }, 400);
assert.equal((await svc.snapshot(channel)).roulettes.find(r => r.id === second).design, 'wheel');
await request('PATCH', secondPath, { design: 'cards', cardSize: 'small', settings: { insertion: 'random' } });
const beforeOrder = (await svc.snapshot(channel)).roulettes.find(r => r.id === second).order;
const randomItemId = (await request('POST', secondPath + '/items', { label: 'Inserted', multiplier: 3 })).result;
const secondState = (await svc.snapshot(channel)).roulettes.find(r => r.id === second);
const newKeys = secondState.items.find(i => i.id === randomItemId).copies;
assert.deepEqual(secondState.order.filter(key => !newKeys.includes(key)), beforeOrder);
await request('POST', root + '/actions/show', {});
await request('POST', root + '/actions/switch', { roulette: 'second' });
state = await svc.snapshot(channel); assert.equal(state.visible, true); assert.equal(state.activeId, second); assert.equal(state.draw, null);
await request('DELETE', secondPath);
state = await svc.snapshot(channel); assert.equal(state.activeId, null); assert.equal(state.visible, false); assert.equal(state.roulettes.length, 1);
assert.equal(state.roulettes[0].id, id);
await request('POST', root + '/actions/start', {}, 404);
await request('POST', root + '/actions/switch', { roulette: id });

// Pro-only Alpha across API, AST and existing overlay connections (no roulette revision change).
const currentToken = (await request('POST', root + '/overlay-token', {})).token;
const downgradeSocket = await connectOverlay(currentToken); await downgradeSocket.wait(m => m.includes('roulette-state'));
const beforeDowngrade = (await svc.snapshot(channel)).revision;
for (const tier of ['free', 'premium']) {
  await Users.updateOne({ 'accounts.id': channel }, { $set: { plan_tier: tier } });
  await request('GET', root, undefined, 403);
  await request('POST', root + '/roulettes', { name:'Denied', alias:'denied' }, 403);
  await request('POST', root + '/overlay-token', {}, 403);
  await request('GET', root + '/overlay', undefined, 401, currentToken);
  await assert.rejects(() => svc.execute(channel, { operation:'show' }), e => e.code === 'pro_required');
  assert.equal(await svc.authorizeOverlay(channel, currentToken), false);
  assert.match(String(await ast('$(roulette.result giveaways)')), /requires Pro/);
  assert.match(String(await ast('$(roulette.add giveaways "Denied")')), /requires Pro/);
}
await downgradeSocket.wait(m => m.startsWith('41')); downgradeSocket.ws.close();
assert.equal((await svc.snapshot(channel)).revision, beforeDowngrade, 'denied access does not mutate data');
await Users.updateOne({ 'accounts.id': channel }, { $set: { plan_tier: 'pro' } });
assert.equal((await request('GET', root)).roulettes[0].id, id, 'upgrading preserves saved data');

// Item actions run on the server, with frozen scripts/identities and one persisted claim.
const actions = await import('/app/dist/roulette/actions.js');
const { readFileSync } = await import('node:fs');
await redis.hSet(`accounts:twitch:${channel}:data`, {id:channel,name:'fixture',plan_tier:'pro'});
const messages = () => { try { return readFileSync('/tmp/saas-fixtures/roulette-messages.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
async function until(predicate) { for(let i=0;i<120;i++) { if(await predicate()) return; await new Promise(r=>setTimeout(r,100)); } throw new Error('Action check timed out'); }
const { AstTimerScheduler } = await import('/app/dist/utils/ast_timer_runtime.js');
const timerScheduler = process.env.SAAS_TARGET === 'bot' ? null : new AstTimerScheduler(redis);
await timerScheduler?.start();
const automation = (await request('POST',root+'/roulettes',{name:'Actions',alias:'actions',durationSeconds:1,settings:{winnerAction:'remove-item'}})).result;
const automationPath = root+'/roulettes/'+automation;
await request('POST',automationPath+'/items',{label:'Invalid',action:'$(timer 2'},400);
const actionItem=(await request('POST',automationPath+'/items',{label:'Silence',multiplier:3,action:'ROULETTE_TEST_START $(user) $(timer 1 ROULETTE_TEST_END $(user))'})).result;
await request('POST',root+'/actions/start',{roulette:automation,user:'not found!'},400);
await request('POST',root+'/actions/start',{roulette:automation,user:'missing'},400);
const spin = await request('POST',root+'/actions/start',{roulette:automation,user:'@punished'},200,'roulette-owner-test',{'Idempotency-Key':'action-start'});
await request('PATCH',automationPath+'/items/'+actionItem,{action:'ROULETTE_TEST_CHANGED'});
const publicState = await svc.overlaySnapshot(channel);
assert(!JSON.stringify(publicState).includes('ROULETTE_TEST'), 'private AST never reaches OBS');
await new Promise(r=>setTimeout(r,1200));
if(process.env.SAAS_TARGET !== 'cron') execFileSync('node',['/app/dist/workers/roulette-actions.worker.js','--once'],{encoding:'utf8'});
await until(()=>messages().some(m=>m.message.includes('ROULETTE_TEST_END')));
assert.equal(messages().filter(m=>m.message.includes('ROULETTE_TEST_START')).length,1,'one action for three winning copies');
assert(messages().filter(m=>/START|END/.test(m.message)).every(m=>m.message.includes('Punished')),'timer retains selected user');
assert(!messages().some(m=>m.message.includes('CHANGED')),'draw freezes script');
assert.equal((await svc.snapshot(channel)).roulettes.find(r=>r.id===automation).items.length,0,'winner removal does not lose action');
const replayAction = await request('POST',root+'/actions/start',{roulette:automation,user:'@punished'},200,'roulette-owner-test',{'Idempotency-Key':'action-start'});
assert.equal(replayAction.result,spin.result);assert(replayAction.replayed);
await actions.runDueActions();assert.equal(messages().filter(m=>m.message.includes('START')).length,1);
assert.equal((await svc.snapshot(channel)).actionRuns.find(a=>a.drawId===spin.result).status,'done');
// Events enter through the ordinary AST parser, preserving their actor.
await request('POST',automationPath+'/items',{label:'Event',action:'ROULETTE_TEST_EVENT $(user)'});
const { parseSpecialCommands } = await import('/app/dist/handlers/special_parser.handler.js');
const eventStart = await parseSpecialCommands('$(roulette.start actions)',{channelID:channel,scopeType:'event',eventData:{user_id:'990098',user_login:'eventuser',user_name:'EventUser'}});
assert.equal(eventStart.parsedText,'');
await new Promise(r=>setTimeout(r,1200));
if(process.env.SAAS_TARGET !== 'cron') execFileSync('node',['/app/dist/workers/roulette-actions.worker.js','--once'],{encoding:'utf8'});
await until(()=>messages().some(m=>m.message.includes('ROULETTE_TEST_EVENT EventUser')));
// A claim survives crashes/restarts; competing consumers cannot replay an arbitrary side effect.
await request('PATCH',automationPath,{durationSeconds:120});
await request('POST',automationPath+'/items',{label:'Claim',action:'ROULETTE_TEST_NEVER'});
await request('POST',root+'/actions/start',{roulette:automation});
const claims=await Promise.all(Array.from({length:8},()=>actions.claimAction(channel,Date.now()+121000)));
assert.equal(claims.filter(Boolean).length,1);
assert.equal(claims.find(Boolean).actor.userId,channel,'dashboard defaults to streamer');
execFileSync('node',['/app/dist/workers/roulette-actions.worker.js','--once'],{encoding:'utf8'});
assert(!messages().some(m=>m.message.includes('NEVER')));
// Downgrades skip queued actions; delivery failures remain failed without automatic retries.
await Users.updateOne({'accounts.id':workerChannel},{$set:{plan_tier:'pro'}});
await redis.hSet(`accounts:twitch:${workerChannel}:data`,{id:workerChannel,name:'fixtureworker',plan_tier:'pro'});
await svc.execute(workerChannel,{operation:'add',roulette:'worker',data:{label:'Skip',action:'ROULETTE_TEST_SKIPPED'}});
const skipDraw=await svc.execute(workerChannel,{operation:'start',roulette:'worker'});
await Users.updateOne({'accounts.id':workerChannel},{$set:{plan_tier:'free'}});
await new Promise(r=>setTimeout(r,1200));
await actions.runDueActions();
await until(async()=> (await svc.snapshot(workerChannel)).actionRuns.find(a=>a.drawId===skipDraw.result)?.status==='skipped');
assert(!messages().some(m=>m.message.includes('SKIPPED')));
await Users.updateOne({'accounts.id':workerChannel},{$set:{plan_tier:'pro'}});
await svc.execute(workerChannel,{operation:'add',roulette:'worker',data:{label:'Fail',action:'ROULETTE_TEST_FAIL'}});
const failDraw=await svc.execute(workerChannel,{operation:'start',roulette:'worker'});
await new Promise(r=>setTimeout(r,1200));
await actions.runDueActions();
await until(async()=> (await svc.snapshot(workerChannel)).actionRuns.find(a=>a.drawId===failDraw.result)?.status==='failed');
await actions.runDueActions();assert.equal(messages().filter(m=>m.message.includes('ROULETTE_TEST_FAIL')).length,1);
timerScheduler?.stop();
console.log(`PASS ${process.env.SAAS_TARGET}: persistence, CAS concurrency, API ownership, validation, idempotency, frozen draws, completion, WebSocket reconnect/revocation and real AST parsing/permissions`);
if (io) await new Promise(resolve => io.close(resolve));
await redis.quit(); await mongo.disconnect(); process.exit(0);
