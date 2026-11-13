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
}
