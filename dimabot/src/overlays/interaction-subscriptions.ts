import { getScopes } from '../functions/users/get_scopes.users.js';
import { getEventsubs, subscribeTwitchEvent, unsubscribeTwitchEvent } from '../utils/eventsub.js';
import Eventsub from '../schemas/eventsub.schema.js';
import TwitchStreamers from '../classes/twitch_streamers.class.js';
import { OverlayError } from './store.js';
import { INTERACTION_SUBSCRIPTIONS, type InteractionKind } from './interaction-model.js';

const callback = 'https://subscriptions.domdimabot.com/eventsub';
type Remote = { id: string; type: string; version: string; status: string; condition: { broadcaster_user_id?: string }; transport: { method?: string; callback?: string }; created_at: string; cost: number };
export interface InteractionReadiness {
  state: 'ready' | 'pending' | 'missing' | 'permission' | 'error';
  events: { type: string; status: string }[];
}
export type InteractionReadinessSnapshot = Record<InteractionKind, InteractionReadiness>;
function matches(remote: Remote, channel: string, type: string): boolean {
  return remote.type === type && remote.version === '1' && remote.condition?.broadcaster_user_id === channel
    && remote.transport?.method === 'webhook' && remote.transport.callback === callback;
}
async function inspect(channel: string) {
  const [remote, grants] = await Promise.all([getEventsubs(), getScopes(channel)]);
  if (remote?.error || !Array.isArray(remote?.data) || grants.error || !Array.isArray(grants.data)) throw new OverlayError('Unable to check Twitch events. Try again.', 502);
  const scopes: string[] = grants.data.find((item: { user_id?: string }) => item.user_id === channel)?.scopes ?? [];
  return { remote: remote.data as Remote[], scopes };
}
function readiness(channel: string, remote: Remote[], scopes: string[]): InteractionReadinessSnapshot {
  const status = (kind: InteractionKind): InteractionReadiness => {
    const permitted = scopes.includes(`channel:read:${kind === 'poll' ? 'polls' : 'predictions'}`) || scopes.includes(`channel:manage:${kind === 'poll' ? 'polls' : 'predictions'}`);
    const events = INTERACTION_SUBSCRIPTIONS[kind].map(type => {
      const subscriptions = remote.filter(item => matches(item, channel, type));
      const match = subscriptions.find(item => item.status === 'enabled') ?? subscriptions.find(item => item.status === 'webhook_callback_verification_pending') ?? subscriptions[0];
      return { type, status: match?.status ?? 'missing' };
    });
    return { state: !permitted ? 'permission' : events.every(event => event.status === 'enabled') ? 'ready'
      : events.every(event => ['enabled', 'webhook_callback_verification_pending'].includes(event.status)) ? 'pending' : 'missing', events };
  };
  return { poll: status('poll'), prediction: status('prediction') };
}
export async function interactionReadiness(channel: string): Promise<InteractionReadinessSnapshot> {
  const { remote, scopes } = await inspect(channel); return readiness(channel, remote, scopes);
}
const activations = new Map<string, Promise<InteractionReadinessSnapshot>>();
/** Explicit owner action; no cron reconciliation or announcement settings are changed. */
export function activateInteraction(channel: string, kind: InteractionKind): Promise<InteractionReadinessSnapshot> {
  if (kind !== 'poll' && kind !== 'prediction') throw new OverlayError('Invalid Twitch widget');
  const key = `${channel}:${kind}`, active = activations.get(key); if (active) return active;
  const promise = (async () => {
    let { remote, scopes } = await inspect(channel);
    if (readiness(channel, remote, scopes)[kind].state === 'permission') throw new OverlayError('Reconnect Twitch to grant poll and prediction permissions.', 403);
    const account = await TwitchStreamers.getTwitchAccountById(channel);
    if (!account) throw new OverlayError('Twitch account unavailable', 403);
    for (const type of INTERACTION_SUBSCRIPTIONS[kind]) {
      const existing = remote.find(item => matches(item, channel, type) && ['enabled', 'webhook_callback_verification_pending'].includes(item.status));
      if (existing) {
        // Adopt a valid remote subscription without changing its chat preferences.
        await Eventsub.findOneAndUpdate({ id: existing.id }, { $set: { ...existing, channelID: channel, channel: account.name } }, { upsert: true, setDefaultsOnInsert: true });
        continue;
      }
      for (const stale of remote.filter(item => matches(item, channel, type))) {
        const removed = await unsubscribeTwitchEvent(stale.id);
        if (removed?.error) throw new OverlayError('Unable to repair Twitch events. Try again.', 502);
      }
      const result = await subscribeTwitchEvent(channel, type, '1', { broadcaster_user_id: channel }, undefined, { ignoreExisting: true });
      if ('error' in result) {
        // Another request or process may have created it in the meantime.
        if (result.status !== 409) throw new OverlayError(result.status === 403 ? 'Reconnect Twitch to grant the required permissions.' : 'Unable to activate Twitch events. Try again.', result.status === 403 ? 403 : 502);
        const refreshed = await inspect(channel); remote = refreshed.remote; scopes = refreshed.scopes;
        if (!remote.some(item => matches(item, channel, type) && ['enabled', 'webhook_callback_verification_pending'].includes(item.status))) throw new OverlayError('Unable to activate Twitch events. Try again.', 502);
      } else remote = [...remote, result as unknown as Remote];
    }
    return readiness(channel, remote, scopes);
  })();
  activations.set(key, promise);
  void promise.finally(() => activations.delete(key)).catch(() => {});
  return promise;
}
