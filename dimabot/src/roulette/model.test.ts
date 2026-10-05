import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from './model.js';

function fixture() {
  const state = r.emptyState(); const roulette = r.create({ name: 'Giveaway', alias: 'giveaways', design: 'reel' });
  state.roulettes.push(roulette); state.activeId = roulette.id;
  r.add(roulette, { label: 'VIP', multiplier: 3, weight: 10 });
  r.add(roulette, { label: 'Game', weight: 1 });
  return { state, roulette };
}
test('copies have stable identities, weight changes odds without creating copies', () => {
  const { state, roulette } = fixture(); const copies = r.slots(roulette);
  assert.equal(copies.length, 4); assert.equal(new Set(copies.map(s => s.key)).size, 4);
  const counts = new Map<string, number>();
  for (let ticket = 0; ticket < 31; ticket++) {
    const draw = r.start(structuredClone(state), structuredClone(roulette), 0, () => ticket);
    counts.set(draw.winner.key, (counts.get(draw.winner.key) ?? 0) + 1);
  }
  assert.deepEqual([...counts.values()], [10, 10, 10, 1]);
  const order = [...roulette.order]; r.updateItem(roulette, roulette.items[0].id, { weight: 20 });
  assert.deepEqual(roulette.order, order);
});
test('shuffle and random insertion preserve copies and survivor ordering', () => {
  const { roulette } = fixture(); const original = [...roulette.order]; r.shuffle(roulette.order, () => 0);
  assert.notDeepEqual(roulette.order, original); assert.deepEqual([...roulette.order].sort(), [...original].sort());
  const survivors = [...roulette.order]; roulette.settings.insertion = 'random';
  const item = r.add(roulette, { label: 'New', multiplier: 3 }, () => 0);
  assert.deepEqual(roulette.order.filter(k => !item.copies.includes(k)), survivors);
  assert.equal(roulette.order.length, 7);
});
test('frozen draw survives edits and removes only its winning copy exactly once', () => {
  const { state, roulette } = fixture(); roulette.settings.winnerAction = 'remove-copy'; roulette.settings.hideAfterSeconds = 2;
  const draw = r.start(state, roulette, 1000, () => 10); const winner = draw.winner.key;
  r.updateItem(roulette, roulette.items[0].id, { multiplier: 4, weight: 20 });
  assert.equal(draw.slots.length, 4); assert.equal(draw.winner.weight, 10);
  assert.throws(() => r.start(state, roulette, 1100));
  assert.equal(r.settle(state, 4999), false); assert.equal(r.settle(state, 5000), true);
  assert.equal(roulette.items[0].multiplier, 3); assert(!roulette.order.includes(winner));
  assert.equal(state.history.length, 1); assert.equal(r.settle(state, 5001), false);
  assert.equal(state.visible, true); r.settle(state, 7000); assert.equal(state.visible, false);
  assert.equal(state.history.length, 1);
});
test('winner removal tolerates manually deleted entries and preserves the snapshot', () => {
  const { state, roulette } = fixture(); roulette.settings.winnerAction = 'remove-item';
  const draw = r.start(state, roulette, 0, () => 0); r.remove(roulette, draw.winner.itemId);
  r.settle(state, 4000); assert.equal(state.history[0].winner.label, 'VIP'); assert.equal(roulette.items.length, 1);
});
test('validates limits, numeric overflow, aliases and configuration', () => {
  for (const multiplier of [0, -1, 1.5, Infinity, 10001]) assert.throws(() => r.add(fixture().roulette, { label: 'Bad', multiplier }));
  assert.throws(() => r.add(fixture().roulette, { label: 'Big', weight: Number.MAX_SAFE_INTEGER }));
  assert.throws(() => r.add(fixture().roulette, { label: 'Big', multiplier: 57 }));
  assert.throws(() => r.create({ name: 'A', alias: 'bad alias' }));
  assert.throws(() => r.configure(fixture().roulette, { settings: { showOnStart: 'false' } }));
  const wheel = r.create({ name: 'Wheel', alias: 'wheel' }); r.add(wheel, { label: 'A', multiplier: 61 });
  assert.throws(() => r.configure(wheel, { design: 'reel' }));
});
test('duplicate merging is explicit and rejects ambiguous weight changes', () => {
  const { roulette } = fixture(); roulette.settings.duplicate = 'increase';
  const id = roulette.items[0].id; const item = r.add(roulette, { label: 'VIP', multiplier: 2, weight: 10 });
  assert.equal(item.id, id); assert.equal(item.multiplier, 5);
  assert.throws(() => r.add(roulette, { label: 'VIP', weight: 2 }));
});
test('item scripts are optional, editable, bounded and never expanded into visual copies', () => {
  const { roulette } = fixture();
  const item = r.add(roulette, { label: 'Silence', multiplier: 3, action: '$(timer 300 Done)' });
  assert.equal(item.action, '$(timer 300 Done)');
  assert(r.slots(roulette).every(slot => !('action' in slot)));
  r.updateItem(roulette,item.id,{ action:'' }); assert.equal(item.action,'');
  assert.throws(() => r.updateItem(roulette,item.id,{action:'a'.repeat(8001)}));
  assert.throws(() => r.updateItem(roulette,item.id,{action:5}));
  roulette.settings.duplicate='increase';r.updateItem(roulette,item.id,{action:'$(timer 30 Done)'});
  assert.throws(()=>r.add(roulette,{label:'Silence',action:'different'}));
  r.add(roulette,{label:'Silence'});assert.equal(item.action,'$(timer 30 Done)');
});
test('last-one-standing design is accepted and holds up to 100 copies', () => {
  const r_roulette = r.create({ name: 'Royale', alias: 'royale' });
  r.configure(r_roulette, { design: 'elimination' }); assert.equal(r_roulette.design, 'elimination');
  r.add(r_roulette, { label: 'Viewer', multiplier: 100 });
  assert.throws(() => r.add(r_roulette, { label: 'One more' }));
  assert.throws(() => r.configure(r_roulette, { design: 'reel' }));
  assert.throws(() => r.configure(r_roulette, { design: 'plinko' }));
});
