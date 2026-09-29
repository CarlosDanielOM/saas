import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['/tmp/saas-fixtures/behavior.mjs'], {
    env: { ...process.env, NODE_OPTIONS: '', SAAS_AST_BOOT_KIND: '' },
    encoding: 'utf8', timeout: 120_000
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
assert.equal(result.status, 0, `AST behavior check failed: ${result.signal || result.error || result.status}`);
