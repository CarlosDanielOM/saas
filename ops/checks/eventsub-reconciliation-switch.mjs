import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

const workerEntry = path.join(process.cwd(), 'dist/workers/eventsub_reconciliation.worker.js');
const supervisorEntry = path.join(process.cwd(), 'dist/workers/cron.index.js');

function runNode(entry, args, env, { timeoutMs = 30000, killAfterMs } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [entry, ...args], {
            cwd: process.cwd(),
            env: { ...process.env, ...env }
        });
        let output = '';
        let timedOut = false;
        const capture = (chunk) => { output += chunk.toString(); };
        child.stdout.on('data', capture);
        child.stderr.on('data', capture);
        const hardTimer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        const killTimer = killAfterMs ? setTimeout(() => child.kill('SIGKILL'), killAfterMs) : null;
        child.on('close', (code, signal) => {
            clearTimeout(hardTimer);
            if (killTimer) clearTimeout(killTimer);
            resolve({ code, signal, output, timedOut });
        });
    });
}

const disabled = await runNode(workerEntry, [], { EVENTSUB_RECONCILIATION_ENABLED: 'false' });
assert.equal(disabled.timedOut, false, 'disabled worker must exit immediately instead of starting its loop');
assert.equal(disabled.code, 0, `disabled worker must exit 0 (got ${disabled.code}/${disabled.signal})`);
assert.match(disabled.output, /EventSub reconciliation worker disabled/, 'disabled acknowledgement missing');
assert.doesNotMatch(disabled.output, /Dry run mode/, 'disabled worker must not continue into reconciliation setup');

const enabled = await runNode(workerEntry, ['--dry-run'], {});
assert.equal(enabled.timedOut, false, 'enabled worker dry run must exit');
assert.equal(enabled.code, 0, `enabled worker dry run must exit 0 (got ${enabled.code}/${enabled.signal})`);
assert.match(enabled.output, /Dry run mode - resolved configuration/, 'default worker must remain enabled');
assert.doesNotMatch(enabled.output, /worker disabled/, 'default must not disable the worker');

const supervisor = await runNode(
    supervisorEntry,
    ['--once', '--dry-run'],
    { EVENTSUB_RECONCILIATION_ENABLED: 'false' },
    { timeoutMs: 90000, killAfterMs: 25000 }
);
const startedNames = [...supervisor.output.matchAll(
    /message: ['"]Started cron worker process['"],\s*name: ['"]([^'"]+)['"]/g
)].map((match) => match[1]);
const skippedNames = [...supervisor.output.matchAll(
    /message: ['"]Cron worker disabled; not starting['"],\s*name: ['"]([^'"]+)['"]/g
)].map((match) => match[1]);
assert.deepEqual(skippedNames, ['eventsub-reconciliation'], `supervisor must skip exactly the disabled worker (got ${JSON.stringify(skippedNames)})`);
assert.ok(startedNames.length >= 12, `supervisor must still start the other workers (got ${JSON.stringify(startedNames)})`);
assert.ok(!startedNames.includes('eventsub-reconciliation'), 'supervisor must not spawn the disabled worker');
assert.match(
    supervisor.output,
    /message: ['"]Cron worker disabled; not starting['"],\s*name: ['"]eventsub-reconciliation['"],\s*enabledEnv: ['"]EVENTSUB_RECONCILIATION_ENABLED['"]/,
    'supervisor must report the switch that disabled the worker'
);

console.log('eventsub-reconciliation kill-switch check passed');
