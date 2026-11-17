// Behaviour checks for Encuesta Polar in the real Dima SDK frame (a page built by build.mts).
//   cd marketing && node widgets/encuesta-polar/preview/checks.mjs /path/to/preview.html
import { chromium } from 'playwright';
const file = process.argv[2];
if (!file) throw new Error('usage: checks.mjs <preview.html>');
const browser = await chromium.launch();
const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) failures++; };
const iso = ms => new Date(ms).toISOString();
const poll = patch => Object.assign({ kind: 'poll', id: 'p1', title: '¿Qué jugamos?', phase: 'active', startedAt: iso(Date.now() - 10000), deadline: iso(Date.now() + 60000),
  endedAt: null, winnerId: null, occurredAt: iso(Date.now()), receipt: 'r1', revision: 1,
  choices: [{ id: 'a', title: 'Celeste', votes: 0 }, { id: 'b', title: 'Hades', votes: 0 }, { id: 'c', title: 'Tetris', votes: 0 }] }, patch);

async function open(query, size) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + file + query);
  if (size) await page.evaluate(([w, h]) => harness.size(w, h), size);
  await wait(500);
  const frame = page.frames().find(f => f !== page.mainFrame());
  // The widget's top-level functions are globals of its classic script: wrap celebrate() to count celebrations.
  await frame.evaluate(() => {
    window.__count = { celebrate: 0 };
    const celebrate = window.celebrate;
    window.celebrate = function () { window.__count.celebrate++; return celebrate.apply(this, arguments); };
  });
  const state = () => frame.evaluate(() => {
    const stage = document.getElementById('stage');
    const rows = [...document.querySelectorAll('.choice')].map(li => ({ name: li.querySelector('.choice__name').textContent, pct: li.querySelector('.choice__pct').textContent,
      votes: li.querySelector('.choice__votes').textContent, lead: li.classList.contains('lead'), win: li.classList.contains('win'), lose: li.classList.contains('lose') }));
    return { state: stage.dataset.state, phase: stage.dataset.phase, mood: stage.dataset.mood, cols: stage.dataset.cols, title: document.getElementById('title').textContent,
      eyebrow: document.getElementById('eyebrow').textContent, note: document.getElementById('note').textContent, total: document.getElementById('total').textContent,
      clock: document.getElementById('clock').textContent, rows, celebrations: window.__count.celebrate, floaters: document.querySelectorAll('.floater').length };
  });
  // Uncaught errors, and errors the widget caught and reported with console.error.
  const logs = () => page.evaluate(() => window.__logs.filter(m => m.type === 'error' || m.level === 'error').map(m => m.message || JSON.stringify(m.args)));
  return { page, frame, state, errors, logs };
}
const set = (t, value) => t.page.evaluate(v => harness.polls(v), value);

