import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import { Types } from "mongoose";
import type { RedisClientType } from "redis";

import type { IChannelExtensionItem } from "../schemas/channel_extension_item.schema.js";
import type { IMediaAsset } from "../schemas/media_asset.schema.js";
import { ExtensionWalletTransactionSchema } from "../schemas/extension_wallet_transaction.schema.js";
import { UserExtensionInventorySchema } from "../schemas/user_extension_inventory.schema.js";
import { getChannelTtsSettings } from "../schemas/channel_tts_settings.schema.js";
import { getIO } from "../server/websocket.js";
import { studioHasSource, publishStudioTrigger } from "../overlays/bridge.js";
import { buildMediaPlaybackUrl } from "../server/services/media_library.service.js";
import { piperTtsService } from "../server/services/tts/piper_tts.service.js";
import { getAudioFileDurationMs } from "../utils/tts/tts_playback_timeout.util.js";
import { promiseWithTimeout } from "../utils/tts/tts_deadline.util.js";
import { getDragonflyClient } from "../utils/databases/dragonfly.database.js";

const PROCESSING_LOCK_TTL_SECONDS = 150;
const QUEUE_DATA_TTL_SECONDS = 3600;
const MAX_QUEUE_ITEMS = 25;
const TTS_SYNTHESIS_TIMEOUT_MS = 45_000;
const MIN_PLAYBACK_WAIT_MS = 2_000;
const MAX_PLAYBACK_WAIT_MS = 120_000;
const DEFAULT_MEDIA_WAIT_MS = 30_000;
const DEFAULT_IMAGE_WAIT_MS = 5_000;
const DEFAULT_TTS_WAIT_MS = 15_000;
const PLAYBACK_GRACE_MS = 750;

export type DimafxQueueSource =
  | "bits_purchase"
  | "credit_purchase"
  | "redeem_saved"
  | "test";

export interface DimafxEnqueueInput {
  channelID: string;
  item: IChannelExtensionItem;
  asset: IMediaAsset | null;
  /** Sanitized viewer text for custom TTS items. */
  viewerText?: string;
  /** Credits the viewer if the queued trigger fails before/during dispatch. */
  refundOnFailure?: { userID: string; priceBits: number };
  source: DimafxQueueSource;
}

export interface DimafxQueueItem {
  triggerID: string;
  channelID: string;
  itemID: string;
  name: string;
  category: string;
  mediaUrl?: string;
  mediaType?: string;
  volume: number;
  durationMs: number;
  tts?: { text: string; voice: string; language: "en" | "es" };
  refundOnFailure?: { userID: string; priceBits: number };
  source: DimafxQueueSource;
  enqueuedAt: number;
}

export type DimafxEnqueueResult =
  | { ok: true; triggerID: string; queueLength: number; activeConnections: number }
  | { ok: false; status: number; message: string };

/**
 * Durable per-channel playback queue for DimaFX storefront triggers.
 *
 * Mirrors the TTS queue pattern: purchases enqueue into Redis, one item per
 * channel dispatches at a time, and playback completes on the overlay ack
 * (`dimafx-ended`) or a duration-based timeout, whichever comes first.
 * Waiting items survive brief overlay disconnects and API restarts.
 */
class DimafxQueueHandler {
  private cache: RedisClientType | null = null;
  private initialized = false;
  private processingChannels = new Set<string>();
  private dispatchedTriggerIds = new Map<string, string>();
  private completionWaiters = new Map<string, () => void>();
  private ttsFiles = new Map<string, string>();

  async init(): Promise<void> {
    if (this.initialized) return;
    this.cache = await getDragonflyClient("DimafxQueueHandler:init");
    this.initialized = true;
  }

  private queueKey(channelID: string): string {
    return `twitch:${channelID}:dimafx:queue`;
  }

  private dataKey(channelID: string, triggerID: string): string {
    return `twitch:${channelID}:dimafx:queue:data:${triggerID}`;
  }

  private lockKey(channelID: string): string {
    return `twitch:${channelID}:dimafx:processing`;
  }

