import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { DEFAULT_TTS_SETTINGS, normalizeChannelTtsSettings, ChannelTtsSettingsSchema } from '../../schemas/channel_tts_settings.schema.js';
import {
  EXPRESSIVE_TTS_TAGS,
  filterExpressiveTtsTags,
  reinforceFishTtsTags,
  normalizeExpressiveTtsTags,
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

test('the Fish expressive catalog exposes 75 independently configurable cues', () => {
  assert.equal(EXPRESSIVE_TTS_TAGS.length, 75);
  assert.equal(new Set(EXPRESSIVE_TTS_TAGS).size, 75);
  for (const tag of ['whisper', 'angry', 'happy', 'singing', 'laugh', 'pause']) {
    assert.equal(EXPRESSIVE_TTS_TAGS.includes(tag as never), true, `missing [${tag}]`);
  }

  assert.equal(Object.keys(DEFAULT_TTS_SETTINGS.filters.expressiveTags).length, 75);
  assert.equal(Object.values(DEFAULT_TTS_SETTINGS.filters.expressiveTags).every(Boolean), true);
});

test('the frontend cue catalog matches the backend allowlist', () => {
  const source = readFileSync(new URL('../../../../dimasite/src/app/models/tts-settings.model.ts', import.meta.url), 'utf8');
  const catalog = source.match(/EXPRESSIVE_TTS_TAG_GROUPS = \{([\s\S]*?)\} as const/)?.[1] ?? '';
  assert.deepEqual([...catalog.matchAll(/'([^']+)'/g)].map(match => match[1]), [...EXPRESSIVE_TTS_TAGS]);
});

test('all 75 cues honor the toggle and are reinforced, including named multiword effects', () => {
  for (const tag of EXPRESSIVE_TTS_TAGS) {
    const input = `[${tag}] Hello`;
    const allowed = filterExpressiveTtsTags(input, { provider: 'fish', enabledTags: normalizeExpressiveTtsTags() });
    assert.equal(reinforceFishTtsTags(allowed), `[${tag}] [${tag}] Hello`);
    assert.equal(reinforceFishTtsTags(reinforceFishTtsTags(allowed)), `[${tag}] [${tag}] Hello`);
    const disabled = filterExpressiveTtsTags(input, { provider: 'fish', enabledTags: normalizeExpressiveTtsTags({ [tag]: false }) });
    assert.equal(reinforceFishTtsTags(disabled), 'Hello');
    assert.equal(filterExpressiveTtsTags(input), 'Hello');
  }
});

test('expansion retains old disabled choices and persists named effects through the schema', () => {
  const oldTags = ['happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident',
    'surprised', 'scared', 'worried', 'disappointed', 'curious', 'sarcastic',
    'whisper', 'shouting', 'soft', 'singing', 'slow', 'fast', 'emphasis',
    'laugh', 'chuckle', 'giggle', 'cry', 'sigh', 'gasp', 'inhale', 'exhale', 'pause', 'long-pause'];
  const tags = normalizeExpressiveTtsTags(Object.fromEntries(oldTags.map(tag => [tag, false])));
  for (const tag of oldTags) assert.equal(tags[tag as keyof typeof tags], false);
  assert.equal(Object.values(tags).filter(Boolean).length, 45);
  tags['clear throat'] = false;
  const document = new ChannelTtsSettingsSchema({ channelID: 'test', filters: { expressiveTags: tags } });
  assert.equal(document.validateSync(), undefined);
  const restored = normalizeChannelTtsSettings(document.toObject(), 'test').filters.expressiveTags;
  assert.deepEqual(restored, tags);
});

test('custom phrases remain disallowed while named effects and their aliases are supported', () => {
  const enabledTags = normalizeExpressiveTtsTags({ 'audience laughing': false });
  assert.equal(filterExpressiveTtsTags('[whispers sweetly] [crowd laughing] [clear throat] Hello', {
    provider: 'fish', enabledTags,
  }), '[clear throat] Hello');
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
