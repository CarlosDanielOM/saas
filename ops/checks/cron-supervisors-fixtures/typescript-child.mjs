// Executes under the actual TS WorkerSupervisor with no application/provider code.
import assert from 'node:assert/strict';
assert.equal(process.env.CRON_WORKER_NAME, 'follow-ledger');
assert.deepEqual(Object.keys(process.env).sort(), ['CRON_WORKER_NAME', 'PATH']);
if (!process.argv.includes('--once') && !process.argv.includes('--dry-run')) {
    const timer = setInterval(() => {}, 1000);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { clearInterval(timer); process.exit(0); });
}
