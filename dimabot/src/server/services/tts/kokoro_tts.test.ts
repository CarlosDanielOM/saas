import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kokoro-test-'));
mock.module('./piper_tts.service.js', { namedExports: {
    PIPER_PUBLIC_SPEECH_DIR: outputDir, buildPublicPath: () => '/speech/audio/test/line'
} });
const { kokoroTtsService } = await import('./kokoro_tts.service.js');
const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await fs.rm(outputDir, { recursive: true, force: true });
});
const request = { channelID: 'test', speechID: 'line', mode: 'speak', provider: 'kokoro',
    text: 'Hello chat!', language: 'en', voice: 'af_heart', outputPath: '' } as const;

test('Kokoro sends preset voices to DeepInfra only and writes playable MP3 output', async () => {
    process.env.OPENROUTER_API_KEY = 'test-only';
    const audio = Buffer.from('ID3test-audio');
    let calls = 0;
    globalThis.fetch = async (input, options) => {
        calls++;
        assert.equal(String(input), 'https://openrouter.ai/api/v1/audio/speech');
        assert.deepEqual(JSON.parse(String(options?.body)), {
            model: 'hexgrad/kokoro-82m', input: request.text, voice: 'af_heart', response_format: 'mp3',
            provider: { only: ['deepinfra'], order: ['deepinfra'], allow_fallbacks: false }
        });
        assert.ok(options?.signal);
        return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } });
    };
    const result = await kokoroTtsService.synthesize(request);
    assert.equal(result.error, false);
    assert.equal(result.mimeType, 'audio/mpeg');
    assert.deepEqual(await fs.readFile(result.outputPath!), audio);
    assert.equal(calls, 1);
});

test('unsupported voice, empty input and missing credentials never call a paid endpoint', async () => {
    globalThis.fetch = async () => { throw new Error('Must not call provider'); };
    assert.equal((await kokoroTtsService.synthesize({ ...request, voice: 'gojo' })).error, true);
    assert.equal((await kokoroTtsService.synthesize({ ...request, text: ' ' })).error, true);
    delete process.env.OPENROUTER_API_KEY;
    assert.equal((await kokoroTtsService.synthesize(request)).error, true);
});

test('provider errors, JSON and empty audio return failures for the Piper fallback', async () => {
    process.env.OPENROUTER_API_KEY = 'test-only';
    for (const response of [new Response('{}', { status: 503 }), new Response('{}', {
        headers: { 'content-type': 'application/json' }
    }), new Response(new Uint8Array(), { headers: { 'content-type': 'audio/mpeg' } })]) {
        globalThis.fetch = async () => response;
        assert.equal((await kokoroTtsService.synthesize(request)).error, true);
    }
});
