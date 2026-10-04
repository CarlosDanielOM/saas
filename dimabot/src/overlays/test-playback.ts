import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OverlayError, object } from './store.js';
import { piperTtsService } from '../server/services/tts/piper_tts.service.js';
import { DEFAULT_TTS_SETTINGS } from '../schemas/channel_tts_settings.schema.js';
import { getChannelClips } from '../functions/clips/get_clips.clip.js';
import { TriggerSchema } from '../schemas/trigger.schema.js';
import { MediaAssetSchema } from '../schemas/media_asset.schema.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import type { LiveMedia } from './live.js';
import { MAX_MEDIA_BYTES } from './delivery-store.js';
const run = promisify(execFile);
interface TestFile { channel: string; path: string; mime: string; expiresAt: number; clean: () => Promise<void> }
const files = new Map<string, TestFile>();
export function testFile(ticket: string): TestFile | undefined {
  const file = files.get(ticket); return file && file.expiresAt > Date.now() ? file : undefined;
}
export interface PreparedTest { media?: LiveMedia; triggerId?: string; text?: string; file?: string; mime?: string; cleanup: () => Promise<void> }
/** Reads module content without joining legacy namespaces or enqueueing a real module action. */
export async function prepareTest(channel: string, kind: string, input: unknown): Promise<PreparedTest> {
  const body = object(input);
  if (kind === 'trigger') {
    const ids = body.triggerIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)))) throw new OverlayError('Invalid trigger selection');
    const trigger = await TriggerSchema.findOne({ channelID: channel, ...(ids ? { _id: { $in: ids } } : {}) }).lean();
    if (!trigger) throw new OverlayError('No matching trigger is available for this overlay', 404);
    const asset = trigger.assetID ? await MediaAssetSchema.findOne({ _id: trigger.assetID, deletedAt: null }).lean() : null;
    const url = asset?.storageUrl || trigger.file, mime = asset?.mimeType || trigger.mediaType;
    const type = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : mime.startsWith('image') || mime === 'gif' ? 'image' : null;
    if (!type || !/^https?:\/\//i.test(url)) throw new OverlayError('Trigger media is unavailable', 404);
    return { triggerId: String(trigger._id), media: { type, url, title: trigger.name, volume: Math.max(0, Math.min(1, (trigger.volume ?? 100) / 100)) }, cleanup: async () => {} };
  }
  if (kind === 'tts') {
    const language = body.language === 'es' ? 'es' : 'en';
    const text = language === 'es' ? 'Esta es una prueba de voz de tu overlay. El audio funciona.' : 'This is a voice test for your overlay. Audio playback is working.';
    const result = await piperTtsService.synthesize({ channelID: channel, speechID: `overlay-test-${randomUUID()}`, provider: 'piper', mode: 'speak', language, text, voice: DEFAULT_TTS_SETTINGS.voices[language], outputPath: '' });
    if (result.error || !result.outputPath) throw new OverlayError('Speech test is temporarily unavailable', 502);
    return { text, file: result.outputPath, mime: result.mimeType || 'audio/wav', media: { type: 'audio', title: text, volume: 1 }, cleanup: () => rm(result.outputPath!, { force: true }) };
  }
  if (kind === 'clip') {
    const result = await getChannelClips(channel);
    const clip = result.data?.[0];
    if (result.error || !clip) throw new OverlayError('No channel clip is available to test', 404);
    const url = new URL(clip.url);
    if (url.protocol !== 'https:' || !['clips.twitch.tv', 'www.twitch.tv', 'twitch.tv'].includes(url.hostname) || url.username || url.password) throw new OverlayError('Clip unavailable', 404);
    const dir = await mkdtemp(path.join(tmpdir(), 'overlay-test-'));
    const file = path.join(dir, 'clip.mp4');
    try {
      await run('yt-dlp', ['--no-playlist', '--no-progress', '--max-filesize', '100M', '-S', 'res:480', '-o', file, '--', url.href], { timeout: 60000, maxBuffer: 1024 * 1024 });
      if ((await stat(file)).size > MAX_MEDIA_BYTES) throw new OverlayError('Clip exceeds the playback limit');
      return { file, mime: 'video/mp4', media: { type: 'video', title: 'Clip preview', volume: 1, duration: Math.min(30, Math.max(1, Number(clip.duration) || 30)) }, cleanup: () => rm(dir, { recursive: true, force: true }) };
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw new OverlayError('The clip could not be prepared. Try again.', 502); }
  }
  return { cleanup: async () => {} };
}
export async function previewMedia(channel: string, prepared: PreparedTest) {
  if (!prepared.file) return prepared.media;
  // At most three retained previews per owner (one per media source type).
  const previous = [...files.entries()].filter(([, file]) => file.channel === channel);
  while (previous.length >= 3) { const [id, file] = previous.shift()!; files.delete(id); await file.clean(); }
  const ticket = randomBytes(24).toString('hex');
  files.set(ticket, { channel, path: prepared.file, mime: prepared.mime!, expiresAt: Date.now() + 5 * 60 * 1000, clean: prepared.cleanup });
  setTimeout(() => { files.delete(ticket); void prepared.cleanup().catch(() => {}); }, 5 * 60 * 1000).unref();
  return { ...prepared.media!, url: `/overlay-studio/test-media/${ticket}` };
}
export async function withTestLock<T>(channel: string, fn: () => Promise<T>): Promise<T> {
  const cache = await getDragonflyClient('overlay-test');
  const key = `overlay:test:${channel}`, owner = randomUUID();
  if (await cache.set(key, owner, { NX: true, EX: 120 }) !== 'OK') throw new OverlayError('A test is already being prepared. Please wait.', 429);
  try { return await fn(); }
  finally { await cache.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 3) end return 0", { keys: [key], arguments: [owner] }); }
}
