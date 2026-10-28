#!/usr/bin/env node
// Run in a fresh isolated process with TZ=UTC and the generated UTC fixture.
// The measured operation is the Mongoose caster, including thrown errors;
// fixture decoding, JSON, and file I/O are outside the timed region.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const mongoose = require('mongoose');
assert.equal(mongoose.version, '8.24.2');
assert.equal(process.env.TZ, 'UTC');
const fixture = JSON.parse(readFileSync(process.env.MONGOOSE_DATE_FIXTURE, 'utf8'));
assert.equal(fixture.metadata.mongoose, '8.24.2');
assert.equal(fixture.metadata.zone, 'UTC');
const workload = process.env.MONGOOSE_DATE_BENCH_WORKLOAD;
assert.ok(['numeric', 'string', 'invalid', 'mixed'].includes(workload));
const selected = fixture.cases.map((c, index) => ({...c, index})).filter(c => {
  const valid = typeof c.expected.value === 'number';
  if (workload === 'mixed') return true;
  if (workload === 'invalid') return c.expected.error === 'cast';
  if (workload === 'string') return valid && c.input.kind === 'json' && typeof c.input.value === 'string';
  return valid && (['number', 'boxed', 'date', 'int64-number'].includes(c.input.kind) ||
    (c.input.kind === 'json' && typeof c.input.value === 'number'));
});
assert.ok(selected.length);
function decode(x) {
  switch (x.kind) {
    case 'json': return x.value;
    case 'number': case 'int64-number': return Number(x.value);
    case 'boxed': return new Number(Number(x.value));
    case 'date': return new Date(Number(x.value));
    default: throw Error(x.kind);
  }
}
const values = selected.map(c => decode(c.input));
const caster = mongoose.Schema.Types.Date.cast();
for (const c of selected) {
  if (typeof c.expected.value === 'number') assert.ok(Number.isSafeInteger(c.expected.value));
}
const operations = 10000;
function sample() {
  let checksum = 0, valid = 0, nulls = 0, invalid = 0;
  const start = performance.now();
  for (let i = 0; i < operations; i++) {
    checksum = (checksum + i) >>> 0;
    try {
      const result = caster(values[i % values.length]);
      if (result === null) nulls++;
      else {
        const millis = result.getTime();
        checksum = (checksum + (millis >>> 0)) >>> 0;
        valid++;
      }
    } catch (error) {
      invalid++;
    }
  }
  return { elapsed_ns: Math.round((performance.now() - start) * 1e6), checksum, valid, nulls, invalid };
}
sample();
const samples = Array.from({length: 7}, sample);
const output = { engine: 'mongoose', version: mongoose.version, node: process.version, timezone: 'UTC', workload, operations, case_indices: selected.map(c => c.index), samples, scope: 'caster outcomes; Rust errors do not format details' };
const encoded = JSON.stringify(output, null, 2) + '\n';
writeFileSync(process.env.MONGOOSE_DATE_BENCH_OUTPUT, encoded);
process.stdout.write(encoded);
