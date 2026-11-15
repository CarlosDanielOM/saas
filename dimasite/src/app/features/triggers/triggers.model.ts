export type PlanTier = 'free' | 'premium' | 'pro';
export type MediaScope = 'public' | 'private';
export type MediaType = 'video' | 'audio' | 'image' | 'gif';
export const SUPPORTED_TRIGGER_MEDIA_TYPES: ReadonlySet<MediaType> = new Set(['video', 'audio', 'image', 'gif']);

// File types browsers report that both pass the API upload filter
// (dimabot trigger.route.ts `acceptableMimeTypes`) and play in OBS.
// iPhone HEIC/MOV and SVG are refused on purpose. Keep in sync with the API list.
export const TRIGGER_UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/aac'
]);
const IPHONE_UPLOAD_MIME_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence', 'video/quicktime']);
// Windows and Android often report HEIC files with an empty type, so the extension counts too.
const IPHONE_UPLOAD_EXTENSION = /\.(heic|heif|mov)$/i;

export type TriggerUploadIssue = 'iphone' | 'unsupported';

export function getTriggerUploadIssue(file: Pick<File, 'name' | 'type'>): TriggerUploadIssue | null {
  const type = file.type.toLowerCase();
  if (IPHONE_UPLOAD_MIME_TYPES.has(type) || IPHONE_UPLOAD_EXTENSION.test(file.name)) return 'iphone';
  return TRIGGER_UPLOAD_MIME_TYPES.has(type) ? null : 'unsupported';
}
export type TriggersTab = 'library' | 'marketplace';

export interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
  total?: number;
  meta?: Record<string, unknown>;
}

export interface TriggerRecord {
  _id: string;
  name: string;
  channel: string;
  channelID: string;
  rewardID: string;
  file: string;
  fileID?: string | null;
  assetID?: string | null;
  libraryItemID?: string | null;
  type: string;
  mediaType: string;
  isEnabled: boolean;
  cost: number;
  cooldown: number;
  prompt: string;
  volume: number;
  reward?: LinkedRewardRecord | null;
  /** Present when the trigger has its own look (list/create/update responses never carry the layout). */
  look?: TriggerLookSummary | null;
}

/** What trigger list responses say about a trigger's look. */
export interface TriggerLookSummary {
  revision: number;
  width: number;
  height: number;
  updatedAt: string;
  objectCount: number;
  soundCount: number;
  /** Library item ids the look uses (its objects and sounds): those files count as in use. */
  mediaIds?: string[];
}

/**
 * A trigger's look in editor form (GET/PUT `/triggers/:channelID/:triggerID/look`). Its layout is an alert layout
 * (see `features/overlays/overlay.model.ts` `AlertLayout`) whose files reference trigger library items (`mediaId`);
 * the API adds `mediaUrl`/`url`, `mediaType` and `unavailable: true` to each of them. No master volume applied.
 */
export interface TriggerLook {
  width: number;
  height: number;
  layout: unknown;
  mediaIds?: string[];
  revision: number;
  updatedAt?: string;
}

/** `revision` is the trigger's look revision counter (0 when no look was ever saved); `volume` its 0–100 master volume. */
export interface TriggerLookState {
  look: TriggerLook | null;
  volume: number;
  revision: number;
}

export interface TriggerLookSaveRequest {
  width: number;
  height: number;
  layout: unknown;
  revision: number;
}

/** Error codes of the look routes (400 unless noted); bodies over 320 kB get an HTML 413 instead. */
export type TriggerLookErrorCode = 'invalid_look' | 'look_media_unavailable' | 'look_media_kind' | 'look_too_large' | 'look_conflict' | 'too_large';

/** Upload size per plan, as the API enforces it (dimabot trigger.route.ts). */
export function triggerUploadLimitBytes(planTier: PlanTier): number {
  return planTier === 'pro' ? 100 * 1024 * 1024 : planTier === 'premium' ? 25 * 1024 * 1024 : 5 * 1024 * 1024;
}

/** A valid trigger/media name from any text (same rule as the Triggers page upload): letters, digits and `_`, no leading digit. */
export function safeMediaName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^\d+/, '')
    .slice(0, 60);
}

