import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
assert.equal(process.env.ANALYTICS_TEST,'1');
const output=execFileSync(process.execPath,['--test','--test-isolation=none','test/analytics.test.mjs','test/channel-names.test.mjs'],{encoding:'utf8'});
console.log(output);
const health=await fetch('http://127.0.0.1:3210/health');assert.equal(health.status,200);
const response=await fetch('http://127.0.0.1:3210/api/overview',{headers:{Authorization:'Bearer owner'}});assert.equal(response.status,200);
const data=await response.json();assert.equal(data.channelNames['channel-a'],'pixelpilot');assert.equal(data.channelNames['channel-b'],'lunastreams');assert(!JSON.stringify(data).includes('secret-token'));
console.log('Running analytics service returns names for historical channel IDs; permissions, privacy and fallback checks passed');
