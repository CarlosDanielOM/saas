/**
 * Pages the assistant may open and spots the mascot can point at. Mirror of
 * `dimabot/src/site_agent/navigation.ts` (a backend test compares both lists).
 * Paths are relative to `/<current streamer>/`; the channel never comes from the model.
 */

export const ASSISTANT_ROUTES: Readonly<Record<string, readonly string[]>> = {
  'dashboard': ['dashboard'],
  'usage': ['usage'],
  'credits': ['credits'],
  'commands': ['commands'],
  'modules': ['modules'],
  'modules.overlays': ['modules', 'overlays'],
  'modules.widgets': ['modules', 'widgets'],
  'modules.widgets.duel': ['modules', 'widgets', 'duel'],
  'modules.widgets.dbd': ['modules', 'widgets', 'dbd'],
  'modules.roulette': ['modules', 'roulette'],
  'modules.clips': ['modules', 'clips'],
  'modules.chat-events': ['modules', 'chat-events'],
  'modules.triggers': ['modules', 'triggers'],
  'modules.dimafx': ['modules', 'dimafx'],
  'modules.ai-personality': ['modules', 'ai-personality'],
  'modules.pet': ['modules', 'pet'],
  'modules.memories': ['modules', 'memories'],
  'modules.analytics': ['modules', 'analytics'],
  'modules.analytics.timeline': ['modules', 'analytics', 'timeline'],
  'modules.analytics.follows': ['modules', 'analytics', 'follows'],
  'modules.referrals': ['modules', 'referrals'],
  'modules.redemptions': ['modules', 'redemptions'],
  'modules.tts': ['modules', 'tts'],
  'modules.follow-defense': ['modules', 'follow-defense'],
  'modules.moderation': ['modules', 'moderation'],
  'modules.stream-summaries': ['modules', 'stream-summaries'],
  'modules.clip-recommendations': ['modules', 'clip-recommendations'],
  'modules.library': ['modules', 'library'],
  'settings': ['settings'],
  'admin-hub': ['admin-hub'],
  'profile': ['profile'],
};

/** Anchor key → route key. Elements carry `data-assistant-anchor="<key>"`. */
export const ASSISTANT_ANCHORS: Readonly<Record<string, string>> = {
  'dashboard.bot-toggle': 'dashboard',
  'dashboard.credits': 'dashboard',
  'commands.create': 'commands',
  'commands.timers': 'commands',
  'tts.enable': 'modules.tts',
  'tts.speech-url': 'modules.tts',
  'tts.voice': 'modules.tts',
  'follow-defense.mode': 'modules.follow-defense',
  'chat-events.list': 'modules.chat-events',
  'ai-personality.profile': 'modules.ai-personality',
  'settings.admins': 'settings',
  'profile.language': 'profile',
  'profile.delete-account': 'profile',
  'credits.packs': 'credits',
};

/** Route key for a path under `/<streamer>/` (longest match), or null. */
export function routeKeyForPath(segments: readonly string[]): string | null {
  let best: string | null = null;
  let bestLength = 0;
  for (const [key, path] of Object.entries(ASSISTANT_ROUTES)) {
    if (path.length > bestLength && path.length <= segments.length && path.every((part, index) => segments[index] === part)) {
      best = key;
      bestLength = path.length;
    }
  }
  return best;
}
