// Test-only provider boundary; disposable Mongo/Redis are supplied by saas-ops.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') return new Response(JSON.stringify(
    url.pathname === '/' ? { version: '1.18.0' } : { status: 'ok', time: 0, result:
      url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } }
  ), { headers: { 'Content-Type': 'application/json' } });
  throw new Error(`External request blocked in overlay controls test: ${url.origin}${url.pathname}`);
};

// The real cron supervisor runs; unrelated background workers are replaced to
// keep this feature check focused on the real timer renderer and overlay AST.
if (process.argv[1]?.endsWith('/dist/workers/cron.index.js')) {
  const { registerHooks } = await import('node:module');
  setInterval(() => {}, 1000);
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier !== 'node:child_process') return nextResolve(specifier, context);
    const source = "import { EventEmitter } from 'node:events'; export const spawn = () => { const child = new EventEmitter(); child.pid = 1; child.kill = () => true; return child; };";
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  } });
}
