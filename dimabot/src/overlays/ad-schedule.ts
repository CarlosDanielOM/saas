import { getTwitchStreamerHeaderById } from '../utils/header.js';
import { getTwitchHelixUrl } from '../utils/links.js';
import { parseAdSchedule, type AdSchedule } from './live-events-model.js';

/**
 * Twitch ad schedule (Helix Get Ad Schedule) for custom widgets that use `ads`. Twitch sends no event for schedule
 * changes, so the API asks once a minute (with jitter), only for channels with a connected `ads` widget. Requests are
 * shared per channel, at most 4 run at once, and rate limits or missing permission back off. Unknown = null.
 */
interface Entry { value: AdSchedule | null; fetchedAt: number; nextAt: number; blockedUntil: number; promise?: Promise<void> }
const schedules = new Map<string, Entry>();
const REFRESH_MS = 60_000, MAX_RUNNING = 4;
let running = 0;

export function adSchedule(channel: string): AdSchedule | null { return schedules.get(channel)?.value ?? null; }
/** Ask again soon (after an ad break starts, the next one moves), never sooner than a rate-limit backoff allows. */
export function refreshAdSchedule(channel: string): void {
  const entry = schedules.get(channel);
  if (entry) entry.nextAt = Math.max(entry.blockedUntil, Math.min(entry.nextAt, Date.now() + 5_000));
}

/** Starts the requests that are due for these channels; `onChange` hears about channels whose schedule changed. */
export function updateAdSchedules(channels: Iterable<string>, onChange: (channel: string) => void): void {
  const now = Date.now();
  for (const channel of channels) {
    const entry = schedules.get(channel) ?? { value: null, fetchedAt: 0, nextAt: 0, blockedUntil: 0 };
    schedules.set(channel, entry);
    if (entry.promise || entry.nextAt > now || running >= MAX_RUNNING) continue;
    running++;
    entry.promise = fetchSchedule(channel).then(result => {
      const before = JSON.stringify(entry.value);
      if (result.value !== undefined) { entry.value = result.value; entry.fetchedAt = Date.now(); }
      entry.nextAt = Date.now() + result.retryIn + Math.floor(Math.random() * 10_000);
      entry.blockedUntil = result.rateLimited ? entry.nextAt : 0;
      if (JSON.stringify(entry.value) !== before) onChange(channel);
    }).catch(() => { entry.nextAt = Date.now() + REFRESH_MS; }).finally(() => { running--; entry.promise = undefined; });
  }
  if (schedules.size > 5000) for (const [channel, entry] of schedules) if (!entry.promise && now - entry.fetchedAt > 10 * REFRESH_MS) schedules.delete(channel);
}

/** `value` undefined keeps the last known schedule (a transient failure); null means Twitch can't tell us. */
async function fetchSchedule(channel: string): Promise<{ value?: AdSchedule | null; retryIn: number; rateLimited?: boolean }> {
  // A token problem can be temporary (refresh in progress, a lock): keep what we know and try again later.
  const header = await getTwitchStreamerHeaderById(channel);
  if (header.error || !header.header) return { retryIn: 2 * REFRESH_MS };
  const response = await fetch(getTwitchHelixUrl('channels/ads', new URLSearchParams({ broadcaster_id: channel }).toString()), {
    headers: header.header as unknown as Record<string, string>, signal: AbortSignal.timeout(8000) });
  if (response.status === 429) {
    const reset = Number(response.headers.get('ratelimit-reset')) * 1000;
    return { rateLimited: true, retryIn: Number.isFinite(reset) && reset > Date.now() ? Math.min(reset - Date.now() + 1_000, 5 * REFRESH_MS) : REFRESH_MS };
  }
  // No permission (older login without channel:read:ads) or no such channel: unknown, ask rarely.
  if (response.status === 401 || response.status === 403 || response.status === 404) return { value: null, retryIn: 10 * REFRESH_MS };
  if (!response.ok) return { retryIn: REFRESH_MS };
  const body = await response.json() as { data?: Record<string, unknown>[] };
  return { value: parseAdSchedule(Array.isArray(body.data) ? body.data[0] : undefined, Date.now()), retryIn: REFRESH_MS };
}
