// Shared realistic fixture + API mock for stream timeline screenshots/checks.
export const twitch = { id: '533538623', login: 'fixture', display_name: 'Fixture' };
export function makeApp(plan = 'pro') {
  return { name: 'Fixture', email: 'fixture@example.invalid', language: 'en', plan_tier: plan, actived: true, chat_enabled: true, twitch_user_id: twitch.id, has_permissions: true, up_to_date_permissions: true, administrating: [] };
}
export const id = 'a'.repeat(24), id2 = 'b'.repeat(24), id3 = 'd'.repeat(24);
const startedAt = '2026-10-12T18:00:00.000Z';
export const sessions = [
  { id, startedAt, endedAt: '2026-10-12T21:00:00.000Z', status: 'offline' },
  { id: id2, startedAt: '2026-10-10T18:30:00.000Z', endedAt: '2026-10-10T20:45:00.000Z', status: 'offline' },
  { id: id3, startedAt: '2026-10-08T19:00:00.000Z', endedAt: '2026-10-08T21:10:00.000Z', status: 'offline' }
];
// 3h stream, 5-minute samples. Raid at 0:50 lifts viewers; break at 1:40 dips; game switch at 1:00.
const viewersAt = i => Math.round(28 + i * 0.6 + (i >= 10 ? 42 - Math.min(20, (i - 10) * 1.5) : 0) - (i >= 20 && i <= 22 ? 18 : 0) + 4 * Math.sin(i / 1.7));
export function makeData(plan = 'pro') {
  const points = Array.from({ length: 37 }, (_, i) => ({ offsetSeconds: i * 300, viewers: viewersAt(i), messagesPerMinute: Math.round((6 + (i >= 10 && i <= 13 ? 18 : 0) + 3 * Math.sin(i)) * 10) / 10, commandsPerMinute: plan === 'free' ? null : Math.round((1 + (i % 5) * 0.4) * 10) / 10, gap: i === 28, game: i < 12 ? 'Just Chatting' : i < 30 ? 'Elden Ring' : 'Chess', title: i < 12 ? 'Coffee & chat ☕' : 'No-hit run attempt #4' }));
  const events = [
    { id: 'title-0', kind: 'title', label: 'Coffee & chat ☕', offsetSeconds: 0 },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `follow-${i}`, kind: 'follow', label: ['pixelpanda', 'NightOwl_77', 'luna_draws', 'CaptainCoffee', 'mx_gamer', 'tinyteapot', 'Rhea', 'ozzy_plays', 'SoftSerge'][i], offsetSeconds: 400 + i * 1100 })),
    { id: 'reward-1', kind: 'redemption', label: 'Hydrate', offsetSeconds: 1300, cost: 500 },
    { id: 'raid-1', kind: 'raid', label: 'FriendlyRaider', offsetSeconds: 2950, value: 46 },
    { id: 'sub-1', kind: 'sub', label: 'NightOwl_77', offsetSeconds: 3100 },
    { id: 'game-1', kind: 'game', label: 'Elden Ring', offsetSeconds: 3600 },
    { id: 'title-1', kind: 'title', label: 'No-hit run attempt #4', offsetSeconds: 3600 },
    { id: 'gift-1', kind: 'gift', label: 'CaptainCoffee', offsetSeconds: 4200, value: 5 },
    { id: 'bits-1', kind: 'bits', label: 'luna_draws', offsetSeconds: 5000, value: 500 },
    { id: 'note-1', kind: 'note', label: 'Break', offsetSeconds: 5950 },
    { id: 'reward-2', kind: 'redemption', label: 'Play a sound', offsetSeconds: 7400, cost: 1000 },
    { id: 'game-2', kind: 'game', label: 'Chess', offsetSeconds: 9000 }
  ].sort((a, b) => a.offsetSeconds - b.offsetSeconds);
  const caps = { trends: plan !== 'free', comparison: plan !== 'free', users: plan === 'pro' };
  return {
    session: { ...sessions[0], durationSeconds: 10800 }, asOf: '2026-10-12T21:01:00.000Z', canAnnotate: true, canSeeCredits: plan === 'pro',
    coverage: { retentionDays: 90, chatterTrackingStartedAt: startedAt, truncated: false },
    points, chatters: Array.from({ length: 36 }, (_, i) => ({ offsetSeconds: i * 300, count: i === 0 ? null : 8 + Math.round(points[i].viewers / 6) })),
    events, markerPage: { hasMore: true, cursor: startedAt + '|' + 'c'.repeat(24) },
    activity: {
      totals: { messages: 2140, commands: 312, emotes: 1180, emoteMessages: 640, redemptions: 2, follows: 9, subs: 1, bits: 500, raids: 1 },
      commands: [{ key: 'hello', label: '!hello', count: 120, errors: 2 }, { key: 'discord', label: '!discord', count: 64, errors: 0 }, { key: 'lurk', label: '!lurk', count: 41, errors: 0 }, { key: 'so', label: '!so', count: 12, errors: 1 }, { key: 'uptime', label: '!uptime', count: 9, errors: 0 }, { key: 'clip', label: '!clip', count: 6, errors: 0 }],
      emotes: [{ key: 'twitch:25', label: 'Kappa', count: 450, messages: 200 }, { key: 'twitch:88', label: 'PogChamp', count: 310, messages: 180 }, { key: 'twitch:1', label: 'LUL', count: 140, messages: 90 }],
      series: Array.from({ length: 36 }, (_, i) => ({ offsetSeconds: i * 300, commands: plan === 'free' ? undefined : i % 8, emotes: plan === 'free' ? undefined : 18 + (i >= 10 && i <= 13 ? 40 : 0) + (i % 6) * 3, messages: 60, chatters: 10 })),
      coverageStartedAt: startedAt, chatterStartedAt: startedAt, updatedAt: '2026-10-12T21:00:30.000Z', pending: false, truncated: false, planTier: plan, capabilities: caps
    }
  };
}