// 1. OBS: hidden without a poll; a poll comes in, votes animate, the end celebrates once.
{
  const t = await open('?mode=live&polls=none');
  ok((await t.state()).state === 'hidden', 'live, no poll: hidden');
  await set(t, { poll: poll(), prediction: null });
  await wait(300);
  let s = await t.state();
  ok(s.state === 'showing' && s.rows.length === 3 && s.title === '¿Qué jugamos?' && s.eyebrow === 'Encuesta', 'poll begins: card with 3 choices', JSON.stringify(s));
  await wait(2200);
  await set(t, { poll: poll({ revision: 2, choices: [{ id: 'a', title: 'Celeste', votes: 6 }, { id: 'b', title: 'Hades', votes: 3 }, { id: 'c', title: 'Tetris', votes: 1 }] }), prediction: null });
  await wait(250);
  s = await t.state();
  ok(s.floaters === 3, 'votes: one "+N" chip per choice that got votes', String(s.floaters));
  await wait(1500);
  s = await t.state();
  ok(s.rows[0].pct === '60%' && s.rows[0].votes === '6 votos' && s.rows[2].votes === '1 voto' && s.total === '10 votos', 'votes: shares and counts (singular "voto")', JSON.stringify(s.rows));
  ok(s.rows[0].lead && !s.rows[1].lead && !s.rows[2].lead, 'leader gets the paw', JSON.stringify(s.rows.map(r => r.lead)));
  await wait(1100);
  const later = (await t.state()).clock;
  ok(/^0:5\d$/.test(s.clock) && later < s.clock, 'clock counts down', s.clock + ' → ' + later);
  await t.page.evaluate(() => harness.fields({ resultSeconds: 5 }));
  const ended = poll({ revision: 3, phase: 'completed', deadline: null, endedAt: iso(Date.now()), choices: [{ id: 'a', title: 'Celeste', votes: 7 }, { id: 'b', title: 'Hades', votes: 3 }, { id: 'c', title: 'Tetris', votes: 1 }] });
  await set(t, { poll: ended, prediction: null });
  await wait(1500);
  await set(t, { poll: Object.assign({}, ended, { phase: 'archived', revision: 4 }), prediction: null });   // Twitch's second end event
  await wait(800);
  s = await t.state();
  ok(s.phase === 'results' && s.eyebrow === 'Resultados' && s.mood === 'happy', 'poll ends: results', JSON.stringify(s));
  ok(s.rows[0].win && s.rows[1].lose && s.rows[2].lose, 'winner highlighted, others dimmed', JSON.stringify(s.rows));
  ok(s.note.includes('Ganó') && s.note.includes('Celeste'), 'footer names the winner', s.note);
  ok(s.celebrations === 1, 'celebrates once (completed, then archived)', String(s.celebrations));
  await wait(4600);   // 5 s of results from the end, then a 0.95 s exit
  s = await t.state();
  ok(s.state === 'hidden', 'results leave after "Segundos mostrando el resultado"', s.state);
  ok(t.errors.length === 0 && (await t.logs()).length === 0, 'no errors (live)', JSON.stringify(t.errors.concat(await t.logs())));
  await t.page.close();
}

