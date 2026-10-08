import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';

let choice = 0, randomBound = 0;
mock.module('node:crypto', { namedExports: {
  randomBytes, randomUUID,
  randomInt: (upper: number) => { randomBound = upper; return choice % upper; },
} });
const domain = await import('./model.js');

test('every character style preserves its result for three seconds before the poll, including after reload', () => {
  for (const role of ['killer', 'survivor']) for (const characterDesign of ['cards', 'reel', 'wheel', 'elimination']) {
    let state = domain.initial();
    state.packId = `dbd-${role}-challenge`;
    state.config = domain.config({ ...state.config, characterDesign });
    domain.start(state, 1000);
    const draw = state.run!.draw!;
    assert.equal(draw.design, characterDesign);
    assert.equal(domain.settle(state, draw.endsAt - 1), false);
    assert(domain.settle(state, draw.endsAt));
    assert.equal(state.phase, 'character-result');
    const visible = domain.publicState(state);
    assert.equal(visible.phase, 'character-spin');
    assert.equal(visible.resultPhase, 'character-result');
    assert.equal(state.run!.characterId, draw.itemId);
    assert.equal(state.nextAt, draw.endsAt + 3000);
    assert.throws(() => domain.idle(state), { code: 'busy' });
    state = JSON.parse(JSON.stringify(state));
    assert.equal(domain.settle(state, draw.endsAt + 2999), false);
    assert.equal(state.run!.draw!.id, draw.id);
    assert(domain.settle(state, draw.endsAt + 3000));
    assert.equal(state.phase, 'poll-starting');
  }
});

test('each challenge perk result lasts three seconds before the next wheel or final loadout', () => {
  const state = domain.initial();
  domain.start(state, 1000);
  state.run!.cards = [0, 1, 2, 3, 4];
  domain.reveal(state, [0, 0, 0, 0, 1], 6000);
  assert.equal(domain.settle(state, 9499), false);
  domain.settle(state, 9500);
  for (let n = 1; n <= 4; n++) {
    const draw = state.run!.draw!;
    assert.equal(draw.kind, 'perk');
    assert.equal(draw.design, 'wheel');
    assert(!state.run!.perkIds.includes(draw.itemId));
    domain.settle(state, draw.endsAt);
    assert.equal(state.phase, 'perk-result');
    const visible = domain.publicState(state);
    assert.equal(visible.phase, 'perk-spin');
    assert.equal(visible.resultPhase, 'perk-result');
    assert.equal(state.run!.perkIds.length, n);
    assert.equal(state.nextAt, draw.endsAt + 3000);
    assert.equal(domain.settle(state, draw.endsAt + 2999), false);
    assert.equal(state.run!.draw!.id, draw.id);
    domain.settle(state, draw.endsAt + 3000);
    assert.equal(state.phase, n === 4 ? 'complete' : 'perk-spin');
  }
  assert.equal(new Set(state.run!.perkIds).size, 4);
});

test('partial poll ties can choose every tied card and exclude losing cards', () => {
  for (const [randomIndex, expectedCard] of [[0, 1], [1, 3]]) {
    const state = domain.initial(); domain.start(state, 1000);
    state.run!.cards = [0, 1, 2, 3, 4];
    choice = randomIndex;
    domain.reveal(state, [3, 12, 4, 12, 0], 2000);
    assert.equal(randomBound, 2);
    assert.equal(state.run!.winningCard, expectedCard);
    assert.equal(state.run!.perkCount, expectedCard);
  }
  choice = 0;
});

test('with no votes each of the five cards is eligible and a zero-perk reveal needs no spin', () => {
  for (let n = 0; n < 5; n++) {
    const state = domain.initial(); domain.start(state, 1000);
    state.run!.cards = [0, 1, 2, 3, 4]; choice = n;
    domain.reveal(state, [0, 0, 0, 0, 0], 2000);
    assert.equal(randomBound, 5);
    assert.equal(state.run!.winningCard, n);
    domain.settle(state, 5500);
    assert.equal(state.phase, n === 0 ? 'complete' : 'perk-spin');
  }
  choice = 0;
});

test('survivor can use a fixed character while killer retains the full sequence', () => {
  const state = domain.initial(), fixed = domain.pool({...state, packId: 'dbd-survivor-challenge'}, 'character')[0].id;
  state.config = domain.config({...state.config, sequences: {killer: domain.defaultSequence(), survivor: {...domain.defaultSequence(), character: false, fixedCharacterId: fixed}}});
  state.packId = 'dbd-survivor-challenge'; domain.start(state, 1000, 'challenge');
  assert.equal(state.phase, 'poll-starting'); assert.equal(state.run!.draw, null); assert.equal(state.run!.characterId, fixed);
  assert.equal(state.loadouts!.survivor.characterId, fixed);
  assert.equal(state.config.sequences!.killer.character, true);
  state.phase = 'complete'; state.nextAt = null; state.packId = 'dbd-killer-challenge'; domain.start(state, 2000, 'challenge');
  assert.equal(state.phase, 'character-spin'); assert.equal(domain.pack(state.packId).role, 'killer');
  assert.equal(state.loadouts!.survivor.characterId, fixed);
});

