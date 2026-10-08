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
