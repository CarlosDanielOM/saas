// dima-hoststats candidate: unit tests (parsers, Docker read allowlist, fake-Docker end to end) plus the real
// runtime without a Docker socket: host fields are read, Docker is reported unreachable, writes are refused.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const output = execFileSync(process.execPath, ['--test', 'test/hoststats.test.mjs'], { encoding: 'utf8' });
console.log(output); assert.match(output, /[ℹ#] fail 0\n/);
const snap = await (await fetch('http://127.0.0.1:3211/v1/snapshot')).json();
assert(snap.host.memTotal > 0 && snap.host.diskTotal > 0 && snap.host.cpus > 0, 'host fields');
assert.equal(snap.docker.reachable, false, 'candidate has no Docker socket');
assert.deepEqual(snap.containers, []);
assert.equal((await fetch('http://127.0.0.1:3211/v1/snapshot', { method: 'POST' })).status, 405);
console.log('hoststats candidate: tests pass, host stats read, no Docker access without the socket');
