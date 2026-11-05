import assert from 'node:assert/strict';
import test from 'node:test';
import { createBadgeCache } from './badges.js';

function response(title: string) {
  return new Response(JSON.stringify({ data: [{ set_id: 'subscriber', versions: [{
    id: '1', title, image_url_1x: 'one', image_url_2x: 'two', image_url_4x: 'four'
  }] }] }), { status: 200 });
}

test('fetches the correct Helix endpoints with app headers and channel badges override globals', async () => {
  const requests: string[] = [];
  const lookup = createBadgeCache({ now: () => 0, header: async () => ({ Authorization: 'Bearer fixture', 'Client-Id': 'fixture' }),
    fetch: async (url, options) => {
      requests.push(String(url));
      assert.deepEqual(options?.headers, { Authorization: 'Bearer fixture', 'Client-Id': 'fixture' });
      assert.ok(options?.signal);
      return response(String(url).endsWith('/global') ? 'Global' : 'Channel');
    } });
  const result = await lookup('123');
  assert.deepEqual(requests.sort(), ['https://api.twitch.tv/helix/chat/badges/global', 'https://api.twitch.tv/helix/chat/badges?broadcaster_id=123'].sort());
  assert.deepEqual(result.get('subscriber/1'), { title: 'Channel', images: { '1x': 'one', '2x': 'two', '4x': 'four' } });
});

test('de-duplicates in-flight requests; global TTL is six hours and channel TTL one hour', async () => {
  let now = 0, global = 0, channel = 0;
  const lookup = createBadgeCache({ now: () => now, header: async () => ({}), fetch: async url => {
    if (String(url).endsWith('/global')) global++; else channel++;
    return response('Badge');
  } });
  await Promise.all(Array.from({ length: 10 }, () => lookup('123')));
  assert.deepEqual([global, channel], [1, 1]);
  now = 60 * 60_000 - 1; await lookup('123');
  assert.deepEqual([global, channel], [1, 1]);
  now++; await lookup('123');
  assert.deepEqual([global, channel], [1, 2]);
  now = 6 * 60 * 60_000; await lookup('123');
  assert.deepEqual([global, channel], [2, 3]);
});

test('failed lookups are cached for sixty seconds, never throw, and retain known badges', async () => {
  let now = 0, calls = 0, fail = false;
  const lookup = createBadgeCache({ now: () => now, header: async () => ({}), fetch: async () => {
    calls++;
    if (fail) throw new Error('offline');
    return response('Known');
  } });
  await lookup('123');
  fail = true; now = 6 * 60 * 60_000;
  assert.equal((await lookup('123')).get('subscriber/1')?.title, 'Known');
  assert.equal(calls, 4);
  now += 59_999; await lookup('123'); assert.equal(calls, 4);
  now++; await lookup('123'); assert.equal(calls, 6);

  const unavailable = createBadgeCache({ now: () => 0, header: async () => { throw new Error('no token'); }, fetch: async () => assert.fail('No HTTP request') });
  assert.equal((await unavailable('123')).size, 0);
  const malformed = createBadgeCache({ now: () => 0, header: async () => ({}), fetch: async () => new Response('{}') });
  assert.equal((await malformed('123')).size, 0);
  const denied = createBadgeCache({ now: () => 0, header: async () => ({}), fetch: async () => new Response('{}', { status: 403 }) });
  assert.equal((await denied('123')).size, 0);
});

test('bounds channel cache at 500 with recently accessed channels retained', async () => {
  const counts = new Map<string, number>();
  const lookup = createBadgeCache({ now: () => 0, header: async () => ({}), fetch: async url => {
    const key = String(url);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return response('Badge');
  } });
  for (let channel = 0; channel < 500; channel++) await lookup(String(channel));
  await lookup('0');
  await lookup('500');
  await lookup('0');
  await lookup('1');
  assert.equal(counts.get('https://api.twitch.tv/helix/chat/badges?broadcaster_id=0'), 1);
  assert.equal(counts.get('https://api.twitch.tv/helix/chat/badges?broadcaster_id=1'), 2);
  assert.equal(counts.get('https://api.twitch.tv/helix/chat/badges/global'), 1);
});
