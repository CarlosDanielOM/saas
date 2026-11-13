// Behaviour checks for Luna de Bits in the real Dima SDK frame (a page built by build.mts).
//   cd marketing && node widgets/luna-de-bits/preview/checks.mjs /tmp/luna-preview.html
import { chromium } from 'playwright';
const file = process.argv[2];
const browser = await chromium.launch();
const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) failures++; };
const goal = (patch) => Object.assign({ id: 'g1', source: 'dima', name: 'Meta de Bits', metric: 'bits', mode: 'total', target: 1000, current: 0, percent: 0, currency: null,
  twitchType: null, achieved: null, status: 'active', startsAt: 0, endsAt: null, windowSeconds: null, period: null }, patch);

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + file + query);
  await wait(400);
  const frame = page.frames().find(f => f !== page.mainFrame());
  // Count celebrations (supernova) and milestone ignitions from inside the frame.
  // The widget's top-level functions are globals of its classic script: wrap them to count calls.
  await frame.evaluate(() => {
    window.__count = { supernova: 0, ignite: 0 };
    const celebrate = window.celebrate, milestone = window.milestone;
    window.celebrate = function () { window.__count.supernova++; return celebrate.apply(this, arguments); };
    window.milestone = function () { window.__count.ignite++; return milestone.apply(this, arguments); };
  });
  const state = () => frame.evaluate(() => ({ current: document.getElementById('current').textContent, pct: document.getElementById('percent').textContent,
    reached: document.getElementById('sky').dataset.reached, note: document.getElementById('note').textContent, count: Object.assign({}, window.__count) }));
  return { page, frame, state, errors };
}

// 1. An already-complete goal that gets more Bits during its intro never celebrates again.
{
  const t = await open('?mode=live&goals=none');
  await t.page.evaluate(g => harness.goals([g]), goal({ current: 1000, status: 'reached' }));
  await wait(900);
  await t.page.evaluate(g => harness.goals([g]), goal({ current: 1001, status: 'reached' }));
  await wait(3500);
  const s = await t.state();
  ok(s.count.supernova === 0 && s.count.ignite === 0, 'complete goal + more bits during intro: no celebration', JSON.stringify(s));
  // 2. A new target that the total already passes: no celebration either.
  await t.page.evaluate(g => harness.goals([g]), goal({ current: 900, target: 2000 }));
  await wait(2500);
  await t.page.evaluate(g => harness.goals([g]), goal({ current: 900, target: 800, status: 'reached' }));
  await wait(2500);
  const s2 = await t.state();
  ok(s2.count.supernova === 0 && s2.reached === 'true', 'target lowered below the total: shows reached, no celebration', JSON.stringify(s2));
  // 3. More Bits on the same target crossing 100%: celebrates exactly once.
  await t.page.evaluate(g => harness.goals([g]), goal({ current: 700, target: 1000 }));
  await wait(2500);
  await t.page.evaluate(g => harness.goals([g]), goal({ current: 1000, target: 1000, status: 'reached' }));
  await wait(3500);
  const s3 = await t.state();
  ok(s3.count.supernova === 1, 'progress crosses 100% on the same target: one celebration', JSON.stringify(s3.count));
  ok(t.errors.length === 0, 'no errors (live)', JSON.stringify(t.errors));
  await t.page.close();
}

// 4. Test cheers don't leak into another goal; comets in flight are dropped.
{
  const t = await open('?mode=live&goals=none');
  await t.page.evaluate(g => harness.goals([g]), goal({ id: 'A', current: 100 }));
  await wait(2900);
  await t.page.evaluate(() => harness.alert(200, 'Tester', true));
  await wait(400);
  await t.page.evaluate(g => harness.goals([g]), goal({ id: 'B', current: 0, name: 'Otra meta' }));
  await wait(3500);
  const s = await t.state();
  ok(s.current === '0' && s.pct === '0%', 'goal switch drops the previous test cheer', JSON.stringify(s));
  // 5. Overlapping real cheers: the bar ends at the real total, milestones fire once each.
  await t.page.evaluate(g => harness.goals([g]), goal({ id: 'C', current: 200, target: 1000 }));
  await wait(3000);
  await t.page.evaluate(() => { harness.alert(150, 'Uno', false); setTimeout(() => harness.alert(400, 'Dos', false), 500); });
  await t.page.evaluate(g => setTimeout(() => harness.goals([g]), 1500), goal({ id: 'C', current: 350, target: 1000 }));
  await t.page.evaluate(g => setTimeout(() => harness.goals([g]), 2000), goal({ id: 'C', current: 750, target: 1000 }));
  await wait(6000);
  const s5 = await t.state();
  ok(s5.current === '750' && s5.count.ignite === 3 && s5.count.supernova === 0, 'overlapping cheers (20% to 75%): real total, 25/50/75% light once each', JSON.stringify(s5));
  ok(s5.note.includes('Dos') && s5.note.includes('400'), 'footer shows the latest cheer', s5.note);
  ok(t.errors.length === 0, 'no errors (switch/overlap)', JSON.stringify(t.errors));
  await t.page.close();
}

// 6. Studio example: test cheers expire and "Probar meta cumplida" can be replayed.
{
  const t = await open('?mode=editor&goals=none');
  await wait(4200);
  await t.page.evaluate(() => harness.button('testGoal'));
  await wait(5200);
  const a = await t.state();
  ok(a.reached === 'true' && a.count.supernova === 1, 'example: first finale', JSON.stringify(a));
  await t.page.evaluate(() => harness.button('testGoal'));
  await wait(6500);
  const b = await t.state();
  ok(b.reached === 'true' && b.count.supernova === 2, 'example: finale replays after the reset', JSON.stringify(b));
  await wait(21000);
  const c = await t.state();
  ok(c.current === '1,240' && c.reached === 'false', 'example: test progress expires after 20 s', JSON.stringify(c));
  ok(t.errors.length === 0, 'no errors (editor)', JSON.stringify(t.errors));
  await t.page.close();
}

// 7. A real goal that is already complete: the finale button still shows the celebration.
{
  const t = await open('?mode=editor&goals=none');
  await t.page.evaluate(g => harness.goals([g]), goal({ current: 1200, status: 'reached' }));
  await wait(3000);
  await t.page.evaluate(() => harness.button('testGoal'));
  await wait(1800);
  const s = await t.state();
  ok(s.count.supernova === 1, 'complete real goal: finale button celebrates', JSON.stringify(s.count));
  await t.page.close();
}
await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
