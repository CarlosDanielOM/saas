import type { DimaAlert, DimaSession } from './dima-events';

const PREFIX: Record<DimaAlert['type'], string> = { follow: 'follower', sub: 'subscriber', resub: 'subscriber', gift: 'subscriber', bits: 'cheer', raid: 'raid', tip: 'tip' };
const SPANS = ['session', 'week', 'month', 'total'] as const;

/**
 * The session snapshot after one alert, as the server's next snapshot would show it (OBS gets a fresh snapshot about
 * 1.5 s after each alert). Studio's preview uses it for its test alerts, so widgets that only read session data (e.g.
 * StreamElements goal widgets listening to onSessionUpdate) react in the preview too.
 */
export function sessionAfterAlert(session: DimaSession, alert: DimaAlert): DimaSession {
  const prefix = PREFIX[alert.type], data: Record<string, unknown> = { ...session.data };
  const name = alert.type === 'gift' && alert.recipient ? alert.recipient.name : alert.user?.name ?? 'Anonymous';
  const entry: Record<string, unknown> = { type: prefix, name, amount: alert.amount, message: alert.message ?? '', createdAt: new Date(alert.at).toISOString(), _id: alert.id };
  if (alert.type === 'sub' || alert.type === 'resub') Object.assign(entry, { tier: alert.tier ?? '1000', gifted: false });
  if (alert.type === 'gift') Object.assign(entry, { tier: alert.tier ?? '1000', gifted: true, sender: alert.user?.name ?? 'Anonymous', bulkGifted: !alert.recipient });
  data[prefix + '-latest'] = entry;
  if (alert.type === 'sub') data['subscriber-new-latest'] = entry;
  if (alert.type === 'resub') data['subscriber-resub-latest'] = entry;
  if (alert.type === 'gift') data['subscriber-gifted-latest'] = entry;
  data[prefix + '-recent'] = [entry, ...(Array.isArray(data[prefix + '-recent']) ? data[prefix + '-recent'] as unknown[] : [])].slice(0, 25);
  // Counted like the server: Bits and tips by amount, a gift by its number of subs, everything else once.
  const counted = alert.type === 'bits' || alert.type === 'tip' || (alert.type === 'gift' && !alert.recipient) ? Number(alert.amount) || 0 : 1;
  const field = prefix === 'cheer' || prefix === 'tip' ? 'amount' : 'count';
  for (const span of SPANS) {
    const current = data[`${prefix}-${span}`] as Record<string, unknown> | undefined;
    data[`${prefix}-${span}`] = { ...current, [field]: (Number(current?.[field]) || 0) + counted };
  }
  // The goal fed by the streamer's Goals page usually counts the same events (currency goals are weighted: left alone).
  if (prefix !== 'tip' && prefix !== 'raid') {
    const goal = data[`${prefix}-goal`] as Record<string, unknown> | undefined;
    data[`${prefix}-goal`] = { ...goal, amount: (Number(goal?.['amount']) || 0) + counted };
  }
  // Twitch-sourced layers keep Twitch's goal values: Twitch counts its own way, so test alerts don't move them.
  return { data, recents: [entry, ...session.recents].slice(0, 25), ...(session.goalsBySource ? { goalsBySource: session.goalsBySource } : {}) };
}
