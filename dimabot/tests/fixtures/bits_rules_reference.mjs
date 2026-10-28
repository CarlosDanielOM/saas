#!/usr/bin/env node
// Source-backed oracle; run only in the lead's isolated compiler container.
// Seed cases are replaced with actual TS results and a source hash by --write.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../../src/bits_rules/model.ts', import.meta.url), 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports = {}, context = vm.createContext({});
new vm.Script(`(function(exports){${compiled}\n})`).runInContext(context)(exports);
const path = new URL('bits_rules_cases.json',import.meta.url);
const fixture = JSON.parse(readFileSync(path,'utf8'));
const cases = Array.isArray(fixture) ? fixture : fixture.cases;
for (const c of cases) {
  delete c.expected; delete c.error;
  try {
    switch (c.op) {
      case 'parse': c.expected = exports.parseRule(c.raw,c.id,c.previous ?? undefined); break;
      case 'legacy': c.expected = exports.rulesFromLegacyTiers(c.raw); break;
      case 'id': c.expected = exports.validRuleId(c.raw); break;
      case 'match': c.expected = exports.matchBitsRule(c.raw,c.bits)?.id ?? null; break;
      default: throw new Error(`unknown operation ${c.op}`);
    }
  } catch (error) { c.error = error.message; }
}
const output = JSON.stringify({sourceHash,cases},null,2) + '\n';
if (process.argv[2] === '--write') writeFileSync(path,output);
else { assert.equal(process.argv[2] ?? '--check','--check'); assert.equal(readFileSync(path,'utf8'),output,'source or cases changed'); }
console.log(`Bits rule oracle: ${cases.length} cases`);
