// Module hooks of record.mts (registered with `module.register`, after tsx's own).
//
// - A module of the reference listed in STUBS is replaced by the stub of the same name in
//   `stubs/`. Each stub re-exports the real module (`export * from 'real:<file>'`) and overrides
//   only the functions the message handler calls, recording each call; so every other importer of
//   the module still links.
// - `real:<file>` is `$DIMABOT_DIR/src/<file>` with the query `?real`, which this hook never
//   replaces (the stub's own import of the module it wraps).
const STUBS = {
  'src/handlers/moderation.handler': 'moderation.mjs',
  'src/utils/ai/openrouter/ai': 'ai.mjs',
  'src/utils/ai/threading/thread_router': 'thread_router.mjs',
  'src/functions/promo/chat.promo': 'promo.mjs',
  'src/commands/shoutout.command': 'shoutout.mjs',
  'src/commands/index.commands': 'index_commands.mjs',
  'src/functions/chats/announcement.chat': 'announcement.mjs',
  'src/functions/chats/clear_chat.chat': 'clear_chat.mjs',
  'src/commands/command_manager.command': 'command_manager.mjs',
  'src/commands/timer_manager.command': 'timer_manager.mjs',
  'src/utils/siteanalytics': 'siteanalytics.mjs',
  'src/utils/qdrant/functions/chat_logs/store_chat_log.qdrant': 'store_chat_log.mjs',
  'src/utils/observability/bot_runtime_metrics': 'metrics.mjs',
  'src/utils/posthog_events': 'posthog.mjs',
  'src/widget_feed/publisher': 'widget_feed.mjs',
  'src/utils/logger': 'logger.mjs',
  'src/utils/stream_analytics': 'stream_analytics.mjs',
  'src/functions/chats/send_message.chat': 'send_message.mjs',
};

export async function resolve(specifier, context, next) {
  // The native `re2` package is not installed outside the production image; only the moderation
  // modules import it, and moderation is a stub here, so a stand-in that loads is enough.
  if (specifier === 're2') {
    return { url: new URL('./stubs/re2.mjs', import.meta.url).href, format: 'module', shortCircuit: true };
  }
  if (specifier.startsWith('real:')) {
    const root = process.env.DIMABOT_DIR;
    if (!root) throw new Error('DIMABOT_DIR is not set');
    return next(`file://${root}/src/${specifier.slice(5)}?real`, context);
  }
  const result = await next(specifier, context);
  if (result.url.includes('?real')) return result;
  const bare = result.url.split('?')[0].replace(/\.(ts|js|mts|mjs)$/, '');
  for (const [suffix, file] of Object.entries(STUBS)) {
    if (bare.endsWith(`/${suffix}`)) {
      return { url: new URL(`./stubs/${file}`, import.meta.url).href, format: 'module', shortCircuit: true };
    }
  }
  return result;
}
