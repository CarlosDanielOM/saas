// Verify the recovered roulette UI together with the timer release it must preserve.
// Browser checks mock API/session/socket traffic and never mutate real channels.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const base = process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL required');
const root = process.env.SAAS_RECOVERY_REPO || '/root/saas';
const checks = resolve(root, 'ops/checks');

for (const language of ['en', 'es']) {
  const response = await fetch(`${base}/assets/i18n/${language}.json`);
  assert(response.ok, `translation request succeeds: ${language}`);
  const candidate = await response.json();
  const expected = JSON.parse(await readFile(resolve(root, `dimasite/src/assets/i18n/${language}.json`), 'utf8'));
  assert.deepEqual(candidate, expected, `candidate includes current roulette, timer and alert translations: ${language}`);
  assert(candidate.roulette.emptyTitle, 'recovered roulette empty state is present');
  assert(candidate.roulette.design.elimination.name, 'last one standing is present');
}

for (const check of ['roulette-module.mjs', 'timer-intervals-browser.mjs']) {
  const result = spawnSync(process.execPath, [resolve(checks, check)], {
    env: process.env,
    stdio: 'inherit',
    timeout: 180000,
  });
  assert.equal(result.status, 0, `${check} passes (${result.signal || result.error || result.status})`);
}
console.log('PASS recovered roulette UI and preserved timer intervals');
