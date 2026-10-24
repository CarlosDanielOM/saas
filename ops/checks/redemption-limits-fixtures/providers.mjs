// Fake Twitch for the redemption limits check. Every external request stays inside
// saas-ops' private test network; Helix reward calls are applied to an in-memory store
// and recorded in the disposable Dragonfly so the check can assert what Twitch received.
import { createRequire } from 'node:module';
const { createClient } = createRequire('/app/package.json')('redis');
let redis;
async function cache() {
  if (!redis) { redis = createClient({ url: 'redis://redis:6379' }); await redis.connect(); }
  return redis;
}

const rewards = new Map();
let seq = 0;
const CREATE_FIELDS = new Set(['title', 'cost', 'prompt', 'is_enabled', 'background_color', 'is_user_input_required',
  'is_max_per_stream_enabled', 'max_per_stream', 'is_max_per_user_per_stream_enabled', 'max_per_user_per_stream',
  'is_global_cooldown_enabled', 'global_cooldown_seconds', 'should_redemptions_skip_request_queue']);

function twitchError(status, message) {
  return Response.json({ error: status === 400 ? 'Bad Request' : 'Error', status, message }, { status });
}

function apply(reward, body) {
  for (const [key, value] of Object.entries(body)) {
    if (key === 'is_max_per_stream_enabled') reward.max_per_stream_setting.is_enabled = value;
    else if (key === 'max_per_stream') reward.max_per_stream_setting.max_per_stream = value;
    else if (key === 'is_max_per_user_per_stream_enabled') reward.max_per_user_per_stream_setting.is_enabled = value;
    else if (key === 'max_per_user_per_stream') reward.max_per_user_per_stream_setting.max_per_user_per_stream = value;
    else if (key === 'is_global_cooldown_enabled') reward.global_cooldown_setting.is_enabled = value;
    else if (key === 'global_cooldown_seconds') reward.global_cooldown_setting.global_cooldown_seconds = value;
    else if (CREATE_FIELDS.has(key) || key === 'is_paused') reward[key] = value;
  }
}

/** Mirrors Twitch's documented rules: a limit that's on needs a value of at least 1. */
function invalid(body) {
  if (body.is_max_per_stream_enabled === true && !(body.max_per_stream >= 1)) return 'max_per_stream must be at least 1';
  if (body.is_max_per_user_per_stream_enabled === true && !(body.max_per_user_per_stream >= 1)) return 'max_per_user_per_stream must be at least 1';
  if (body.is_global_cooldown_enabled === true && !(body.global_cooldown_seconds >= 1 && body.global_cooldown_seconds <= 604800)) return 'bad cooldown';
  return null;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') return Response.json(
    url.pathname === '/' ? { version: '1.18.0' } : { status: 'ok', time: 0, result:
      url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });

  const method = (options.method || 'GET').toUpperCase();
  if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/channel_points/custom_rewards') {
    const body = options.body ? JSON.parse(options.body) : null;
    await (await cache()).rPush('redemption-limits:helix', JSON.stringify({ method, query: Object.fromEntries(url.searchParams), body }));
    if (method === 'GET') return Response.json({ data: [...rewards.values()] });
    if (method === 'DELETE') { rewards.delete(url.searchParams.get('id')); return new Response(null, { status: 204 }); }
    const problem = invalid(body);
    if (problem) return twitchError(400, problem);
    if (method === 'POST') {
      if ([...rewards.values()].some((r) => r.title.toLowerCase() === String(body.title).toLowerCase())) {
        return twitchError(400, 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD');
      }
      const reward = {
        id: `reward-${++seq}`, broadcaster_id: url.searchParams.get('broadcaster_id'), broadcaster_login: 'limits_owner',
        title: '', prompt: '', cost: 1, is_enabled: true, background_color: '#9146FF', is_user_input_required: false,
        is_paused: false, is_in_stock: true, should_redemptions_skip_request_queue: false, image: null,
        default_image: { url_1x: '', url_2x: '', url_4x: '' },
        max_per_stream_setting: { is_enabled: false, max_per_stream: 0 },
        max_per_user_per_stream_setting: { is_enabled: false, max_per_user_per_stream: 0 },
        global_cooldown_setting: { is_enabled: false, global_cooldown_seconds: 0 },
        redemptions_redeemed_current_stream: null, cooldown_expires_at: null
      };
      apply(reward, body);
      rewards.set(reward.id, reward);
      return Response.json({ data: [reward] });
    }
    if (method === 'PATCH') {
      const reward = rewards.get(url.searchParams.get('id'));
      if (!reward) return twitchError(404, 'reward not found');
      apply(reward, body);
      return Response.json({ data: [reward] });
    }
  }
  if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/eventsub/subscriptions' && method === 'POST') {
    const body = JSON.parse(options.body);
    return Response.json({ data: [{ id: `sub-${++seq}`, status: 'enabled', type: body.type, version: body.version,
      condition: body.condition, created_at: new Date().toISOString(), transport: { method: 'webhook' }, cost: 0 }] });
  }
  if (url.hostname === 'api.twitch.tv' && method === 'GET') return Response.json({ data: [] });
  throw new Error(`External request blocked in redemption limits test: ${method} ${url.origin}${url.pathname}`);
};
