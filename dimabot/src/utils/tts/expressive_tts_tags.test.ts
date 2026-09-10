import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { DEFAULT_TTS_SETTINGS, normalizeChannelTtsSettings } from '../../schemas/channel_tts_settings.schema.js';
import {
  EXPRESSIVE_TTS_TAGS,
  filterExpressiveTtsTags,
  reinforceFishTtsTags,
} from './expressive_tts_tags.util.js';

test('Fish silently doubles each single allowed cue, including cues after the spoken username', () => {
  assert.equal(
    reinforceFishTtsTags('Viewer dice: [whisper] Secret. [happy] We won! [whisper] Another secret.'),
    'Viewer dice: [whisper] [whisper] Secret. [happy] [happy] We won! [whisper] [whisper] Another secret.',
  );
});

test('manual doubles and retries do not multiply the cues again', () => {
  const text = '[whisper] [whisper] Secret. [angry][angry] Stop.';
  assert.equal(reinforceFishTtsTags(text), text);
  const expanded = reinforceFishTtsTags('[singing] Hello!');
  assert.equal(reinforceFishTtsTags(expanded), expanded);
});

test('reinforcement respects filtered settings and does not duplicate unknown markers', () => {
  const text = filterExpressiveTtsTags('[anger] Stop. [whisper] Secret.', {
    provider: 'fish',
    enabledTags: { ...DEFAULT_TTS_SETTINGS.filters.expressiveTags, whisper: false },
  });
  assert.equal(reinforceFishTtsTags(text), '[angry] [angry] Stop. Secret.');
  assert.equal(reinforceFishTtsTags('[link] [unknown]'), '[link] [unknown]');
});

test('the Fish expressive catalog exposes 30 independently configurable cues', () => {
  assert.equal(EXPRESSIVE_TTS_TAGS.length, 30);
  for (const tag of ['whisper', 'angry', 'happy', 'singing', 'laugh', 'pause']) {
    assert.equal(EXPRESSIVE_TTS_TAGS.includes(tag as never), true, `missing [${tag}]`);
  }

  assert.equal(Object.keys(DEFAULT_TTS_SETTINGS.filters.expressiveTags).length, 30);
  assert.equal(Object.values(DEFAULT_TTS_SETTINGS.filters.expressiveTags).every(Boolean), true);
});

test('the frontend cue catalog matches the backend allowlist', () => {
  const source = readFileSync(new URL('../../../../dimasite/src/app/models/tts-settings.model.ts', import.meta.url), 'utf8');
  const catalog = source.match(/EXPRESSIVE_TTS_TAGS = \[([\s\S]*?)\] as const/)?.[1] ?? '';
  assert.deepEqual([...catalog.matchAll(/'([^']+)'/g)].map(match => match[1]), [...EXPRESSIVE_TTS_TAGS]);
});

test('Fish keeps enabled cues and strips disabled or unsupported bracket cues', () => {
  const enabledTags = { ...DEFAULT_TTS_SETTINGS.filters.expressiveTags, angry: false };

  assert.equal(
    filterExpressiveTtsTags('[happy] Hello [angry] no [made-up] [laugh]', {
      provider: 'fish',
      enabledTags,
    }),
    '[happy] Hello no [laugh]',
  );
});

test('common cue aliases are governed by the canonical streamer setting', () => {
  const enabledTags = { ...DEFAULT_TTS_SETTINGS.filters.expressiveTags, angry: true, whisper: true };
  assert.equal(
    filterExpressiveTtsTags('[anger] Stop. [whispering] Secret.', { provider: 'fish', enabledTags }),
    '[angry] Stop. [whisper] Secret.',
  );

  enabledTags.angry = false;
  assert.equal(
    filterExpressiveTtsTags('[anger] Stop.', { provider: 'fish', enabledTags }),
    'Stop.',
  );
});

test('Piper strips expressive cues without removing their spoken text', () => {
  assert.equal(
    filterExpressiveTtsTags('[whisper] Keep this <loud>message</loud> [sigh]', { provider: 'piper' }),
    'Keep this message',
  );
});

test('settings normalization defaults new tags on and preserves explicit choices', () => {
  const settings = normalizeChannelTtsSettings({
    filters: {
      skipEmotes: true,
      stripLinks: true,
      normalizeWhitespace: true,
      maxLength: 280,
      expressiveTags: {
        ...DEFAULT_TTS_SETTINGS.filters.expressiveTags,
        angry: false,
      },
    },
  }, 'channel-1');

  assert.equal(settings.filters.expressiveTags.angry, false);
  assert.equal(settings.filters.expressiveTags.happy, true);
});
