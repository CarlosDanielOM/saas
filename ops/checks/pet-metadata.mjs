/** Exact API image: generated authoring metadata and its existing compiled consumer. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
assert.equal(process.env.SAAS_TARGET, 'api');
assert.equal(process.env.MONGO_URI, 'mongodb://mongo:27017/saas_ops_oauth_beta_test');
assert.equal(process.env.PIPER_HTTP_URL, 'http://pet-piper.test');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePath = '/app/src/utils/ai/ast_catalog/ast-catalog.json';
const compiledPath = '/app/dist/utils/ai/ast_catalog/ast-catalog.json';
const docPath = '/app/src/utils/ai/sandbox/doc-ast.txt'; // code_execution.tool's existing read-only reference path
const sourceBytes = await readFile(sourcePath), compiledBytes = await readFile(compiledPath), docBytes = await readFile(docPath);
assert.equal(digest(sourceBytes), '97e3b47776e97352733da9f589ffd9e8300f85f99bb6872a53deeacc503d5fb4');
assert.equal(digest(docBytes), '8a199d72469f0b950e8273253527073ecb428eb0b3cf99d95c917f8bc7cd6418');
const catalog = JSON.parse(sourceBytes), compiledCatalog = JSON.parse(compiledBytes);
assert.deepEqual(compiledCatalog, catalog, 'compiled runtime must load the generated catalog in this exact image');
assert.equal(catalog.version, 'd2bd1b95bef8');
assert.equal(catalog.functionCount, 115); assert.equal(catalog.entries.length, 115);
const names = ['pet.ask', 'pet.talk'];
const petEntries = catalog.entries.filter(entry => entry.name.startsWith('pet.'));
assert.deepEqual(petEntries.map(entry => entry.name).sort(), names);
const docs = docBytes.toString('utf8');
assert.match(docs, /^# Catalog version: d2bd1b95bef8$/m);
assert.equal(docs.split('\n').filter(line => line === '# --- pet ---').length, 1);

// These are the existing authoring interfaces consumed by AST_DOCS. There is
// no public HTTP catalog route to invent or change for this artifact release.
const { getAstCatalog, findAstCatalogEntry, searchAstCatalog } = await import('/app/dist/utils/ai/ast_catalog/index.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const redis = await getDragonflyClient('pet-metadata-check');
const providerCallsBefore = await redis.lLen('pet:test:provider-calls');
assert.equal(providerCallsBefore, 0);
assert.deepEqual(getAstCatalog(), catalog);
for (const name of names) {
  const entry = petEntries.find(item => item.name === name);
  assert.equal(entry.planTier, 'premium'); assert.deepEqual(entry.surfaces, ['authoring']);
  assert.equal(entry.category, 'pet'); assert.equal(entry.minUserLevel, 1); assert.equal(entry.destructive, false);
  assert.deepEqual(entry.aliases, []);
  assert.equal(entry.syntax, `${name} ${name === 'pet.ask' ? 'prompt' : 'text'}`);
  assert.match(entry.description, /Requires a configured command or Twitch event action\./);
  assert.equal(entry.examples.length, 1);
  assert.ok(docs.includes(`# $(${entry.syntax}) - ${entry.description}\n`));
  assert.ok(docs.includes(`#   Example: $(${entry.examples[0]})\n`));
  assert.deepEqual(findAstCatalogEntry(name), entry);
  assert.deepEqual(findAstCatalogEntry(`$(${entry.syntax})`), entry);
  const authoring = await searchAstCatalog(name, { surface: 'authoring', maxUserLevel: 1 });
  assert.deepEqual(authoring.matches, [entry]); assert.equal(authoring.vectorSearchUsed, false);
  for (const options of [{ surface: 'action' }, {}]) {
    const action = await searchAstCatalog(name, options);
    assert.ok(action.matches.every(match => !match.name.startsWith('pet.')), 'pet actions must not appear on the default/action surface');
    assert.equal(action.vectorSearchUsed, false);
  }
}
assert.equal(await redis.lLen('pet:test:provider-calls'), providerCallsBefore, 'metadata lookup performs no synthesis or generation');
assert.equal(await redis.lLen('pet:test:billing-events'), 0, 'metadata lookup performs no billing');
await redis.quit();
console.log(JSON.stringify({ result: 'PASS pet metadata', version: catalog.version, entries: petEntries.map(({ name, planTier, surfaces }) => ({ name, planTier, surfaces })),
  sha256: { sourceCatalog: digest(sourceBytes), compiledCatalog: digest(compiledBytes), authoringText: digest(docBytes) }, providerCalls: 0, billingEvents: 0 }));
