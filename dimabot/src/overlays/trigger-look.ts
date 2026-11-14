import { Types } from 'mongoose';
import { OverlayError, alertLayout, canvas, object } from './store.js';
import { layoutSounds, type AlertLayout, type AlertSound, type OverlayWidget } from './model.js';
import { renderLayout } from './ast.js';
import { MediaAssetSchema } from '../schemas/media_asset.schema.js';
import { UserMediaLibraryItemSchema } from '../schemas/user_media_library_item.schema.js';
import { buildMediaPlaybackUrl } from '../server/services/media_library.service.js';
import type { ITrigger, ITriggerLook } from '../schemas/trigger.schema.js';

/** Serialized stored look limit (the PUT route has its own body parser sized for it). */
export const MAX_LOOK_BYTES = 256 * 1024;
export type LookMediaType = 'image' | 'gif' | 'video' | 'audio';
export class LookError extends OverlayError { constructor(message: string, status: number, readonly code: string) { super(message, status); } }
export interface ValidatedLook { width: number; height: number; layout: AlertLayout; mediaIds: string[] }
export interface PlaybackLook { width: number; height: number; layout: AlertLayout }
interface LookMedia { url: string; mediaType: LookMediaType }

/** A look body from the editor: the Studio layout validator in trigger-media mode (canonical `sounds` only). */
export function validateLookLayout(raw: unknown): ValidatedLook {
  const body = object(raw), layout = alertLayout(body.layout, 2, 'trigger');
  return { ...canvas(body), layout, mediaIds: [...new Set(lookReferences(layout).map(ref => ref.mediaId))] };
}
type Reference = { mediaId: string; kind: 'image' | 'video' | 'audio' };
export function lookReferences(layout: AlertLayout): Reference[] {
  return [...layout.widgets.filter(w => w.mediaId).map(w => ({ mediaId: w.mediaId!, kind: w.kind as 'image' | 'video' })),
    ...layoutSounds(layout).filter(s => s.mediaId).map(s => ({ mediaId: s.mediaId!, kind: 'audio' as const }))];
}
const fits = (kind: Reference['kind'], type: LookMediaType) => kind === 'image' ? type === 'image' || type === 'gif' : kind === type;
export const lookBytes = (look: Omit<ITriggerLook, 'updatedAt'> & { updatedAt: Date | string }) => Buffer.byteLength(JSON.stringify(look));

/** `clamp(volume / 100, 0, 1)`; a missing or non-numeric trigger volume plays at full volume. */
export function masterVolume(volume: unknown): number {
  const value = volume === null || volume === undefined || volume === '' || typeof volume === 'boolean' ? NaN : Number(volume);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value / 100)) : 1;
}

/** Channel-owned active library items whose asset is not deleted, by library item id. */
export async function lookMedia(channel: string, mediaIds: readonly string[]): Promise<Map<string, LookMedia>> {
  const ids = [...new Set(mediaIds)].filter(id => Types.ObjectId.isValid(id));
  if (!ids.length) return new Map();
  const items = await UserMediaLibraryItemSchema.find({ _id: { $in: ids }, channelID: channel, isActive: true, deletedAt: null }).select('_id assetID').lean();
  const assets = items.length ? await MediaAssetSchema.find({ _id: { $in: items.map(item => item.assetID) }, deletedAt: null }).select('_id mediaType').lean() : [];
  const byAsset = new Map(assets.map(asset => [String(asset._id), asset]));
  const media = new Map<string, LookMedia>();
  for (const item of items) {
    const asset = byAsset.get(String(item.assetID));
    if (asset) media.set(String(item._id), { url: buildMediaPlaybackUrl(asset._id), mediaType: asset.mediaType });
  }
  return media;
}
/** Save-time reference check: every mediaId is an available library item of this channel of a fitting kind. */
export async function checkLookMedia(channel: string, look: ValidatedLook): Promise<void> {
  const media = await lookMedia(channel, look.mediaIds);
  for (const ref of lookReferences(look.layout)) {
    const found = media.get(ref.mediaId);
    if (!found) throw new LookError('A media file in this look is no longer in your trigger library. Choose another file.', 400, 'look_media_unavailable');
    if (!fits(ref.kind, found.mediaType)) throw new LookError(ref.kind === 'audio' ? 'Sounds need an audio file' : ref.kind === 'video' ? 'Video objects need a video file' : 'Image objects need an image or GIF', 400, 'look_media_kind');
  }
}

