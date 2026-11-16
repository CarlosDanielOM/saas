import { Schema, model } from 'mongoose';
import { COMPAT_ENTRIES, COMPAT_QUIET_DAYS, type ClientKind, type CompatEntry } from './compat.js';
import { OVERLAY_PROTOCOL, STUDIO_WRITER } from './protocol.js';

/**
 * Which page versions are in use, so the owner knows when compatibility code (compat.ts) can go. One row per
 * client kind, protocol and build, kept in Mongo (`client_versions`) so it survives restarts and works with several API
 * servers. Rows not seen for 180 days expire.
 */
interface ClientVersionRow { _id: string; client: ClientKind; protocol: number; build: string; firstSeenAt: Date; lastSeenAt: Date }
const schema = new Schema<ClientVersionRow>({ _id: String, client: String, protocol: Number, build: String, firstSeenAt: Date, lastSeenAt: Date },
  { versionKey: false, collection: 'client_versions' });
schema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 180 * 86_400 });
export const ClientVersion = model<ClientVersionRow>('ClientVersion', schema);

export interface ClientVersionInfo { protocol: number; build: string }
/** The builds our pages send (site/shared/site-build.ts): the main bundle hash, or `dev`. Anything else is `unknown`. */
const BUILD = /^(main-[A-Za-z0-9]{6,32}|dev)$/;
export const MAX_PROTOCOL = 1000;
/** What a page reported. Pages from before protocols send nothing: protocol 0, build `before-protocol`. */
export function clientVersion(raw: { protocol?: unknown; build?: unknown } | null | undefined): ClientVersionInfo {
  const protocol = typeof raw?.protocol === 'number' && Number.isSafeInteger(raw.protocol) && raw.protocol >= 1 && raw.protocol <= MAX_PROTOCOL ? raw.protocol : 0;
  const build = typeof raw?.build === 'string' && BUILD.test(raw.build) ? raw.build : protocol ? 'unknown' : 'before-protocol';
  return { protocol, build };
}
export const currentProtocol = (client: ClientKind): number => client === 'overlay' ? OVERLAY_PROTOCOL : STUDIO_WRITER;

/** A connected page refreshes its row at most this often (per API server), so a page open for weeks stays "seen". */
export const SEEN_REFRESH_MS = 10 * 60_000;
/**
 * Builds are reported by the page, so anyone with an overlay link could invent new ones. Each API server records at most
 * this many new versions per hour; past that, versions share one `overflow` row per client and protocol. The protocol is
 * still recorded, so the limit can never make compatibility code look removable.
 */
export const MAX_NEW_VERSIONS_PER_HOUR = 30;
const MAX_RECENT = 2000;
const recent = new Map<string, number>();
let newVersions = { since: 0, ids: new Set<string>() };
/** Records that a page of this version is in use. Never throws and never waits on the database. */
export function sawClient(client: ClientKind, version: ClientVersionInfo, now = Date.now()): void {
  let id = `${client}|${version.protocol}|${version.build}`, build = version.build;
  if (now - newVersions.since >= 3_600_000) newVersions = { since: now, ids: new Set() };
  if (!recent.has(id) && !newVersions.ids.has(id)) {
    if (newVersions.ids.size >= MAX_NEW_VERSIONS_PER_HOUR) { build = 'overflow'; id = `${client}|${version.protocol}|overflow`; }
    else newVersions.ids.add(id);
  }
  if (now - (recent.get(id) ?? 0) < SEEN_REFRESH_MS) return;
  recent.delete(id); recent.set(id, now);
  // Hard bound: the oldest entries go first (insertion order), whatever their age.
  for (const key of recent.keys()) { if (recent.size <= MAX_RECENT) break; recent.delete(key); }
  void ClientVersion.updateOne({ _id: id },
    { $setOnInsert: { client, protocol: version.protocol, build, firstSeenAt: new Date(now) }, $max: { lastSeenAt: new Date(now) } },
    { upsert: true }).catch(() => { recent.delete(id); });
}

