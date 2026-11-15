import { MediaAssetSchema } from "../../schemas/media_asset.schema.js";
import { UserMediaLibraryItemSchema } from "../../schemas/user_media_library_item.schema.js";
import { buildMediaPlaybackUrl } from "../../server/services/media_library.service.js";

export interface TriggerFileSource {
    channelID: string;
    assetID?: unknown;
    libraryItemID?: unknown;
}

export interface TriggerPlaybackFile {
    fileUrl: string;
    fileType: string;
}

/**
 * The file a trigger plays: its channel's active library item first, then its own `assetID`.
 * Shared by the bot's `$(trigger.send)` and the API's `/triggers/:channelID/send`, so both send the same signed URL.
 * Null for legacy triggers without a resolvable asset.
 */
export async function resolveTriggerPlaybackAsset(trigger: TriggerFileSource): Promise<TriggerPlaybackFile | null> {
    if (trigger.libraryItemID) {
        const libraryItem = await UserMediaLibraryItemSchema.findOne({
            _id: trigger.libraryItemID,
            channelID: trigger.channelID,
            isActive: true,
            deletedAt: null
        }).lean();

        if (libraryItem) {
            const asset = await MediaAssetSchema.findOne({
                _id: libraryItem.assetID,
                deletedAt: null
            }).lean();

            if (asset) {
                return {
                    fileUrl: buildMediaPlaybackUrl(asset._id),
                    fileType: asset.mimeType
                };
            }
        }
    }

    if (trigger.assetID) {
        const asset = await MediaAssetSchema.findOne({
            _id: trigger.assetID,
            deletedAt: null
        }).lean();

        if (asset) {
            return {
                fileUrl: buildMediaPlaybackUrl(asset._id),
                fileType: asset.mimeType
            };
        }
    }

    return null;
}
