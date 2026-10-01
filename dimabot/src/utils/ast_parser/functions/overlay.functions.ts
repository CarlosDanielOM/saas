import { registerFunction } from '../evaluator.js';
import { OVERLAY_ACTIONS } from '../../../overlays/controls.js';
import TwitchStreamers from '../../../classes/twitch_streamers.class.js';
import Users from '../../../schemas/users.schema.js';
import { getMongoDBConnection } from '../../databases/mongodb.database.js';
import { getUrl } from '../../dev.js';

export function registerOverlayFunctions(): void {
  for (const action of OVERLAY_ACTIONS) for (const platform of ['all', 'twitch', 'kick'] as const) {
    const name = `overlay.${action}${platform === 'all' ? '' : '.' + platform}`;
    const behavior = { skip: 'Stops current event playback and advances the queue', pause: 'Holds new playback while the current event finishes', resume: 'Continues held playback', clear: 'Removes pending events while current playback continues' }[action];
    registerFunction(name, async (args, ctx) => {
      if (args.length) return `Usage: $(${name})`;
      if (ctx.enforceFunctionPermissions !== false && ctx.userLevel < 7) return 'Error: Moderator permission required';
      if (!['twitch', 'kick'].includes(ctx.platform)) return 'Error: Unsupported originating platform';
      try {
        // Resolve through one linked account element; provider IDs are not global user IDs.
        await getMongoDBConnection('overlay-control');
        const owner = await Users.findOne({ accounts: { $elemMatch: { type: ctx.platform, id: ctx.broadcasterId } } }).lean();
        if (!owner || owner.plan_tier !== 'pro') return 'Error: Overlay Studio requires the channel owner’s Pro plan';
        const channel = ctx.platform === 'twitch' ? ctx.broadcasterId : owner.accounts?.find(account => account.type === 'twitch')?.id;
        if (!channel) return 'Error: No linked Global Overlay Studio account';
        const token = await TwitchStreamers.getAccountTokenById(channel, 'twitch');
        if (!token) return 'Error: Reconnect the overlay owner’s account in the dashboard';
        const base = process.env.INTERNAL_API_URL || (process.env.NODE_ENV === 'production' ? 'http://dima-server:3000' : getUrl());
        const response = await fetch(`${base}/overlay-studio/${encodeURIComponent(channel)}/queue`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action, platform }), signal: AbortSignal.timeout(10000)
        });
        const result = await response.json() as { message?: string };
        return response.ok ? '' : `Error: ${result.message || 'Overlay control failed'}`;
      } catch { return 'Error: Overlay controls are temporarily unavailable'; }
    }, {
      description: `${behavior}. Applies to ${platform === 'all' ? 'all event origins' : platform + ' events only'} across this owner’s Global Overlay scenes.`,
      syntax: name, category: 'overlay', examples: [name], minUserLevel: 7, planTier: 'pro',
      destructive: action === 'skip' || action === 'clear', keywords: ['overlay', action, platform, 'queue', 'superposición', 'cola']
    });
  }
}
