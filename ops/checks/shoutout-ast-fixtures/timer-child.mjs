import { readFileSync } from 'node:fs';
Object.assign(process.env, JSON.parse(readFileSync('/tmp/saas-fixtures/test-env.json', 'utf8')));
await import('./providers.mjs');
await import('/app/dist/workers/timer.worker.js');