  async isOverlayConnected(channelID: string): Promise<boolean> {
    if (studioHasSource(channelID, "trigger")) return true;
    const namespace = getIO()?.of(`/overlays/triggers/${channelID}`);
    if (!namespace) return false;
    const sockets = await namespace.fetchSockets();
    return sockets.length > 0;
  }

  async enqueue(input: DimafxEnqueueInput): Promise<DimafxEnqueueResult> {
    if (!this.cache) await this.init();

    const { channelID, item, asset } = input;
    const isTts = item.category === "tts";

    if (!isTts && !asset) {
      return { ok: false, status: 500, message: "DimaFX item has no playable media" };
    }

    if (!(await this.isOverlayConnected(channelID))) {
      return { ok: false, status: 409, message: "No trigger overlay clients connected" };
    }

    const queueLength = await this.cache!.zCard(this.queueKey(channelID));
    const processingActive = this.processingChannels.has(channelID);
    if (queueLength + (processingActive ? 1 : 0) >= MAX_QUEUE_ITEMS) {
      return { ok: false, status: 429, message: "DimaFX queue is full for this channel" };
    }

    let tts: DimafxQueueItem["tts"];
    if (isTts) {
      const config = item.tts;
      const text = config?.mode === "fixed" ? config.text : (input.viewerText || "");
      if (!text.trim()) {
        return { ok: false, status: 400, message: "TTS text is required for this item" };
      }
      const language = config?.language === "es" ? "es" : "en";
      let voice = config?.voice || "";
      if (!voice) {
        const settings = await getChannelTtsSettings(channelID, item.channelName || "");
        voice = settings.voices[language];
      }
      tts = { text: text.trim(), voice, language };
    }

    const triggerID = randomUUID();
    const queueItem: DimafxQueueItem = {
      triggerID,
      channelID,
      itemID: String(item._id),
      name: item.name,
      category: item.category,
      mediaUrl: asset ? buildMediaPlaybackUrl(asset._id) : undefined,
      mediaType: isTts ? "audio/wav" : asset?.mimeType || item.mediaType,
      volume: Math.max(0, Math.min(100, Number(item.volume ?? 100))),
      durationMs: Math.max(0, Number(item.durationMs || 0)),
      ...(tts ? { tts } : {}),
      ...(input.refundOnFailure ? { refundOnFailure: input.refundOnFailure } : {}),
      source: input.source,
      enqueuedAt: Date.now(),
    };

    await this.cache!.set(this.dataKey(channelID, triggerID), JSON.stringify(queueItem), {
      EX: QUEUE_DATA_TTL_SECONDS,
    });
    await this.cache!.zAdd(this.queueKey(channelID), { score: queueItem.enqueuedAt, value: triggerID });

    if (!processingActive) {
      await this.cache!.set(this.lockKey(channelID), "pending", { EX: PROCESSING_LOCK_TTL_SECONDS });
      void this.processNext(channelID);
    }

    const namespace = getIO()?.of(`/overlays/triggers/${channelID}`);
    const activeConnections = namespace ? (await namespace.fetchSockets()).length : 0;

    return { ok: true, triggerID, queueLength: queueLength + 1, activeConnections };
  }