// 2. Loading during results: shown quietly; an old result or a stale "active" poll stays hidden; predictions are ignored.
{
  const t = await open('?mode=live&polls=none');
  await set(t, { poll: poll({ phase: 'completed', deadline: null, endedAt: iso(Date.now() - 3000), choices: [{ id: 'a', title: 'Celeste', votes: 2 }, { id: 'b', title: 'Hades', votes: 5 }] }), prediction: null });
  await wait(2500);
  let s = await t.state();
  ok(s.state === 'showing' && s.phase === 'results' && s.rows[1].win && s.celebrations === 0, 'already over when seen: results without a celebration', JSON.stringify(s));
  await set(t, { poll: poll({ id: 'old', phase: 'completed', deadline: null, endedAt: iso(Date.now() - 600000) }), prediction: null });
  await wait(1300);
  ok((await t.state()).state === 'hidden', 'a result from 10 minutes ago: hidden');
  await set(t, { poll: poll({ id: 'stale', deadline: iso(Date.now() - 300000) }), prediction: null });
  await wait(600);
  ok((await t.state()).state === 'hidden', '"active" 5 minutes past its deadline: hidden');
  await set(t, { poll: null, prediction: { kind: 'prediction', id: 'pr', title: 'X', phase: 'active', choices: [{ id: 'a', title: 'A', votes: 0 }, { id: 'b', title: 'B', votes: 0 }] } });
  await wait(600);
  ok((await t.state()).state === 'hidden', 'a prediction alone: hidden');
  // 3. Tie, then zero votes.
  await set(t, { poll: poll({ id: 'tie' }), prediction: null });
  await wait(2000);
  await set(t, { poll: poll({ id: 'tie', phase: 'completed', deadline: null, endedAt: iso(Date.now()), choices: [{ id: 'a', title: 'Celeste', votes: 4 }, { id: 'b', title: 'Hades', votes: 4 }, { id: 'c', title: 'Tetris', votes: 1 }] }), prediction: null });
  await wait(1800);
  s = await t.state();
  ok(s.note.includes('¡Empate!') && s.rows[0].win && s.rows[1].win && s.rows[2].lose && s.celebrations === 1, 'tie: both win, "¡Empate!"', JSON.stringify(s));
  await set(t, { poll: poll({ id: 'zero' }), prediction: null });
  await wait(2000);
  s = await t.state();
  ok(s.phase === 'open' && s.rows.every(r => !r.win && !r.lose && !r.lead), 'a new poll during results starts fresh', JSON.stringify(s));
  await set(t, { poll: poll({ id: 'zero', phase: 'completed', deadline: null, endedAt: iso(Date.now()) }), prediction: null });
  await wait(1000);
  s = await t.state();
  ok(s.note === 'Nadie votó' && s.rows.every(r => !r.win && !r.lose) && s.mood === 'idle', 'no votes: "Nadie votó", no winner', JSON.stringify(s));
  // The Test drawer's poll sample (test-events.ts testPolls): a running poll.
  const at = iso(Date.now());
  await set(t, { poll: { kind: 'poll', id: 'test-poll', title: 'Next game?', phase: 'active', startedAt: at, deadline: iso(Date.now() + 60000), endedAt: null, winnerId: null,
    occurredAt: at, receipt: 'test', revision: 1, choices: [{ id: 'a', title: 'Celeste', votes: 12, users: 12, points: 0 }, { id: 'b', title: 'Hades', votes: 7, users: 7, points: 0 }, { id: 'c', title: 'Tetris', votes: 3, users: 3, points: 0 }] }, prediction: null });
  await wait(2600);
  s = await t.state();
  ok(s.phase === 'open' && s.title === 'Next game?' && s.rows.map(r => r.pct).join() === '55%,32%,14%' && s.rows[0].lead, 'Studio Test drawer sample: shown as a running poll', JSON.stringify(s.rows));
  // 4. Viewer-made text is text, never HTML.
  const evil = '<img src=x onerror="parent.__xss=1">';
  await set(t, { poll: poll({ id: 'xss', title: evil, choices: [{ id: 'a', title: evil, votes: 1 }, { id: 'b', title: 'B', votes: 0 }] }), prediction: null });
  await wait(1500);
  s = await t.state();
  const imgs = await t.frame.evaluate(() => document.querySelectorAll('img').length);
  ok(s.title === evil && s.rows[0].name === evil && imgs === 0, 'titles are shown as text', JSON.stringify({ title: s.title, imgs }));
  // 5. Language.
  await t.page.evaluate(() => harness.fields({ lang: 'en' }));
  await wait(1500);
  s = await t.state();
  ok(s.eyebrow === 'Poll' && s.note === 'Vote in Twitch chat!' && s.rows[0].votes === '1 vote', 'English texts', JSON.stringify(s));
  ok(t.errors.length === 0 && (await t.logs()).length === 0, 'no errors (states)', JSON.stringify(t.errors.concat(await t.logs())));
  await t.page.close();
}

