import { MediaAsset } from '../triggers/triggers.model';

export type DimafxCategory = 'video' | 'gif' | 'audio' | 'tts';

export interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
  meta?: Record<string, unknown>;
}

export interface ChannelExtensionItem {
  _id: string;
  id: string;
  channelID: string;
  channelName: string;
  assetID: string;
  name: string;
  description: string;
  category: DimafxCategory;
  mediaType: MediaAsset['mediaType'];
  thumbnailUrl: string;
  durationMs: number;
  bitsPrice: number;
  sku: string;
  volume: number;
  isEnabled: boolean;
  sortOrder: number;
  mediaUrl: string | null;
  asset: MediaAsset | null;
  createdAt: string;
  updatedAt: string;
}

export interface DimafxItemsResponse {
  items: ChannelExtensionItem[];
  allowedBitPrices: number[];
}

export interface CreateChannelExtensionItemRequest {
  assetID: string;
  channelName?: string;
  name: string;
  description?: string;
  category: DimafxCategory;
  thumbnailUrl?: string;
  durationMs?: number;
  bitsPrice: number;
  volume?: number;
  isEnabled?: boolean;
  sortOrder?: number;
}

export type UpdateChannelExtensionItemRequest = Partial<CreateChannelExtensionItemRequest>;
