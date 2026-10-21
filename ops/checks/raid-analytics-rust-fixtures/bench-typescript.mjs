// Unchanged projector, compiled in the real candidate image. Deliberately omit
// raid_analytics.worker.ts's unconditional 1s sleep for engine-only comparison.
// Historical benchmark baseline only: it calls the shared raid_analytics utility
// directly, not an archived worker entrypoint, supervisor selector, or fallback.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const mongoose = require('mongoose');
const uri = new URL(process.env.MONGO_URI);
assert.equal(uri.hostname, 'mongo');
assert.match(uri.pathname, /^\/raid_analytics_fixture_[a-zA-Z0-9_]+$/);
mongoose.set('autoIndex', false);
await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000 });
const { projectRaidSummaryOnce } = await import('/app/dist/utils/raid_analytics.js');
const count = Number(process.argv[2]);
assert(Number.isInteger(count) && count > 0 && count <= 32);
const stopping = new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
try {
    for (let index = 0; index < count; index++) {
        const start = performance.now();
        assert.equal(await projectRaidSummaryOnce(), true);
        console.log('raid_analytics:' + JSON.stringify({ event: 'batch', events: 1, success: true, durationMs: performance.now() - start }));
    }
    // Hold the completed process for a final VmHWM read, matching native CLI.
    await stopping;
} finally { await mongoose.disconnect(); }