/** Installs the session + API mock. Returns mutable state so checks can flip failures. */
export async function mockApi(page, url, opts = {}) {
  const app = makeApp(opts.plan || 'pro');
  const state = { data: makeData(opts.plan || 'pro'), fail: false, empty: false, failMarker: false, canAnnotate: true, saves: [], requests: [], app };
  await page.addInitScript(({ twitch, app }) => { localStorage.setItem('dimasite.session.v1', JSON.stringify({ version: 2, token: 'fixture', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), twitchUser: twitch, appUser: app, permissions: {} })); localStorage.setItem('theme', 'dark'); }, { twitch, app });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin === new URL(url).origin && !u.pathname.startsWith('/api/')) return route.continue();
    if (u.hostname === 'api.domdimabot.com' || u.port === '3000') {
      const path = u.pathname, data = state.data; let response = {};
      state.requests.push(path + u.search);
      if (path === '/auth/session') response = { twitch, app: state.app };
      else if (path.includes('/access')) response = { allowed: true };
      else if (path.endsWith('/people')) response = { items: [{ id: 'viewer-1', label: 'ChatViewer', count: 12, errors: 1 }, { id: 'viewer-2', label: 'pixelpanda', count: 7, errors: 0 }], cursor: null };
      else if (path.endsWith('/credits')) response = { items: [{ id: 'credit-1', offsetSeconds: 1800, category: 'tts', operation: 'synthesize', provider: 'piper', model: null, credits: 12, entryKind: 'usage' }, { id: 'credit-2', offsetSeconds: 4200, category: 'ai_chat', operation: 'chat', provider: 'openai', model: 'mini', credits: 3.5, entryKind: 'usage' }], truncated: false };
      else if (path.endsWith('/moments')) response = { events: [{ id: 'follow-new', kind: 'follow', label: 'NewFollower', offsetSeconds: 2500, value: 1 }], cursor: null };
      else if (path.includes('/compare/')) response = { ...data, session: { ...sessions[1], durationSeconds: 8100 }, canAnnotate: false, points: data.points.slice(0, 28).map(p => ({ ...p, viewers: Math.max(5, p.viewers - 12) })) };
      else if (path.includes('/markers/')) {
        if (route.request().method() === 'PUT') { state.saves.push({ key: path.split('/').at(-1), ...route.request().postDataJSON() }); if (state.failMarker) { state.failMarker = false; return route.fulfill({ status: 503, json: { error: true } }); } const saved = state.saves.at(-1); if (!data.events.some(e => e.id === 'c'.repeat(24))) { data.events.push({ id: 'c'.repeat(24), kind: 'note', label: saved.label, offsetSeconds: saved.offsetSeconds }); data.events.sort((a, b) => a.offsetSeconds - b.offsetSeconds); } }
        else data.events = data.events.filter(e => e.id !== path.split('/').at(-1));
      }
      else if (path.endsWith(`/analytics/streams/${twitch.id}`)) response = { streams: state.empty ? [] : sessions, page: 1, hasMore: false };
      else if (path.includes('/analytics/streams/')) { if (state.fail) return route.fulfill({ status: 503, json: { error: true } }); response = { ...data, canAnnotate: state.canAnnotate, ...(path.endsWith(id2) ? { session: { ...sessions[1], durationSeconds: 8100 }, points: [], chatters: [], events: [], activity: undefined, canSeeCredits: false, markerPage: undefined, coverage: { ...data.coverage, chatterTrackingStartedAt: null } } : {}) }; }
      return route.fulfill({ status: 200, json: { error: false, data: response } });
    }
    return route.abort();
  });
  return state;
}
