import type { ICondition } from '../schemas/eventsub.schema.js';
import type { SubscribeTwitchEventResponse, SubscribeTwitchEventError } from '../utils/eventsub.js';

export const CHAT_MODERATION_EVENT_TYPES = [
  'channel.chat.message_delete', 'channel.chat.clear_user_messages', 'channel.chat.clear'
] as const;
const CALLBACK = 'https://subscriptions.domdimabot.com/eventsub';
export interface ChatModerationReadiness {
  ok: boolean;
  events: { type: string; status: string }[];
  message?: string;
}
interface Remote {
  id: string; type: string; version: string; status: string; condition: ICondition;
  transport: { method: string; callback: string }; created_at: string; cost: number;
}
interface SubscriptionDependencies {
  botAccountId: string;
  inspect: (channel: string) => Promise<{ error?: unknown; data?: Remote[]; complete?: boolean }>;
  account: (channel: string) => Promise<{ name: string } | null | undefined>;
  adopt: (remote: Remote, channel: string, name: string) => Promise<unknown>;
  remove: (id: string) => Promise<{ error?: unknown }>;
  subscribe: (channel: string, type: string, version: string, condition: ICondition,
    config: undefined, options: { ignoreExisting: true }) => Promise<SubscribeTwitchEventResponse | SubscribeTwitchEventError>;
}

/** On-demand only: deliberately absent from SUBSCRIPTION_TYPES and automatic repair. */
export function createChatModerationEnsurer(deps: SubscriptionDependencies) {
  const activations = new Map<string, Promise<ChatModerationReadiness>>();
  const matches = (remote: Remote, channel: string, type: string) => remote.type === type && remote.version === '1'
    && remote.condition?.broadcaster_user_id === channel && remote.condition.user_id === deps.botAccountId
    && remote.transport?.method === 'webhook' && remote.transport.callback === CALLBACK;
  const usable = (remote: Remote) => ['enabled', 'webhook_callback_verification_pending'].includes(remote.status);
  const find = (remote: Remote[], channel: string, type: string) => remote.find(item => matches(item, channel, type) && item.status === 'enabled')
    ?? remote.find(item => matches(item, channel, type) && usable(item));
  async function inspect(channel: string) {
    const response = await deps.inspect(channel);
    if (response.error || response.complete !== true || !Array.isArray(response.data)) throw new Error('Unable to check Twitch chat events. Try again.');
    return response.data;
  }
  return (channel: string): Promise<ChatModerationReadiness> => {
    const active = activations.get(channel);
    if (active) return active;
    const promise = (async (): Promise<ChatModerationReadiness> => {
      let remote: Remote[] = [];
      const events = () => CHAT_MODERATION_EVENT_TYPES.map(type => ({ type, status: find(remote, channel, type)?.status ?? 'missing' }));
      try {
        if (!channel) throw new Error('Twitch channel is required.');
        const account = await deps.account(channel);
        if (!account) throw new Error('Twitch account unavailable.');
        remote = await inspect(channel);
        for (const type of CHAT_MODERATION_EVENT_TYPES) {
          let existing = find(remote, channel, type);
          if (!existing) {
            for (const stale of remote.filter(item => matches(item, channel, type))) {
              const removed = await deps.remove(stale.id);
              if (removed.error) throw new Error('Unable to repair Twitch chat events. Try again.');
            }
            const result = await deps.subscribe(channel, type, '1', {
              broadcaster_user_id: channel, user_id: deps.botAccountId
            }, undefined, { ignoreExisting: true });
            if ('error' in result) {
              if (result.status !== 409) throw new Error(result.status === 403
                ? 'Twitch chat authorization is missing. Reauthorize the bot with user:read:chat and user:bot, and grant channel:bot or make the bot a moderator.'
                : 'Unable to activate Twitch chat events. Try again.');
              // Another API process can win creation despite our per-process de-duplication.
              remote = await inspect(channel);
            } else remote = [...remote, result];
            existing = find(remote, channel, type);
            if (!existing) throw new Error('Unable to activate Twitch chat events. Try again.');
          }
          await deps.adopt(existing, channel, account.name);
        }
        return { ok: true, events: events() };
      } catch (error) {
        return { ok: false, events: events(), message: error instanceof Error ? error.message : 'Unable to activate Twitch chat events. Try again.' };
      }
    })();
    activations.set(channel, promise);
    void promise.finally(() => activations.delete(channel)).catch(() => {});
    return promise;
  };
}

// Load application dependencies only when explicitly activated; importing feed types never opens connections.
let defaultEnsurer: Promise<ReturnType<typeof createChatModerationEnsurer>> | undefined;
export async function ensureChatModerationEvents(channel: string): Promise<ChatModerationReadiness> {
  defaultEnsurer ??= (async () => {
    const [{ getEventsubs, subscribeTwitchEvent, unsubscribeTwitchEvent }, { default: Eventsub },
      { default: TwitchStreamers }, { TWITCH_BOT_ACCOUNT_ID }] = await Promise.all([
      import('../utils/eventsub.js'), import('../schemas/eventsub.schema.js'),
      import('../classes/twitch_streamers.class.js'), import('../utils/header.js')
    ]);
    return createChatModerationEnsurer({
      botAccountId: TWITCH_BOT_ACCOUNT_ID, inspect: getEventsubs,
      account: channel => TwitchStreamers.getTwitchAccountById(channel),
      subscribe: subscribeTwitchEvent, remove: unsubscribeTwitchEvent,
      adopt: (remote, channel, name) => Eventsub.findOneAndUpdate({ id: remote.id }, {
        $set: { ...remote, channelID: channel, channel: name, remote_missing_since: null }
      }, { upsert: true, setDefaultsOnInsert: true }).exec()
    });
  })();
  return (await defaultEnsurer)(channel);
}
