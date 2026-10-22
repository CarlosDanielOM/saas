/** Real separate producer process: no API runtime or local ready peers. */
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { admitPetAction } from '/app/dist/pets/admission.js';
import { petPeers } from '/app/dist/pets/peers.js';
assert.match(process.env.MONGO_URI, /saas_ops_oauth_beta_test$/);
assert.equal(petPeers.size, 0);
await getMongoDBConnection('pet-separate-producer');
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
    const started = performance.now();
    const result = await admitPetAction(JSON.parse(input));
    process.stdout.write(`PET_RESULT:${JSON.stringify({ pid: process.pid, peers: petPeers.size, elapsedMs: performance.now() - started, result })}\n`);
} catch (error) {
    process.stdout.write(`PET_RESULT:${JSON.stringify({ pid: process.pid, peers: petPeers.size, error: error.code ?? error.message })}\n`);
}
// Model a persistent producer long enough for its deferred hint. The result was already written.
await new Promise(resolve => setTimeout(resolve, 1100));
process.exit(0);
