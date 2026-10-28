#!/usr/bin/env node
// Node built-ins and the real MongoDB BSON codec are the oracle. Run only in
// the lead-owned capped container: node tests/fixtures/js_string_reference.mjs
// --write, followed by --check. Input is explicit UTF-16, including unpaired
// surrogates; all expected output is generated rather than assumed.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BSON } = require('mongodb');
const fixturePath = new URL('js_string_cases.json', import.meta.url);
const source = readFileSync(new URL('../../src/utils/js_string.rs',import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath,'utf8'));
const cases = (Array.isArray(fixture) ? fixture : fixture.cases).map(({inputUnits,start,end}) => ({inputUnits,start,end}));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const units = text => Array.from({length:text.length}, (_,i) => text.charCodeAt(i));
for (const c of cases) {
  const input = String.fromCharCode(...c.inputUnits);
  const slice = input.slice(c.start,c.end);
  const bson = BSON.serialize({v:slice});
  assert.equal(bson[4],2);
  assert.equal(bson[5],118);
  const size = bson.readInt32LE(7);
  c.expected = {
    length:input.length,
    units:units(input),
    sliceUnits:units(slice),
    trimUnits:units(input.trim()),
    sliceJson:JSON.stringify(slice),
    sliceUtf8:[...Buffer.from(slice,'utf8')],
    sliceBson:[...bson.subarray(11,11+size-1)],
  };
}
const output = JSON.stringify({sourceHash:hash(source),caseHash:hash(JSON.stringify(cases.map(({inputUnits,start,end})=>({inputUnits,start,end})))),cases},null,2)+'\n';
if (process.argv[2] === '--write') writeFileSync(fixturePath,output);
else { assert.equal(process.argv[2] ?? '--check','--check'); assert.equal(readFileSync(fixturePath,'utf8'),output,'source, inputs or expected data changed'); }
console.log(`Node UTF-16 oracle: ${cases.length} cases`);
