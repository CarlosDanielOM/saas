// Keep the actual cron supervisor and changed moderation worker. Unchanged
// workers stay idle so this focused check fits the helper's container limit.
import './providers.mjs';
import { registerHooks } from 'node:module';
registerHooks({
    load(url, context, nextLoad) {
        if (url.startsWith('file:///app/dist/workers/') && url.endsWith('.worker.js')
            && !url.endsWith('/semantic_moderation.worker.js')) {
            return { format: 'module', source: 'setInterval(() => {}, 1000);', shortCircuit: true };
        }
        return nextLoad(url, context);
    }
});
