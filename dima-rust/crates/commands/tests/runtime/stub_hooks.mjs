// Module hooks for record.mts: the modules below are replaced by the stubs next to this file,
// so loading the reference starts no telemetry, logger, metrics loop or Twitch credential
// lookup. Everything else (Mongoose models, the Dragonfly client, the functions recorded) is
// the real reference code.
const STUBS = {
  'src/utils/logger': 'logger.mjs',
  'src/utils/observability/bot_runtime_metrics': 'metrics.mjs',
  'src/utils/observability/telemetry': 'telemetry.mjs',
  'src/utils/header': 'header.mjs',
  'src/utils/command_cooldown_write': 'cooldown_write.mjs',
};

export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  const bare = result.url.split('?')[0].replace(/\.(ts|js|mts|mjs)$/, '');
  for (const [suffix, file] of Object.entries(STUBS)) {
    if (bare.endsWith(`/${suffix}`)) {
      return { url: new URL(`./stubs/${file}`, import.meta.url).href, format: 'module', shortCircuit: true };
    }
  }
  return result;
}
