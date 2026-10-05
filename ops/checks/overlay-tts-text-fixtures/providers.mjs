// Test-only provider boundaries; synthesis returns a disposable WAV.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') return new Response(JSON.stringify(url.pathname === '/' ? { version: '1.18.0' }
    : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } }), { headers: { 'Content-Type': 'application/json' } });
  if (url.hostname === 'piper.test' && url.pathname === '/synthesize') {
    const wav = Buffer.alloc(44 + 32000); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
    return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
  }
  throw new Error(`External request blocked in TTS text test: ${url.origin}${url.pathname}`);
};
