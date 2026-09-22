const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);

  if (url.hostname === 'qdrant.invalid') {
    const body = url.pathname === '/collections'
      ? { result: { collections: [] }, status: 'ok', time: 0 }
      : { result: true, status: 'ok', time: 0 };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (url.hostname === 'api.polar.sh' && url.pathname.replace(/\/$/, '') === '/v1/events/ingest') {
    return new Response(JSON.stringify({
      error: 'insufficient_scope',
      error_description: 'The request requires higher privileges than provided by the access token.',
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (url.hostname === 'us.i.posthog.com') {
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }

  return realFetch(input, init);
};
