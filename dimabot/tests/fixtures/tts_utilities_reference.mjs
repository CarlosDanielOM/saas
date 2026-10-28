#!/usr/bin/env node
// Execute only the actual pure TS sources in an isolated VM. Run from the
// task-owned compiler container: node tests/fixtures/tts_utilities_reference.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../../src/utils/tts/', import.meta.url);
const context = vm.createContext({});
const cache = new Map();
const sources = {};
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const source = readFileSync(new URL(name + '.ts', root), 'utf8');
  sources[name] = createHash('sha256').update(source).digest('hex');
  const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  function localRequire(path) {
    assert.equal(path, './expressive_tts_tags.util.js');
    return load('expressive_tts_tags.util');
  }
  new vm.Script(`(function(exports,require){${compiled}\n})`, {filename:name+'.ts'}).runInContext(context)(exports, localRequire);
  cache.set(name, exports);
  return exports;
}
const tags = load('expressive_tts_tags.util');
const voice = load('kokoro_voices.util');
const template = load('speech_template.util');
const normalize = load('normalize_tts_message.util');
const status = load('tts_status');
const fixturePath = new URL('tts_utilities_cases.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const cases = Array.isArray(fixture) ? fixture : fixture.cases;
for (const c of cases) {
  let actual;
  switch (c.op) {
    case 'voice': actual = voice.resolveKokoroVoice(c.input); break;
    case 'template': actual = template.migrateLegacySpeechTemplate(c.input); break;
    case 'filter': actual = tags.filterExpressiveTtsTags(c.input, {provider:c.provider, enabledTags:tags.normalizeExpressiveTtsTags()}); break;
    case 'reinforce': actual = tags.reinforceFishTtsTags(c.input); break;
    case 'normalize': actual = normalize.normalizeTtsMessage(c.input,c.options); break;
    case 'splitSurrogate': actual = [...Array(normalize.normalizeTtsMessage(c.input,c.options).text.length)].map((_, i) => normalize.normalizeTtsMessage(c.input,c.options).text.charCodeAt(i)); break;
    case 'status': actual = status.isTtsStatusData(c.input) ? status.formatTtsStatus(c.input) : null; break;
    default: throw new Error(`unknown operation ${c.op}`);
  }
  c.expected = JSON.parse(JSON.stringify(actual));
}
assert.equal(tags.EXPRESSIVE_TTS_TAGS.length,75);
const output = {sources, cases};
const serialized = JSON.stringify(output, null, 2) + '\n';
if (process.argv[2] === '--write') writeFileSync(fixturePath, serialized);
else {
  assert.equal(process.argv[2] ?? '--check', '--check');
  assert.equal(readFileSync(fixturePath, 'utf8'), serialized, 'source oracle or golden changed');
}
console.log(`TTS oracle: ${cases.length} cases`);
