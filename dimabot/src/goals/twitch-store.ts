import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { getTwitchStreamerHeaderById } from '../utils/header.js';
import { getTwitchHelixUrl } from '../utils/links.js';
import { LiveState, saveLive } from '../overlays/interactions.js';
import { requestWidgetSessionRefresh } from '../widget_feed/session-refresh.js';
import { parseHelixGoal, parseTwitchGoalEvent, reduceTwitchGoalEvent, reduceTwitchGoalsHelix, twitchGoalsPermission, visibleTwitchGoals, type StoredTwitchGoals } from './twitch.js';

const docId = (channel: string) => `${channel}:twitchgoals`;
/** Widgets only need a refresh when something they can see changed. */
const visible = (state: StoredTwitchGoals | null, now: number) => JSON.stringify(visibleTwitchGoals(state, now).map(goal => [goal.id, goal.current, goal.target, goal.description, goal.status]));

/** The channel's stored Twitch goals (null: never read). */
export async function readTwitchGoals(channel: string): Promise<StoredTwitchGoals | null> {
  await getMongoDBConnection('twitch-goals');
  return ((await LiveState.findById(docId(channel)).lean())?.state as StoredTwitchGoals | undefined) ?? null;
}

/** Projection of one journaled `channel.goal.*` notification (cron, overlay-interactions-v1). */
export async function applyTwitchGoalEvent(channel: string, type: string, raw: Record<string, unknown>, at: string, receipt: string): Promise<void> {
  const next = parseTwitchGoalEvent(type, raw);
  let changed = false;
  await saveLive<StoredTwitchGoals>(docId(channel), current => {
    const reduced = reduceTwitchGoalEvent(current, next, at, receipt);
    changed = !!reduced && visible(current, Date.now()) !== visible(reduced, Date.now());
    return reduced;
  });
  if (changed) requestWidgetSessionRefresh(channel);
}

const resyncs = new Map<string, { started: number; until: number; promise: Promise<void> }>();
const RESYNC_MS = Math.max(1000, Number(process.env.TWITCH_GOALS_RESYNC_MS) || 60_000);
/** A channel without the goals permission is asked again after this long (unless the Goals page asks). */
const PERMISSION_BACKOFF_MS = 15 * 60_000;
const lastResync = new Map<string, number>();
/** When this process last asked Twitch about a channel's goals (0: never). */
export const twitchGoalsResyncedAt = (channel: string) => lastResync.get(channel) ?? 0;

/** Channels whose last read in this process said `permission` (the Goals page then asks again after 10 s, for a reconnect). */
const denied = new Set<string>();
/**
 * Recovery from Helix `GET /goals` (active goals; coalesced per channel for a minute, `TWITCH_GOALS_RESYNC_MS` in checks).
 * The Goals page polls every few seconds and shares that minute, except after a `permission` answer. Fenced by the
 * document revision: anything saved while the request was out wins. A failed request or missing token changes nothing;
 * 401/403 records `permission` (asked again after 15 minutes, or by the Goals page).
 */
export function resyncTwitchGoals(channel: string, options: { fromPage?: boolean } = {}): Promise<void> {
  const old = resyncs.get(channel), now = Date.now();
  if (old && (options.fromPage && denied.has(channel) ? now - old.started < 10_000 : old.until > now)) return old.promise;
  const promise = (async () => {
    await getMongoDBConnection('twitch-goals');
    const id = docId(channel), before = await LiveState.findById(id).lean();
    const stored = (before?.state as StoredTwitchGoals | undefined) ?? null;
    if (!options.fromPage && stored?.access === 'permission' && stored.checkedAt && Date.now() - Date.parse(stored.checkedAt) < PERMISSION_BACKOFF_MS) return;
    lastResync.set(channel, Date.now());
    if (lastResync.size > 5000) lastResync.delete(lastResync.keys().next().value!);
    const header = await getTwitchStreamerHeaderById(channel);
    if (header.error || !header.header) return;
    const fetchedAt = new Date().toISOString();
    const response = await fetch(getTwitchHelixUrl('goals', new URLSearchParams({ broadcaster_id: channel }).toString()), {
      headers: header.header as unknown as Record<string, string>, signal: AbortSignal.timeout(8000) });
    let next: (current: StoredTwitchGoals | null) => StoredTwitchGoals;
    if (response.status === 401 || response.status === 403) { denied.add(channel); next = current => twitchGoalsPermission(current, fetchedAt); }
    else {
      denied.delete(channel);
      if (!response.ok) throw new Error(`Twitch goals recovery failed: ${response.status}`);
      const body = await response.json() as { data?: unknown };
      if (!Array.isArray(body.data)) throw new Error('Twitch goals recovery: unexpected response');
      // A row we can't read (e.g. a goal type Twitch adds later) is skipped: it was never stored, so nothing goes missing.
      const rows = body.data.flatMap(row => { try { return row && typeof row === 'object' ? [parseHelixGoal(row as Record<string, unknown>)] : []; } catch { return []; } });
      next = current => reduceTwitchGoalsHelix(current, rows, fetchedAt);
    }
    let changed = false;
    await saveLive<StoredTwitchGoals>(id, current => {
      const reduced = next(current);
      changed = visible(current, Date.now()) !== visible(reduced, Date.now());
      return reduced;
    }, before?.revision ?? 0);
    if (changed) requestWidgetSessionRefresh(channel);
  })();
  resyncs.set(channel, { started: now, until: now + RESYNC_MS, promise });
  if (resyncs.size > 2000) for (const [key, entry] of resyncs) if (entry.until < Date.now()) resyncs.delete(key);
  return promise;
}

/** Waits for a recovery at most `ms` (the page shows the last stored goals if Twitch is slow). */
export async function resyncTwitchGoalsWithin(channel: string, ms: number, options: { fromPage?: boolean } = {}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([resyncTwitchGoals(channel, options).catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}