  async processNext(channelID: string): Promise<void> {
    if (!this.cache) await this.init();
    if (this.processingChannels.has(channelID)) return;
    this.processingChannels.add(channelID);

    try {
      while (true) {
        if (!(await this.isOverlayConnected(channelID))) {
          // Preserve waiting items until an overlay reconnects; the reconnect
          // path (websocket namespace / overlay studio) calls resumeIfIdle.
          this.processingChannels.delete(channelID);
          return;
        }

        const next = await this.cache!.zPopMin(this.queueKey(channelID));
        if (!next?.value) {
          await this.cache!.del(this.lockKey(channelID));
          this.processingChannels.delete(channelID);
          if ((await this.cache!.zCard(this.queueKey(channelID))) > 0) {
            void this.processNext(channelID);
          }
          return;
        }

        const triggerID = next.value;
        const rawData = await this.cache!.get(this.dataKey(channelID, triggerID));
        if (!rawData) continue;

        let queueItem: DimafxQueueItem;
        try {
          queueItem = JSON.parse(rawData) as DimafxQueueItem;
        } catch {
          await this.cache!.del(this.dataKey(channelID, triggerID));
          continue;
        }

        await this.cache!.set(this.lockKey(channelID), triggerID, { EX: PROCESSING_LOCK_TTL_SECONDS });
        this.dispatchedTriggerIds.set(channelID, triggerID);

        try {
          await this.dispatch(channelID, queueItem);
        } catch (error) {
          console.error("DimaFX trigger dispatch failed:", {
            channelID,
            triggerID,
            itemID: queueItem.itemID,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          });
          await this.refundViewer(queueItem, error instanceof Error ? error.message : String(error));
        }

        this.dispatchedTriggerIds.delete(channelID);
        await this.cache!.del(this.dataKey(channelID, triggerID));
      }
    } catch (error) {
      console.error("DimaFX queue processing failed:", {
        channelID,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      this.processingChannels.delete(channelID);
      this.dispatchedTriggerIds.delete(channelID);
      try {
        await this.cache!.del(this.lockKey(channelID));
      } catch {
        // Drop the in-memory lock even when Redis is unavailable.
      }
    }
  }

  /**
   * Dispatches one queued item to every connected overlay and resolves when
   * playback finishes (overlay ack or duration timeout).
   */
  private async dispatch(channelID: string, queueItem: DimafxQueueItem): Promise<void> {
    let mediaUrl = queueItem.mediaUrl;
    let mediaType = queueItem.mediaType || "video/mp4";
    let waitMs = this.playbackWaitMs(queueItem);

    if (queueItem.tts) {
      const synthesis = await promiseWithTimeout(
        piperTtsService.synthesize({
          channelID,
          speechID: queueItem.triggerID,
          mode: "speak",
          provider: "piper",
          text: queueItem.tts.text,
          language: queueItem.tts.language,
          voice: queueItem.tts.voice,
          outputPath: "",
        }),
        TTS_SYNTHESIS_TIMEOUT_MS,
        "DimaFX TTS synthesis timed out",
      );

      if (synthesis.error || !synthesis.outputPath || !synthesis.publicPath) {
        throw new Error(synthesis.message || "DimaFX TTS synthesis failed");
      }

      this.ttsFiles.set(`${channelID}:${queueItem.triggerID}`, synthesis.outputPath);
      mediaUrl = synthesis.publicPath;
      mediaType = synthesis.mimeType || "audio/wav";

      const probed = await getAudioFileDurationMs(synthesis.outputPath);
      waitMs = this.clampWait((probed > 0 ? probed : DEFAULT_TTS_WAIT_MS) + PLAYBACK_GRACE_MS);
    }

    if (!mediaUrl) {
      this.scheduleTtsFileCleanup(channelID, queueItem.triggerID);
      throw new Error("DimaFX trigger has no media URL");
    }

    // The overlay may have disconnected while TTS synthesis was running.
    if (!(await this.isOverlayConnected(channelID))) {
      this.scheduleTtsFileCleanup(channelID, queueItem.triggerID);
      throw new Error("Trigger overlay disconnected before dispatch");
    }

    const body = {
      url: mediaUrl,
      mediaType,
      volume: queueItem.volume,
      source: "dimafx",
      itemID: queueItem.itemID,
      triggerID: queueItem.triggerID,
      name: queueItem.name,
      ...(queueItem.tts ? { text: queueItem.tts.text } : {}),
    };

    try {
      getIO()?.of(`/overlays/triggers/${channelID}`).emit("trigger", body);
      publishStudioTrigger(channelID, body);
      console.log("DimaFX trigger dispatched", {
        channelID,
        triggerID: queueItem.triggerID,
        itemID: queueItem.itemID,
        source: queueItem.source,
        queuedMs: Date.now() - queueItem.enqueuedAt,
      });

      await this.waitForCompletion(channelID, queueItem.triggerID, waitMs);
    } finally {
      this.scheduleTtsFileCleanup(channelID, queueItem.triggerID);
    }
  }

  private playbackWaitMs(queueItem: DimafxQueueItem): number {
    const isImage = queueItem.category === "gif" || (queueItem.mediaType || "").startsWith("image");
    const base = queueItem.durationMs > 0
      ? queueItem.durationMs
      : isImage
        ? DEFAULT_IMAGE_WAIT_MS
        : DEFAULT_MEDIA_WAIT_MS;
    return this.clampWait(base + PLAYBACK_GRACE_MS);
  }

  private clampWait(value: number): number {
    return Math.min(MAX_PLAYBACK_WAIT_MS, Math.max(MIN_PLAYBACK_WAIT_MS, Math.ceil(value)));
  }

  /** Resolves on the overlay ack or when the duration timeout fires. */
  private waitForCompletion(channelID: string, triggerID: string, waitMs: number): Promise<void> {
    const waiterKey = `${channelID}:${triggerID}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.completionWaiters.delete(waiterKey);
        resolve();
      }, waitMs);
      this.completionWaiters.set(waiterKey, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Overlay ack hook — invoked from the `/overlays/triggers/` namespace. */
  handleTriggerEnded(channelID: string, triggerID?: string): void {
    if (!triggerID) return;
    if (this.dispatchedTriggerIds.get(channelID) !== triggerID) return;
    const waiter = this.completionWaiters.get(`${channelID}:${triggerID}`);
    if (waiter) {
      this.completionWaiters.delete(`${channelID}:${triggerID}`);
      console.log("DimaFX trigger finished", { channelID, triggerID });
      waiter();
    }
  }

  /** Called when a trigger overlay (legacy namespace or studio) connects. */
  async resumeIfIdle(channelID: string): Promise<void> {
    if (!this.cache) await this.init();
    if (this.processingChannels.has(channelID)) return;

    const staleLock = await this.cache!.get(this.lockKey(channelID));
    if (staleLock) {
      await this.cache!.del(this.lockKey(channelID));
    }
    if (this.processingChannels.has(channelID)) return;

    if ((await this.cache!.zCard(this.queueKey(channelID))) > 0) {
      void this.processNext(channelID);
    }
  }

  private async refundViewer(queueItem: DimafxQueueItem, reason: string): Promise<void> {
    const refund = queueItem.refundOnFailure;
    if (!refund || refund.priceBits <= 0) return;
    try {
      await UserExtensionInventorySchema.updateOne(
        { platform: "twitch", userID: refund.userID, channelID: queueItem.channelID },
        { $inc: { balance: refund.priceBits } },
      );
      await ExtensionWalletTransactionSchema.create({
        platform: "twitch",
        userID: refund.userID,
        channelID: queueItem.channelID,
        type: "refund_credit",
        amountBits: refund.priceBits,
        balanceDelta: refund.priceBits,
        channelExtensionItemID: new Types.ObjectId(queueItem.itemID),
        metadata: { reason: `queue_dispatch_failed: ${reason}` },
      });
      console.warn("DimaFX viewer refunded after queue dispatch failure", {
        channelID: queueItem.channelID,
        userID: refund.userID,
        triggerID: queueItem.triggerID,
        priceBits: refund.priceBits,
      });
    } catch (error) {
      console.error("DimaFX queue refund failed:", {
        channelID: queueItem.channelID,
        userID: refund.userID,
        triggerID: queueItem.triggerID,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }

  private scheduleTtsFileCleanup(channelID: string, triggerID: string): void {
    const key = `${channelID}:${triggerID}`;
    const filePath = this.ttsFiles.get(key);
    if (!filePath) return;
    this.ttsFiles.delete(key);
    // Keep the file briefly so slow overlay fetches still succeed.
    setTimeout(() => {
      void fs.unlink(filePath).catch(() => {
        // Ignore missing temp files during delayed cleanup.
      });
    }, 120_000);
  }
}

const dimafxQueueHandler = new DimafxQueueHandler();

export { dimafxQueueHandler };
