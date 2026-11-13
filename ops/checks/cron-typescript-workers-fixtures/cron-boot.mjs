// Preload for the cron candidate in ops/checks/cron-typescript-workers.mjs.
// The real supervisor starts only the seven workers under test; every other
// registered worker becomes an inert child, so nothing unrelated touches the
// disposable databases or calls a provider. No application code is replaced.
import { registerHooks } from 'node:module';

const UNDER_TEST = ['dashboard_activity', 'raid_analytics', 'stream_activity', 'roulette_completion',
    'follow_defense_baseline', 'raid_sessions', 'ai_usage_receipts'];
globalThis.__cronCheckUnderTest = UNDER_TEST;
const source = `
import { spawn as actual } from 'node:child_process';
import { EventEmitter } from 'node:events';
const real = new RegExp('/(' + globalThis.__cronCheckUnderTest.join('|') + ')\\\\.worker\\\\.(js|ts)$');
export const spawn = (command, args, options) => {
    if (real.test(String(args?.[0] ?? ''))) return actual(command, args, options);
    const child = new EventEmitter();
    Object.assign(child, { pid: 0, exitCode: null, signalCode: null, kill: () => true });
    return child;
};`;
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'node:child_process' && /\/workers\/cron\.index\.(js|ts)$/.test(context.parentURL ?? '')) {
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});
