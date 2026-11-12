// Records what today's dimabot/src/utils/timer_policy.ts does, under Node 24, offline:
//   docker run --rm --network none --user "$(id -u):$(id -g)" -v "$PWD":/work \
//     -v <checkout with node_modules>/dimabot/node_modules:/nm:ro -e DIMABOT_NODE_MODULES=/nm \
//     -w /work node:24-alpine node dima-rust/crates/commands/tests/fixtures/timer_policy_reference.mjs [--check]
//
// The timer part of dima-rust/tests/fixtures/policy_utils_parity.mjs, extended with non-ASCII
// frequency input (other digits, fullwidth letters, marks, right-to-left marks, emoji).
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const repo = new URL('../../../../../', import.meta.url);
const nodeModules = process.env.DIMABOT_NODE_MODULES
  ? new URL(`file://${process.env.DIMABOT_NODE_MODULES.replace(/\/?$/, '/')}`)
  : new URL('dimabot/node_modules/', repo);
const { default: ts } = await import(new URL('typescript/lib/typescript.js', nodeModules));
const outputUrl = new URL('timer_policy_cases.json', import.meta.url);

const input = await readFile(new URL('dimabot/src/utils/timer_policy.ts', repo), 'utf8');
const result = ts.transpileModule(input, { reportDiagnostics: true, compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
} });
assert.equal(result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
const context = vm.createContext({ exports: {} });
new vm.Script(result.outputText, { filename: 'timer_policy.isolated.js' }).runInContext(context, { timeout: 1000 });
const timer = context.exports;

function encode(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' };
    if (value === Infinity) return { $number: '+Infinity' };
    if (value === -Infinity) return { $number: '-Infinity' };
    if (Object.is(value, -0)) return { $number: '-0' };
  }
  if (value === undefined) return { $undefined: true };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}
const cases = [];
function add(operation, input, run) {
  const item = { operation, input: encode(input) };
  try { item.expected = encode(run()); } catch (error) { item.error = error.message; }
  cases.push(item);
}

for (const frequency of [undefined, null, false, true, '12', {}, [], -Infinity, NaN, -0, 0, -1, .5, 1, 2, 287, 288, 289, Infinity]) {
  add('legacy_frequency', { frequency }, () => timer.convertLegacyTimerFrequency(frequency));
}
for (const raw of [undefined, '', ' ', '7', '0007', '7m', ' 2H ', '﻿2h ', '\u00852h', '1.5h',
  '1 h', '+2h', '-2', '0', '0h', '１h', '1\n2', '3mh', '1e3', '9007199254740993', '1' + '0'.repeat(307) + 'h', '9'.repeat(400),
  // Non-ASCII: other digits, fullwidth and look-alike letters, marks, direction marks, emoji, astral digits.
  '٣h', '३m', '𝟑h', '3ｈ', '3Ｍ', '3h́', '3́h', '‏3h', '3h‎', ' 3h　', '3😀', '😀',
  '3​h', '3ʰ', 'ⅲh', '3H', '3M', 'Ｈ', ' 5m ', '5m᠎'
]) {
  add('parse_frequency', { raw }, () => timer.parseTimerFrequencyInput(raw));
}
for (const frequency of [-0, NaN, Infinity, -Infinity, -.5, 1, 7.5, 288, 1e308]) {
  for (const frequencyUnit of [undefined, null, 'minutes', 'Minutes', 'ticks', 'minuteś', 'ｍｉｎｕｔｅｓ']) {
    const value = { frequency, frequencyUnit };
    add('interval_minutes', value, () => timer.getTimerIntervalMinutes(value));
    for (const storedHeartbeat of [-0, -1, 0, 2.5, NaN, Infinity, 1e308]) {
      const heartbeatUnit = frequencyUnit === 'minutes' ? undefined : 'minutes';
      add('heartbeat_minutes', { ...value, storedHeartbeat, heartbeatUnit },
        () => timer.getTimerHeartbeatMinutes(value, storedHeartbeat, heartbeatUnit));
    }
  }
}
for (const storedHeartbeat of [-0, 2.5, 1e308, NaN, Infinity, -Infinity]) {
  for (const heartbeatUnit of [undefined, null, 'ticks', 'Minutes']) {
    add('heartbeat_minutes', { frequency: 12, storedHeartbeat, heartbeatUnit },
      () => timer.getTimerHeartbeatMinutes({ frequency: 12 }, storedHeartbeat, heartbeatUnit));
  }
}
for (const tier of ['free', 'premium', 'pro', 'unknown', 'PRO', 'pró', 'ｐｒｏ', '']) {
  for (const minutes of [-Infinity, NaN, -0, -1, .5, 1, 4, 5, 7, 10, 15, 20, 25, 30, 40, 50, 55, 60, 61, 65, 175, 179, 180, 181, 185, 1440, Infinity]) {
    add('validate_interval', { minutes, tier }, () => timer.validateTimerInterval(minutes, tier));
  }
  for (const value of [{ frequency: 1 }, { frequency: 2 }, { frequency: 7, frequencyUnit: 'minutes' }, { frequency: NaN }, { frequency: 36 }]) {
    for (const requested of [undefined, null, 0, NaN, 10, 35, 181]) {
      add('validate_edit', { ...value, requested, tier }, () => timer.validateTimerEditInterval(value, requested, tier));
    }
  }
}
add('constants', {}, () => ({ unit: timer.TIMER_FREQUENCY_UNIT, grandfathered: timer.MAX_GRANDFATHERED_TIMER_MINUTES }));

const counts = {};
for (const item of cases) counts[item.operation] = (counts[item.operation] ?? 0) + 1;
const output = {
  description: 'Recorded from today\'s dimabot/src/utils/timer_policy.ts under Node. Do not edit by hand.',
  node: process.version,
  sources: { 'timer_policy.ts': createHash('sha256').update(input).digest('hex') },
  counts: { cases: cases.length, ...Object.fromEntries(Object.entries(counts).sort()) },
  cases
};
const serialized = `${JSON.stringify(output, null, 1)}\n`;
if (process.argv.includes('--check')) {
  assert.equal(await readFile(outputUrl, 'utf8'), serialized, 'drift: regenerate timer_policy_cases.json');
  console.log(`Checked ${cases.length} cases.`);
} else {
  await writeFile(outputUrl, serialized);
  console.log(`Generated ${cases.length} cases on Node ${process.version}: ${JSON.stringify(counts)}`);
}
