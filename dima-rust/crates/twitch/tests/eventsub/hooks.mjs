// Module hooks for `record.mts`: the reference's own modules run as they are, except the three
// that would open connections or read the environment at import time; those resolve to the
// stubs next to this file, which answer from the fixture the recorder sets.
const STUBS = {
  'src/utils/tokens': 'stubs/tokens.mjs',
  'src/classes/twitch_streamers.class': 'stubs/twitch_streamers.mjs',
  'src/utils/logger': 'stubs/logger.mjs',
};

export async function resolve(specifier, context, next) {
  if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const target = new URL(specifier, context.parentURL).pathname.replace(/\.(js|ts)$/, '');
    for (const [suffix, stub] of Object.entries(STUBS)) {
      if (target.endsWith(`/${suffix}`)) {
        return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}
