// The function registry as the reference builds it: every name `registerAllFunctions` registers,
// in registration order, with its metadata exactly as registered.
//
// Runs the real registration code (no handler is called, no worker is started) offline in the
// production runtime, from the repository root:
//
//   docker run --rm --network none -e SECRET_KEY=fixture-only \
//     -v "$PWD":/work/repo -v /path/to/dimabot/node_modules:/work/node_modules:ro \
//     -w /work/repo/dimabot node:24-alpine \
//     node --import tsx ../dima-rust/crates/engine/tests/fixtures/ast_registry_reference.mjs [--check]
//
// `SECRET_KEY` is a placeholder some imported modules require at load time; nothing is encrypted.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../../../../../', import.meta.url);
const output = new URL('ast_registry_cases.json', import.meta.url);
const sources = [
    'dimabot/src/utils/ast_parser/evaluator.ts',
    'dimabot/src/utils/ast_parser/types.ts',
    'dimabot/src/utils/ast_parser/functions/index.ts',
    ...['availability', 'channel', 'chat', 'clip', 'count', 'defense', 'delay', 'eventsub', 'followage', 'goals',
        'moderation', 'overlay', 'pet', 'pin', 'random', 'roulette', 'string', 'trigger', 'tts', 'twitch', 'user', 'widget']
        .map((name) => `dimabot/src/utils/ast_parser/functions/${name}.functions.ts`),
];
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const hashes = {};
for (const path of sources) hashes[path] = sha256(await readFile(new URL(path, root), 'utf8'));

const { registerAllFunctions } = await import(new URL('dimabot/src/utils/ast_parser/functions/index.ts', root).href);
const { getAllRegisteredFunctions } = await import(new URL('dimabot/src/utils/ast_parser/evaluator.ts', root).href);
registerAllFunctions({ startWorkers: false });
const functions = getAllRegisteredFunctions().map(({ name, metadata }) => ({ name, metadata: metadata ?? null }));
assert.ok(functions.length > 100, `registry size ${functions.length}`);

const manifest = { schemaVersion: 1, sourceHashes: hashes, count: functions.length, functions };
const bytes = JSON.stringify(manifest, null, 1) + '\n';
if (process.argv.includes('--check')) assert.equal(await readFile(output, 'utf8'), bytes, 'registry drift');
else await writeFile(output, bytes);
console.log(JSON.stringify({ functions: functions.length, sha256: sha256(bytes) }));
process.exit(0);
