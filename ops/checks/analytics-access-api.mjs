// Runs only inside the disposable API candidate, with isolated MongoDB/Redis.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire('/app/package.json');
const { createClient } = require('redis');
const redis = createClient({ url: 'redis://redis:6379' });
await redis.connect();
const call = async (path, token) => {
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() };
};
try {
  // The authenticated identity comes from the real token cache, never a browser ID.
  for (const [token, id, login] of [['invitee', '900002', 'invited'], ['owner', '533538623', 'cdom201']]) {
    await redis.hSet(`token:${token}`, { id, login, display_name: login });
    await redis.expire(`token:${token}`, 120);
  }
  for (const path of ['/admin/read-file?path=/home/cdom/saas/admin/access-fixture.txt', '/email/test?to=fixture@example.invalid', '/admin-site/users']) {
    assert.equal((await call(path)).status, 401, `anonymous blocked: ${path}`);
    assert.equal((await call(path, 'invitee')).status, 403, `analytics invitee blocked: ${path}`);
  }
  await mkdir('/home/cdom/saas/admin', { recursive: true });
  await writeFile('/home/cdom/saas/admin/access-fixture.txt', 'disposable admin fixture');
  const file = await call('/admin/read-file?path=/home/cdom/saas/admin/access-fixture.txt', 'owner');
  assert.equal(file.status, 200);
  assert.equal(file.body.data.content, 'disposable admin fixture');
  const email = await call('/email/test?to=fixture@example.invalid', 'owner');
  assert.equal(email.status, 200, JSON.stringify(email.body));
  assert.equal(email.body.data.messageId, 'fixture-email');
  console.log('Anonymous and analytics-only accounts denied internal APIs; owner file/email behavior passed with disposable fixtures');
} finally {
  await redis.quit();
}
process.exit(0);