test('sequences can skip polls, perks, or both, with three-second result holds', () => {
  for (const character of [true,false]) for (const poll of [true,false]) for (const perks of [true,false]) for (const perkCount of [0,2,4]) {
    const state = domain.initial(), fixed = domain.pool(state,'character')[0].id;
    state.config.sequences!.killer = {character, fixedCharacterId: fixed, poll, perks, perkCount};
    domain.start(state, 1000, 'challenge');
    if (character) { domain.settle(state,state.nextAt!); assert.equal(state.phase,'character-result'); domain.settle(state,state.nextAt!); }
    assert.equal(state.phase,poll?'poll-starting':perks&&perkCount>0?'perk-spin':'complete');
    if (poll) { state.run!.cards=[0,1,2,3,4]; domain.reveal(state,[0,0,0,0,1],10000); domain.settle(state,13500); }
    const count = perks ? poll ? 4 : perkCount : 0;
    for (let i=0;i<count;i++) { assert.equal(state.phase,'perk-spin'); domain.settle(state,state.nextAt!); assert.equal(state.phase,'perk-result'); domain.settle(state,state.nextAt!); }
    assert.equal(state.phase,'complete'); assert.equal(state.run!.perkIds.length,count); assert.equal(new Set(state.run!.perkIds).size,count);
  }
});

test('standalone polls reveal without starting a wheel and individual draws share the loadout', () => {
  const state=domain.initial(); domain.start(state,1000,'characters'); domain.settle(state,state.nextAt!);
  const character=state.run!.characterId;
  domain.start(state,6000,'perks'); domain.settle(state,state.nextAt!); const perk=state.run!.perkIds[0];
  assert.equal(state.run!.characterId,character);
  domain.start(state,11000,'poll'); assert.equal(state.phase,'poll-starting'); assert.equal(state.run!.draw,null);
  state.run!.cards=[0,1,2,3,4]; domain.reveal(state,[0,0,0,0,100],12000); domain.settle(state,15500);
  assert.equal(state.phase,'complete'); assert.equal(state.run!.perkCount,4); assert.deepEqual(state.run!.perkIds,[perk]);
  assert.equal(state.loadouts!.killer.characterId,character);
  domain.start(state,16000,'perks'); domain.settle(state,state.nextAt!); assert.equal(state.run!.perkIds.length,2); assert.equal(new Set(state.run!.perkIds).size,2);
});

test('invalid cross-role fixed characters and malformed layout or sequence settings are rejected', () => {
  const state=domain.initial(), fixed=domain.pool(state,'character')[0].id;
  const invalid=[{...state.config,sequences:{killer:domain.defaultSequence(),survivor:{...domain.defaultSequence(),character:false,fixedCharacterId:fixed}}}, {...state.config,sequences:{killer:{...domain.defaultSequence(),character:false},survivor:domain.defaultSequence()}}, {...state.config,sequences:{killer:{...domain.defaultSequence(),poll:'yes'},survivor:domain.defaultSequence()}}, {...state.config,layout:{...domain.defaultLayout(),cameraWidth:801}}, {...state.config,layout:{...domain.defaultLayout(),cameraHeight:179}}, {...state.config,layout:{...domain.defaultLayout(),unexpected:true}}, {...state.config,targets:{killer:0,survivor:4}}];
  for (const config of invalid) assert.throws(()=>domain.config(config),{code:'invalid'});
  state.config.sequences!.killer={...domain.defaultSequence(),character:false,fixedCharacterId:fixed}; state.config.excludedIds=[fixed];
  assert.throws(()=>domain.start(state,1000,'challenge'),{code:'empty_pool'});
});

test('saved sequence settings are frozen in a run and legacy documents keep active draws', () => {
  const state=domain.initial(); domain.start(state,1000,'challenge'); const draw=state.run!.draw!;
  state.config.sequences!.killer.poll=false; assert.equal(state.run!.sequence!.poll,true);
  domain.settle(state,draw.endsAt); domain.settle(state,state.nextAt!); assert.equal(state.phase,'poll-starting');
  const legacy=domain.initial(); delete legacy.config.layout; delete legacy.config.sequences; delete legacy.config.targets; delete legacy.wins; delete legacy.loadouts;
  domain.start(legacy,1000); delete legacy.run!.operation; delete legacy.run!.sequence;
  const id=legacy.run!.draw!.id; domain.normalize(legacy); assert.equal(legacy.run!.draw!.id,id); assert.equal(legacy.packId,'dbd-killer-challenge');
  domain.settle(legacy,legacy.nextAt!); domain.settle(legacy,legacy.nextAt!); assert.equal(legacy.phase,'poll-starting');
});

test('legacy completed loadouts survive normalization before changing the current role', () => {
  const state=domain.initial();domain.start(state,1000,'characters');domain.settle(state,state.nextAt!);
  const character=state.run!.characterId;delete state.loadouts;domain.normalize(state);
  assert.equal(state.loadouts!.killer.characterId,character);
  assert.throws(()=>domain.layout({...domain.defaultLayout(),toString:'unknown'}),{code:'invalid'});
});