// 5b. Replays, clocks and late ends. Server times are made with a skew: the OBS clock is off by that much.
{
  const t = await open('?mode=live&polls=none');
  // The host replays updates that came in while the frame loaded: an older "active" after "completed" changes nothing.
  const done = poll({ id: 'r', revision: 12, phase: 'completed', deadline: null, startedAt: iso(Date.now() - 900000), endedAt: iso(Date.now() - 1000), choices: [{ id: 'a', title: 'Celeste', votes: 5 }, { id: 'b', title: 'Hades', votes: 2 }] });
  await set(t, { poll: done, prediction: null });
  await wait(300);
  await set(t, { poll: Object.assign({}, done, { revision: 11, phase: 'active', deadline: iso(Date.now() + 30000), endedAt: null }), prediction: null });
  await wait(300);
  await set(t, { poll: done, prediction: null });
  await wait(1500);
  let s = await t.state();
  ok(s.phase === 'results' && s.celebrations === 0, 'replayed older "active" between two "completed": no reopening, no celebration', JSON.stringify(s));
  // This computer is 3 minutes fast: a new poll still shows with the right countdown, and its end celebrates.
  const fast = -180000, server = () => Date.now() + fast, fastStart = server();
  await set(t, { poll: poll({ id: 'fast', revision: 20, startedAt: iso(fastStart), deadline: iso(fastStart + 60000), occurredAt: iso(fastStart) }), prediction: null });
  await wait(2600);
  s = await t.state();
  ok(s.state === 'showing' && s.phase === 'open' && /^0:5\d$/.test(s.clock), 'clock 3 min fast: poll shows with its real countdown', JSON.stringify({ state: s.state, clock: s.clock }));
  await set(t, { poll: poll({ id: 'fast', revision: 21, startedAt: iso(fastStart), phase: 'completed', deadline: null, endedAt: iso(server()), occurredAt: iso(server()),
    choices: [{ id: 'a', title: 'Celeste', votes: 3 }, { id: 'b', title: 'Hades', votes: 1 }, { id: 'c', title: 'Tetris', votes: 0 }] }), prediction: null });
  await wait(1200);
  s = await t.state();
  ok(s.phase === 'results' && s.celebrations === 1, 'clock 3 min fast: the end shows and celebrates', JSON.stringify(s));
  ok(t.errors.length === 0 && (await t.logs()).length === 0, 'no errors (replays, fast clock)', JSON.stringify(t.errors.concat(await t.logs())));
  await t.page.close();
}
{
  const t = await open('?mode=live&polls=none');
  // This computer is 3 minutes slow, and the poll's end arrives 2 minutes late (a reconnect): old results stay hidden.
  const slow = 180000, server = () => Date.now() + slow;
  await set(t, { poll: poll({ id: 'before', revision: 1, phase: 'completed', deadline: null, startedAt: iso(server() - 900000), endedAt: iso(server() - 800000), occurredAt: iso(server() - 800000) }), prediction: null });
  await wait(300);
  const started = server();
  await set(t, { poll: poll({ id: 'slow', revision: 2, startedAt: iso(started), deadline: iso(started + 30000), occurredAt: iso(started) }), prediction: null });
  await wait(2600);
  let s = await t.state();
  ok(s.state === 'showing' && /^0:2\d$/.test(s.clock), 'clock 3 min slow: countdown follows the server', s.clock);
  await set(t, { poll: poll({ id: 'slow', revision: 3, startedAt: iso(started), phase: 'completed', deadline: null, endedAt: iso(server() - 120000), occurredAt: iso(server() - 120000) }), prediction: null });
  await wait(1500);
  s = await t.state();
  ok(s.state !== 'showing' && s.celebrations === 0, 'an end that arrives 2 minutes late: no results, no celebration', JSON.stringify({ state: s.state, celebrations: s.celebrations }));
  // Studio's Test drawer sample (also used by "Test in OBS") ends at its deadline here and shows its results.
  const at = Date.now();
  await set(t, { poll: { kind: 'poll', id: 'test-poll', title: 'Next game?', phase: 'active', startedAt: iso(at), deadline: iso(at + 3500), endedAt: null, winnerId: null, occurredAt: iso(at),
    receipt: 'test', revision: 1, choices: [{ id: 'a', title: 'Celeste', votes: 12 }, { id: 'b', title: 'Hades', votes: 7 }] }, prediction: null });
  await wait(5000);
  s = await t.state();
  ok(s.state === 'showing' && s.phase === 'results' && s.rows[0].win && s.celebrations === 1, 'Test drawer sample: ends by itself with results', JSON.stringify(s));
  ok(t.errors.length === 0 && (await t.logs()).length === 0, 'no errors (slow clock, sample)', JSON.stringify(t.errors.concat(await t.logs())));
  await t.page.close();
}

