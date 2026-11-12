// Stub of utils/header.ts: the streamer's header as getTwitchStreamerHeaderById returns it,
// with a test token. record.mts sets globalThis.__headerFailure to make it fail.
export async function getTwitchStreamerHeaderById(id) {
  const failure = globalThis.__headerFailure;
  if (failure) return { error: true, message: failure.replace('{id}', id), status: 403 };
  return {
    error: false,
    header: {
      'Client-Id': 'test-client-id',
      Authorization: `Bearer streamer-token-${id}`,
      'Content-Type': 'application/json',
    },
  };
}