export type CompatState = 'needed' | 'removable' | 'collecting';
export interface CompatReportEntry extends CompatEntry {
  state: CompatState;
  /** Last time a page that needs this code was seen (null: never since tracking began). */
  olderLastSeenAt: string | null;
  /** When the entry can first become removable: tracking start + quiet days, or last old page + quiet days. */
  removableFrom: string | null;
}
export interface ClientVersionReport {
  checkedAt: string;
  quietDays: number;
  current: Record<ClientKind, number>;
  /** First row ever recorded per client kind (tracking start). */
  trackingSince: Partial<Record<ClientKind, string>>;
  entries: CompatReportEntry[];
  versions: { client: ClientKind; protocol: number; build: string; firstSeenAt: string; lastSeenAt: string; connectedNow: number | null; outdated: boolean }[];
}
const DAY = 86_400_000;
const iso = (value: Date | number) => new Date(value).toISOString();

/**
 * The compat entries with their state, from the recorded rows. `connected` (overlay pages connected to this API server
 * right now, by protocol and build) only adds the "connected now" count; connected pages also keep their rows fresh.
 */
export async function clientVersionReport(now = Date.now(), connected: readonly ClientVersionInfo[] = []): Promise<ClientVersionReport> {
  // Decisions use every row (grouped per client and protocol); the list below is only the newest rows, for display.
  const [groups, rows] = await Promise.all([
    ClientVersion.aggregate<{ _id: { client: ClientKind; protocol: number }; firstSeenAt: Date; lastSeenAt: Date }>([
      { $group: { _id: { client: '$client', protocol: '$protocol' }, firstSeenAt: { $min: '$firstSeenAt' }, lastSeenAt: { $max: '$lastSeenAt' } } }]),
    ClientVersion.find({}).sort({ lastSeenAt: -1 }).limit(200).lean()
  ]);
  const since: Partial<Record<ClientKind, number>> = {};
  for (const group of groups) since[group._id.client] = Math.min(since[group._id.client] ?? Infinity, group.firstSeenAt.getTime());
  const quiet = COMPAT_QUIET_DAYS * DAY;
  const entries = COMPAT_ENTRIES.map((entry): CompatReportEntry => {
    const older = groups.filter(group => group._id.client === entry.client && group._id.protocol < entry.before);
    const last = older.reduce((max, group) => Math.max(max, group.lastSeenAt.getTime()), 0) || null;
    const start = since[entry.client];
    const from = Math.max(start === undefined ? now : start + quiet, last === null ? 0 : last + quiet);
    const state: CompatState = start === undefined || now - start < quiet ? 'collecting' : last !== null && now - last < quiet ? 'needed' : 'removable';
    return { ...entry, code: [...entry.code], state, olderLastSeenAt: last === null ? null : iso(last), removableFrom: iso(from) };
  });
  const live = new Map<string, number>();
  for (const version of connected) live.set(`${version.protocol}|${version.build}`, (live.get(`${version.protocol}|${version.build}`) ?? 0) + 1);
  return {
    checkedAt: iso(now), quietDays: COMPAT_QUIET_DAYS,
    current: { overlay: OVERLAY_PROTOCOL, studio: STUDIO_WRITER },
    trackingSince: Object.fromEntries(Object.entries(since).map(([client, at]) => [client, iso(at!)])),
    entries,
    versions: rows.map(row => ({ client: row.client, protocol: row.protocol, build: row.build, firstSeenAt: iso(row.firstSeenAt), lastSeenAt: iso(row.lastSeenAt),
      connectedNow: row.client === 'overlay' ? live.get(`${row.protocol}|${row.build}`) ?? 0 : null, outdated: row.protocol < currentProtocol(row.client) }))
  };
}
/** How many entries can be removed now (the admin overview's attention row). */
export async function removableCompatCount(now = Date.now()): Promise<number> {
  return (await clientVersionReport(now)).entries.filter(entry => entry.state === 'removable').length;
}