export interface LinkedRewardRecord {
  _id: string;
  rewardID: string;
  title: string;
  type: string;
  prompt: string;
  originalCost: number;
  cost: number;
  isEnabled: boolean;
  message: string;
  costChange: number;
  returnToOriginalCost: boolean;
  duration: number;
  cooldown: number;
  backgroundColor?: string;
  createdFrom: string;
  createdFor: string;
}

export interface MediaAsset {
  _id: string;
  ownerChannelID: string;
  ownerChannelName: string;
  displayName: string;
  fileName: string;
  extension: string;
  mimeType: string;
  mediaType: MediaType;
  bytes: number;
  storageUrl: string;
  playbackUrl: string;
  scope: MediaScope;
  marketplaceStatus: 'not_listed' | 'published' | 'pending_review' | 'hidden' | 'removed';
  createdAt: string;
  updatedAt: string;
}

export interface MediaLibraryItem {
  _id: string;
  assetID: string;
  relationType: 'owner_upload' | 'public_library_add';
  localAlias: string | null;
  quotaBytesCharged: number;
  assetScope: MediaScope;
  mediaType: MediaType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  asset: MediaAsset | null;
}

export interface MediaLibraryMeta {
  planTier: PlanTier;
  quotaBytesUsed: number;
  quotaBytesLimit: number;
}

export interface MediaLibraryResponse {
  items: MediaLibraryItem[];
  total: number;
  meta: MediaLibraryMeta;
}

export interface MediaLibraryMutationResult {
  item: MediaLibraryItem;
  /** null when the API response carries no quota info (e.g. the item already existed). */
  meta: MediaLibraryMeta | null;
}

export interface CreateTriggerRequest {
  name: string;
  libraryItemID: string;
  volume?: number;
  reward?: TriggerRewardDraft | null;
}

export interface UpdateTriggerRequest {
  name?: string;
  libraryItemID?: string;
  volume?: number;
  isEnabled?: boolean;
  reward?: TriggerRewardDraft | null;
}

export interface TriggerRewardDraft {
  create?: boolean;
  title?: string;
  prompt?: string;
  cost?: number;
  message?: string;
  cooldown?: number;
  userInput?: boolean;
  skipQueue?: boolean;
  isEnabled?: boolean;
  costChange?: number;
  returnToOriginalCost?: boolean;
  duration?: number;
  backgroundColor?: string;
}

export interface UploadMediaRequest {
  file: File;
  name: string;
  scope: MediaScope;
}

export interface TriggerTestPayload {
  triggerId?: string;
  name?: string;
  url: string;
  mediaType: string;
  volume: number;
  /** Who pressed Test (the signed-in user): a look's `$(user)` shows them. Empty fields are left out. */
  firedBy?: { login?: string; name?: string };
}

/** The trigger a look belongs to, as the Triggers page or Overlay Studio knows it. */
export interface TriggerLookTarget {
  channelID: string;
  triggerId: string;
  name: string;
  /** The trigger's own file (first content of a new look). */
  libraryItemID: string | null;
  mediaType: MediaType | null;
  mediaUrl: string;
  mediaName?: string;
}

/** What the host learns when the look editor closes (the Triggers page refreshes that row). */
export interface TriggerLookClosed { triggerId: string; changed: boolean; look: TriggerLookSummary | null }

/** The look target for a trigger, with its own file found in the channel's library. */
export function lookTargetFor(channelID: string, trigger: TriggerRecord, library: readonly MediaLibraryItem[]): TriggerLookTarget {
  const item = library.find(entry => entry._id === trigger.libraryItemID) ?? library.find(entry => entry.assetID === trigger.assetID);
  return {
    channelID, triggerId: trigger._id, name: trigger.name, libraryItemID: item?._id ?? trigger.libraryItemID ?? null,
    mediaType: item?.asset?.mediaType ?? item?.mediaType ?? null, mediaUrl: item?.asset?.playbackUrl ?? '',
    mediaName: item ? (item.localAlias || item.asset?.displayName || trigger.name) : trigger.name
  };
}
