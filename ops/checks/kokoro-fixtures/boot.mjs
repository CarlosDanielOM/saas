import { registerHooks } from 'node:module';

const modules = new Map();
const add = (path, source) => modules.set(`file:///app/dist/${path}.js`, source);

if (process.env.SAAS_AST_BOOT_KIND === 'bot') {
    add('utils/databases/qdrant.database', 'export const getQdrantConnection = async () => ({});');
    add('classes/pubsub_manager.class', 'export const pubSubManager = { init: async () => {}, subscribe: async () => {} };');
    add('classes/twitch_streamers.class', 'export default { getTwitchAccountsFromDB: async () => [], getTwitchAccountById: async () => null };');
    add('bot/eventsub.twitch', 'export const twitchEventsub = () => {};');
    add('utils/observability/bot_runtime_metrics', 'export const startBotRuntimeMetricsLoop = () => {};');
    add('utils/opentelemetry_posthog', 'export default () => ({ start: () => {} });');
    add('utils/ast_timer_runtime', 'export const startAstTimerScheduler = async () => {};');
    add('utils/ai/ast_catalog/index', 'export const ensureAstCatalogVectors = async () => {};');
}

if (process.env.SAAS_AST_BOOT_KIND === 'cron' && process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
    // Fake child processes do not hold the event loop open like real workers.
    setInterval(() => {}, 1000);
    modules.set('node:child_process', `import { EventEmitter } from 'node:events';
        export const spawn = () => { const child = new EventEmitter(); child.pid = 1; child.kill = () => true; return child; };`);
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        const replacement = modules.get(resolved.url);
        if (!replacement) return resolved;
        return { url: `data:text/javascript,${encodeURIComponent(replacement)}`, shortCircuit: true };
    }
});
