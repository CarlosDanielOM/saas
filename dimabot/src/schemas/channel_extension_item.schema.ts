import { Schema, model, type HydratedDocument, Types } from "mongoose";
import type { MediaAssetType } from "./media_asset.schema.js";

export type ChannelExtensionItemCategory = "video" | "audio" | "gif" | "tts";

export interface IChannelExtensionItem {
  _id: Types.ObjectId;
  channelID: string;
  channelName: string;
  createdByUserID: string;
  assetID: Types.ObjectId;
  name: string;
  description: string;
  category: ChannelExtensionItemCategory;
  mediaType: MediaAssetType;
  thumbnailUrl: string;
  durationMs: number;
  bitsPrice: number;
  sku: string;
  volume: number;
  isEnabled: boolean;
  sortOrder: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const channelExtensionItemSchema = new Schema<IChannelExtensionItem>(
  {
    channelID: { type: String, required: true, index: true },
    channelName: { type: String, required: true },
    createdByUserID: { type: String, required: true, index: true },
    assetID: {
      type: Schema.Types.ObjectId,
      ref: "MediaAsset",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: "", trim: true, maxlength: 500 },
    category: {
      type: String,
      required: true,
      enum: ["video", "audio", "gif", "tts"],
      default: "video",
      index: true,
    },
    mediaType: {
      type: String,
      required: true,
      enum: ["video", "audio", "image", "gif"],
      index: true,
    },
    thumbnailUrl: { type: String, default: "" },
    durationMs: { type: Number, default: 0, min: 0 },
    bitsPrice: { type: Number, required: true, min: 0 },
    sku: { type: String, required: true, index: true },
    volume: { type: Number, default: 100, min: 0, max: 100 },
    isEnabled: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0, index: true },
    deletedAt: { type: Date, default: null, index: true },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  },
);

channelExtensionItemSchema.index({ channelID: 1, isEnabled: 1, deletedAt: 1 });
channelExtensionItemSchema.index({ channelID: 1, sortOrder: 1 });

export type ChannelExtensionItemDocument =
  HydratedDocument<IChannelExtensionItem>;

export const ChannelExtensionItemSchema = model<IChannelExtensionItem>(
  "ChannelExtensionItem",
  channelExtensionItemSchema,
);
