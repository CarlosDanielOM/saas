/** One half of scripts/test-pet-api-interop.py's bounded, single integration invocation. */
import assert from 'node:assert/strict';
assert.equal(process.env.SAAS_TARGET, 'api');
assert.equal(process.env.PET_RUST_INTEROP_FIXTURE, 'disposable-v1');
assert.equal(process.env.MONGO_URI, 'mongodb://mongo:27017/saas_ops_oauth_beta_test');
async function control(action) {
  const response = await fetch(`http://127.0.0.1:3101/${action}`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `fixture ${action} failed`); return response.json();
}
await control('setup');
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  const status = await control('status');
  assert.equal(status.failure, null);
  if (status.finished) { console.log('PASS actual API + Rust coordinator: two admissions, adjacent ready/play, stale guards, private media, no replay'); process.exit(0); }
  await new Promise(resolve => setTimeout(resolve, 200));
}
throw new Error('Rust interop did not finish before disposable fixture deadline');
