// Only loaded in a saas-ops disposable candidate. Never permits internet access.
import { appendFileSync, readFileSync } from 'node:fs';
const originalFetch = globalThis.fetch;
const root = '/tmp/saas-fixtures';
const control = () => { try { return JSON.parse(readFileSync(`${root}/control.json`, 'utf8')); } catch { return {}; } };
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') return Response.json(url.pathname === '/' ? { version: '1.18.0' }
    : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
  if (url.hostname !== 'api.twitch.tv') throw new Error(`Blocked outbound provider: ${url.origin}${url.pathname}`);
  const state = control();
  const body = options.body ? JSON.parse(String(options.body)) : undefined;
  appendFileSync(`${root}/calls.jsonl`, JSON.stringify({ path: url.pathname, query: Object.fromEntries(url.searchParams), body }) + '\n');
  if (url.pathname === '/helix/users') {
    const login = url.searchParams.get('login');
    return Response.json({ data: login === 'friendlystreamer' ? [{ id: '900200', login, display_name: 'FriendlyStreamer',
      description: 'Fixture streamer', profile_image_url: 'https://example.test/avatar.png' }] : [] });
  }
  if (url.pathname === '/helix/channels') return Response.json({ data: [{ broadcaster_id: '900200',
    broadcaster_login: 'friendlystreamer', broadcaster_name: 'FriendlyStreamer', game_id: '123', game_name: 'Fixture Game', title: 'Fixture stream' }] });
  if (url.pathname === '/helix/chat/announcements') {
    if (state.announcement === 'throw') throw new Error('Fixture announcement network failure');
    return state.announcement === 'fail' ? Response.json({ error: 'Forbidden', message: 'Fixture announcement rejected' }, { status: 403 })
      : new Response(null, { status: 204 });
  }
  if (url.pathname === '/helix/chat/shoutouts') return state.shoutout === 'cooldown'
    ? Response.json({ error: 'Too Many Requests', message: 'Fixture shoutout cooldown' }, { status: 429 }) : new Response(null, { status: 204 });
  if (url.pathname === '/helix/chat/messages') return Response.json({ data: [{ message_id: 'fixture-chat', is_sent: true }] });
  if (url.pathname === '/helix/clips') return Response.json({ data: state.noClips ? [] : [{ id: 'fixture-clip',
    url: 'https://clips.twitch.tv/FixtureClip', duration: 15, game_id: '123', broadcaster_id: '900200' }] });
  if (url.pathname === '/helix/chat/color') return Response.json({ data: [{ user_id: '900200', color: '#9146FF' }] });
  if (url.pathname === '/helix/games') return Response.json({ data: [{ id: '123', name: 'Fixture Game', box_art_url: '' }] });
  throw new Error(`Blocked unexpected Twitch request: ${url.pathname}`);
};
