// The host-wide lock really excludes a second run (from any checkout), and is free again afterwards.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CACHE} from '../lib/paths.mjs';
import {relaunch} from '../lib/scope.mjs';

test('two runs at once: the second is refused with the busy code', async () => {
  mkdirSync(CACHE, {recursive: true});
  const dir = mkdtempSync(resolve(CACHE, 'test-scope-'));
  const script = resolve(dir, 'hold.mjs');
  writeFileSync(script, "if (process.env.DEMO_IN_SCOPE !== '1') process.exit(9); await new Promise(r => setTimeout(r, 1500));\n");
  try {
    const first = relaunch(script, [], {memory: '256M', cpu: '50%', quiet: true});
    await new Promise(r => setTimeout(r, 500));
    const second = await relaunch(script, [], {memory: '256M', cpu: '50%', quiet: true});
    assert.equal(second, 75, 'the second run is refused while the first holds the lock');
    assert.equal(await first, 0, 'the first run ran inside the scope');
    assert.equal(await relaunch(script, [], {memory: '256M', cpu: '50%', quiet: true}), 0, 'the lock is free again');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a crashed recorder keeps the lock until its leftover processes are gone (stopped after 5 s)', async () => {
  mkdirSync(CACHE, {recursive: true});
  const dir = mkdtempSync(resolve(CACHE, 'test-crash-'));
  const script = resolve(dir, 'crash.mjs');
  // Starts a long child (like an ffmpeg) and dies at once without cleaning up.
  writeFileSync(script, "import {spawn} from 'node:child_process'; spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'ignore'}); process.kill(process.pid, 'SIGKILL');\n");
  try {
    const started = Date.now();
    const first = relaunch(script, [], {memory: '256M', cpu: '50%', quiet: true});
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(await relaunch(script, [], {memory: '256M', cpu: '50%', quiet: true}), 75, 'still locked while the leftover child runs');
    assert.equal(await first, 137, 'the crash is reported (killed)');
    const took = Date.now() - started;
    assert.ok(took > 4500 && took < 9000, `the leftover was stopped after ~5 s (${took} ms)`);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