type Resolved = (LookMedia & { ok: true }) | { ok: false };
const resolved = (media: Map<string, LookMedia>, mediaId: string, kind: Reference['kind']): Resolved => {
  const found = media.get(mediaId);
  return found && fits(kind, found.mediaType) ? { ...found, ok: true } : { ok: false };
};
/**
 * Pure part of the resolution. Editor form: every object/sound stays, annotated with `mediaUrl`/`url` and `mediaType`, or
 * `unavailable: true`. Playback form: unavailable ones are dropped and the trigger's master volume scales every sound and
 * every video that plays its own sound (a video volume of 0 stays present: it is still a timed video).
 */
export function applyLookMedia(layout: AlertLayout, media: Map<string, LookMedia>, form: 'editor' | 'playback', volume = 1): AlertLayout {
  const widgets: OverlayWidget[] = [];
  for (const widget of layout.widgets) {
    const { mediaUrl: _url, ...item } = widget as OverlayWidget & { mediaType?: unknown; unavailable?: unknown };
    if (form === 'playback' && typeof item.volume === 'number') item.volume = item.volume * volume;
    if (!item.mediaId) { widgets.push(item); continue; }
    const found = resolved(media, item.mediaId, item.kind as Reference['kind']);
    if (found.ok) widgets.push({ ...item, mediaUrl: found.url, ...(form === 'editor' ? { mediaType: found.mediaType } : {}) } as OverlayWidget);
    else if (form === 'editor') widgets.push({ ...item, unavailable: true } as OverlayWidget);
  }
  const sounds: AlertSound[] = [];
  for (const sound of layoutSounds(layout)) {
    const { url: _url, ...item } = sound as AlertSound & { mediaType?: unknown; unavailable?: unknown };
    const found = item.mediaId ? resolved(media, item.mediaId, 'audio') : { ok: false as const };
    if (found.ok) sounds.push({ ...item, url: found.url, ...(form === 'editor' ? { mediaType: found.mediaType } : { volume: item.volume * volume }) } as AlertSound);
    else if (form === 'editor') sounds.push({ ...item, unavailable: true } as AlertSound);
  }
  const { sound: _legacy, sounds: _sounds, ...rest } = layout;
  return { ...rest, widgets, ...(sounds.length ? { sounds } : {}) };
}

/** What the trigger editor loads: the stored look with resolved media (no master volume). */
export async function editorLook(trigger: Pick<ITrigger, 'channelID' | 'look'>) {
  const look = trigger.look;
  if (!look) return null;
  const media = await lookMedia(trigger.channelID, look.mediaIds ?? []);
  return { width: look.width, height: look.height, layout: applyLookMedia(look.layout, media, 'editor'), mediaIds: look.mediaIds ?? [], revision: look.revision, updatedAt: look.updatedAt };
}
/**
 * What OBS plays, never stored: references are checked again now, text templates rendered with empty event data.
 * Callers resolve per request, so after an edit two sources (or a retry) may get different revisions; that is accepted.
 */
export async function resolveLook(trigger: Pick<ITrigger, 'channelID' | 'look' | 'volume'>): Promise<PlaybackLook | null> {
  const look = trigger.look;
  if (!look?.layout) return null;
  const media = await lookMedia(trigger.channelID, look.mediaIds ?? []);
  const layout = applyLookMedia(look.layout, media, 'playback', masterVolume(trigger.volume));
  return { width: look.width, height: look.height, layout: await renderLayout(layout, trigger.channelID, {}) };
}
/** List/create/update responses carry only this, never the whole layout. */
export function lookSummary(look: ITriggerLook, counts?: { objectCount: number; soundCount: number }) {
  return { revision: look.revision, width: look.width, height: look.height, updatedAt: look.updatedAt,
    objectCount: counts?.objectCount ?? look.layout?.widgets?.length ?? 0, soundCount: counts?.soundCount ?? (look.layout ? layoutSounds(look.layout).length : 0) };
}

/** The trigger's look counter (`lookRevision`): every save and delete adds 1, never reset; missing (older triggers) = 0. */
export const lookRevisionOf = (trigger: { lookRevision?: number | null }): number => typeof trigger.lookRevision === 'number' ? trigger.lookRevision : 0;
/** Conditional-update filter: the stored counter must still be the one the editor loaded. */
export const lookRevisionFilter = (triggerID: string, channelID: string, revision: number): Record<string, unknown> =>
  ({ _id: triggerID, channelID, lookRevision: revision === 0 ? { $in: [0, null] } : revision });

// The API is a single process: look saves and library item deletes of a channel run one at a time, so a delete that
// saw no reference and a save that validated the same (still active) item cannot both succeed.
const locks = new Map<string, Promise<unknown>>();
export async function withTriggerMediaLock<T>(channel: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(channel) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(channel, current);
  try { return await current; } finally { if (locks.get(channel) === current) locks.delete(channel); }
}