// 6. Studio: the example while there is no poll, and the test buttons.
{
  const t = await open('?mode=editor&polls=none');
  await wait(1800);
  let s = await t.state();
  ok(s.state === 'showing' && s.note.startsWith('Ejemplo') && s.rows.length === 3, 'Studio without a poll: example', JSON.stringify(s));
  await t.page.evaluate(() => harness.fields({ resultSeconds: 5 }));
  await t.page.evaluate(() => harness.button('testPoll'));
  await wait(5000);
  s = await t.state();
  const votes = s.rows.reduce((sum, r) => sum + parseInt(r.votes, 10), 0);
  ok(s.phase === 'open' && votes > 0 && !s.note.startsWith('Ejemplo'), '"Probar una encuesta": votes arrive', JSON.stringify(s));
  await t.page.evaluate(() => harness.button('testResult'));
  await wait(1200);
  s = await t.state();
  ok(s.phase === 'results' && s.celebrations === 1, '"Probar el resultado" ends the test poll with a celebration', JSON.stringify(s));
  await wait(6000);
  s = await t.state();
  ok(s.state === 'showing' && s.phase === 'open' && s.note.startsWith('Ejemplo'), 'after the results, the example comes back', JSON.stringify(s));
  await t.page.evaluate(() => harness.button('testResult'));
  await wait(2700);
  s = await t.state();
  ok(s.phase === 'results' && s.celebrations === 2 && s.rows[0].win, '"Probar el resultado" from the example', JSON.stringify(s));
  ok(t.errors.length === 0 && (await t.logs()).length === 0, 'no errors (editor)', JSON.stringify(t.errors.concat(await t.logs())));
  await t.page.close();
}

// 7. Layout: the card and the bear fit inside the layer box, with as many columns as the shape asks for.
for (const [w, h, choices, cols] of [[480, 640, 3, '1'], [1000, 280, 5, '3'], [700, 330, 4, '2'], [300, 260, 2, '1'], [1600, 900, 5, null]]) {
  const t = await open('?mode=live&polls=none', [w, h]);
  await set(t, { poll: poll({ choices: Array.from({ length: choices }, (_, i) => ({ id: 'c' + i, title: 'Opción número ' + (i + 1), votes: i + 1 })) }), prediction: null });
  await wait(2600);
  const box = await t.frame.evaluate(() => {
    const r = el => el.getBoundingClientRect();
    // The ears are the top of what shows (the head's SVG box has empty room above them).
    const card = r(document.getElementById('card')), head = r(document.querySelector('.bear__ear--l')), icicles = r(document.getElementById('icicles'));
    return { cols: document.getElementById('stage').dataset.cols, w: innerWidth, h: innerHeight, left: card.left, right: card.right, top: Math.min(card.top, head.top), bottom: icicles.bottom };
  });
  const inside = box.left >= -0.5 && box.right <= box.w + 0.5 && box.top >= -0.5 && box.bottom <= box.h + 0.5;
  ok((cols === null || box.cols === cols) && inside, `${w}×${h}, ${choices} choices: ${cols || 'any'} column(s), fits`, JSON.stringify(box));
  await t.page.close();
}

// 8. A visible card refits when a longer title comes in or the layer is resized.
{
  const t = await open('?mode=live&polls=none', [1000, 280]);
  const fits = () => t.frame.evaluate(() => {
    const r = el => el.getBoundingClientRect();
    const card = r(document.getElementById('card')), ear = r(document.querySelector('.bear__ear--l')), icicles = r(document.getElementById('icicles'));
    return { cols: document.getElementById('stage').dataset.cols, inside: card.left >= -0.5 && card.right <= innerWidth + 0.5 && ear.top >= -0.5 && icicles.bottom <= innerHeight + 0.5,
      top: ear.top, bottom: icicles.bottom, h: innerHeight };
  });
  await set(t, { poll: poll({ id: 'short', title: 'Hoy' }), prediction: null });
  await wait(2600);
  await set(t, { poll: poll({ id: 'long', title: '¿Qué juego tranquilo y acogedor jugamos esta noche con el osito y toda la manada polar?' }), prediction: null });
  await wait(2600);
  let f = await fits();
  ok(f.inside, 'a two-line title replacing a short one: still fits', JSON.stringify(f));
  await t.page.evaluate(() => harness.size(480, 640));
  await wait(800);
  f = await fits();
  ok(f.inside && f.cols === '1', 'layer resized while showing: refits in one column', JSON.stringify(f));
  ok(t.errors.length === 0 && (await t.logs()).length === 0, 'no errors (refit)', JSON.stringify(t.errors.concat(await t.logs())));
  await t.page.close();
}

await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
