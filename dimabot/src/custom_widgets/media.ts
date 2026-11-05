import { createWriteStream } from 'node:fs';
import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AssetError, Libraries, MAX_ASSET_BYTES, assetQuota, registerAssetConsumer, uploadAsset } from '../assets/library.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import type { ExternalMedia } from './format.js';
import { CustomWidgetError, CustomWidgets, mediaUrls } from './store.js';

/**
 * Copies a widget's StreamElements-hosted images, videos and sounds into the channel's Asset Library, so the
 * widget keeps working if StreamElements removes them. The widget's `media` map (remote URL → asset ID) is
 * shared by all its revisions; the runtime rewrites those URLs.
 */
const COPYABLE = new Set<ExternalMedia['kind']>(['image', 'video', 'audio']);
const MAX_FILES = 40;
export interface MediaFile { url: string; kind: ExternalMedia['kind']; bytes: number | null; copied: boolean; assetId?: string }
export interface MediaPlan { files: MediaFile[]; totalBytes: number; unknownSizes: number; quota: { usedBytes: number; quotaBytes: number } }

/** StreamElements' own media hosts. Copying is limited to these (detection elsewhere accepts any streamelements.com host). */
const MEDIA_HOSTS = new Set(['cdn.streamelements.com', 'static.streamelements.com']);
function eligible(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443') && MEDIA_HOSTS.has(parsed.hostname.toLowerCase()); }
  catch { return false; }
}
// Private, local, shared and special ranges; BlockList also matches IPv4-mapped IPv6 forms such as ::ffff:7f00:1.
const BLOCKED = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['64:ff9b::', 96], ['ff00::', 8]] as const) BLOCKED.addSubnet(net, prefix, 'ipv6');
export const privateAddress = (ip: string): boolean => { const family = isIP(ip); return family === 0 || BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6'); };
/**
 * Downloads only from StreamElements hosts over https on the default port, re-checking every redirect hop and
 * refusing names that resolve to private or local addresses. No cookies or credentials are ever sent.
 */
async function safeFetch(url: string, init: { method?: string; timeoutMs: number }): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    if (!eligible(current)) throw new Error('blocked_url');
    const host = new URL(current).hostname;
    const addresses = await dns.lookup(host, { all: true }).catch(() => []);
    if (!addresses.length || addresses.some(entry => privateAddress(entry.address))) throw new Error('blocked_url');
    const response = await fetch(current, { method: init.method ?? 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(init.timeoutMs) });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) { await response.body?.cancel().catch(() => {}); current = new URL(location, current).href; continue; }
    return response;
  }
  throw new Error('too_many_redirects');
}
async function widgetDoc(owner: string, id: string) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new CustomWidgetError('Custom widget not found', 404);
  await getMongoDBConnection('custom-widget-media');
  const doc = await CustomWidgets.findOne({ _id: id, owner }).lean();
  if (!doc) throw new CustomWidgetError('Custom widget not found', 404);
  return doc;
}
function candidates(doc: Awaited<ReturnType<typeof widgetDoc>>): ExternalMedia[] {
  const latest = doc.revisions.find(r => r.revision === doc.revision)!;
  return latest.externalMedia.filter(item => COPYABLE.has(item.kind) && eligible(item.url)).slice(0, MAX_FILES);
}
async function size(url: string): Promise<number | null> {
  try {
    const response = await safeFetch(url, { method: 'HEAD', timeoutMs: 10_000 });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length'));
    return Number.isSafeInteger(length) && length > 0 ? length : null;
  } catch { return null; }
}
/** What copying would take: each file's size (when the server reports it) and the channel's storage. */
export async function planMediaCopy(owner: string, id: string): Promise<MediaPlan> {
  const doc = await widgetDoc(owner, id), media = mediaMap(doc.media);
  const files: MediaFile[] = [];
  for (const batch of chunk(candidates(doc), 6)) {
    files.push(...await Promise.all(batch.map(async item => media[item.url]
      ? { url: item.url, kind: item.kind, bytes: null, copied: true, assetId: media[item.url] }
      : { url: item.url, kind: item.kind, bytes: await size(item.url), copied: false })));
  }
  const pending = files.filter(file => !file.copied);
  const [{ quotaBytes }, library] = await Promise.all([assetQuota(owner), Libraries.findById(owner).select('usedBytes').lean()]);
  return { files, totalBytes: pending.reduce((sum, file) => sum + (file.bytes ?? 0), 0), unknownSizes: pending.filter(file => file.bytes === null).length,
    quota: { usedBytes: library?.usedBytes ?? 0, quotaBytes } };
}
function chunk<T>(items: T[], size: number): T[][] { const out: T[][] = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }

async function download(url: string, path: string): Promise<number> {
  const response = await safeFetch(url, { timeoutMs: 120_000 });
  if (!response.ok || !response.body) throw new Error('download_failed');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) throw new AssetError('file_size', 413);
  let bytes = 0;
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > MAX_ASSET_BYTES ? new AssetError('file_size', 413) : null, chunk); } });
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), limit, createWriteStream(path, { flags: 'wx' }));
  return bytes;
}
const busy = new Set<string>();
/** Copies the given StreamElements URLs (default: all not yet copied). Each file succeeds or fails on its own. */
export async function copyMedia(owner: string, id: string, requested?: unknown): Promise<{ copied: Record<string, string>; failed: { url: string; reason: string }[] }> {
  const doc = await widgetDoc(owner, id);
  const known = candidates(doc), media = mediaMap(doc.media);
  const urls = Array.isArray(requested) ? requested.filter((url): url is string => typeof url === 'string') : known.map(item => item.url);
  const selected = known.filter(item => urls.includes(item.url) && !media[item.url]);
  if (busy.has(owner)) throw new CustomWidgetError('Files are already being copied for this channel. Wait a moment and try again.', 409);
  busy.add(owner);
  const copied: Record<string, string> = {}, failed: { url: string; reason: string }[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'widget-media-'));
  try {
    for (const [index, item] of selected.entries()) {
      const path = join(directory, String(index));
      try {
        const bytes = await download(item.url, path);
        const name = decodeURIComponent(new URL(item.url).pathname.split('/').pop() || 'widget-file').slice(0, 100);
        const asset = await uploadAsset(owner, { path, originalname: name, size: bytes });
        copied[item.url] = asset.id;
        await CustomWidgets.updateOne({ _id: id, owner }, { $set: { [`media.${Buffer.from(item.url).toString('base64url')}`]: { url: item.url, assetId: asset.id } } });
      } catch (error) {
        failed.push({ url: item.url, reason: error instanceof AssetError ? error.code : 'download_failed' });
        if (error instanceof AssetError && error.code === 'quota_exceeded') { for (const rest of selected.slice(index + 1)) failed.push({ url: rest.url, reason: 'quota_exceeded' }); break; }
      } finally { await rm(path, { force: true }); }
    }
  } finally { busy.delete(owner); await rm(directory, { recursive: true, force: true }); }
  return { copied, failed };
}
const mediaMap = mediaUrls;
registerAssetConsumer('custom-widgets', async (owner, assetId) => {
  await getMongoDBConnection('custom-widget-media');
  return (await CustomWidgets.find({ owner }).select('media').lean()).some(doc => Object.values(mediaMap(doc.media)).includes(assetId));
});
