import { randomUUID } from "node:crypto";
import fs from "fs/promises";

import type { IChannelExtensionItem } from "../schemas/channel_extension_item.schema.js";
import type { IMediaAsset } from "../schemas/media_asset.schema.js";
import { DimafxPlaybackSchema, type IDimafxPlayback } from "../schemas/dimafx_playback.schema.js";
import { refundDimafxOnce } from "../server/services/dimafx-fulfillment.service.js";
import { getChannelTtsSettings } from "../schemas/channel_tts_settings.schema.js";
import { getIO } from "../server/websocket.js";
import { buildMediaPlaybackUrl } from "../server/services/media_library.service.js";
import { piperTtsService } from "../server/services/tts/piper_tts.service.js";
import { getAudioFileDurationMs } from "../utils/tts/tts_playback_timeout.util.js";
import { promiseWithTimeout } from "../utils/tts/tts_deadline.util.js";

const LEASE_MS = 15_000;
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
  /** Stable ID for a purchase; retries return the original durable job. */
  triggerID?: string;
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

/** Persist before dispatch; claim without removing; finish only after playback. */
export class DimafxQueueHandler {
  private processingChannels = new Set<string>();
  private dispatchedTriggerIds = new Map<string, string>();
  private completionWaiters = new Map<string, () => void>();
  private ttsFiles = new Map<string, string>();
  private readonly owner = randomUUID();

  async isOverlayConnected(channelID: string): Promise<boolean> {
    return this.readySockets(channelID).length > 0;
  }

  private readySockets(channelID: string) {
    const sockets = getIO()?.of(`/overlays/dimafx/${channelID}`).sockets;
    return sockets ? [...sockets.values()].filter(socket => socket.connected && socket.data.dimafxReady) : [];
  }

  async existing(channelID: string, triggerID: string): Promise<DimafxEnqueueResult | null> {
    const job = await DimafxPlaybackSchema.findOne({ _id: triggerID, channelID }).lean();
    if (!job) return null;
    // Even refunded/completed jobs are receipts: never create the purchase again.
    return { ok: true, triggerID, queueLength: await this.queueLength(channelID), activeConnections: this.readySockets(channelID).length };
  }

  private queueLength(channelID: string): Promise<number> {
    return DimafxPlaybackSchema.countDocuments({ channelID, state: { $nin: ['completed', 'refunded'] } }).exec();
  }

  async enqueue(input: DimafxEnqueueInput): Promise<DimafxEnqueueResult> {
    const { channelID, item, asset } = input;
    const triggerID = input.triggerID || randomUUID();
    const existing = await this.existing(channelID, triggerID);
    if (existing) return existing;
    const isTts = item.category === 'tts';
    if (!isTts && !asset) return { ok: false, status: 500, message: 'DimaFX item has no playable media' };
    if (!await this.isOverlayConnected(channelID)) return { ok: false, status: 409, message: 'DimaFX overlay is disconnected' };
    if (await this.queueLength(channelID) >= MAX_QUEUE_ITEMS) return { ok: false, status: 429, message: 'DimaFX queue is full for this channel' };
    let tts: DimafxQueueItem['tts'];
    if (isTts) {
      const config = item.tts;
      const text = config?.mode === 'fixed' ? config.text : (input.viewerText || '');
      if (!text.trim()) return { ok: false, status: 400, message: 'TTS text is required for this item' };
      const language = config?.language === 'es' ? 'es' : 'en';
      const voice = config?.voice || (await getChannelTtsSettings(channelID, item.channelName || '')).voices[language];
      tts = { text: text.trim(), voice, language };
    }
    const payload: DimafxQueueItem = {
      triggerID, channelID, itemID: String(item._id), name: item.name, category: item.category,
      mediaUrl: asset ? buildMediaPlaybackUrl(asset._id) : undefined,
      mediaType: isTts ? 'audio/wav' : asset?.mimeType || item.mediaType,
      volume: Math.max(0, Math.min(100, Number(item.volume ?? 100))),
      durationMs: Math.max(0, Number(item.durationMs || 0)),
      ...(tts ? { tts } : {}),
      ...(input.refundOnFailure ? { refundOnFailure: input.refundOnFailure } : {}),
      source: input.source, enqueuedAt: Date.now(),
    };
    // _id is a built-in unique index. Upsert is safe even before custom indexes exist.
    try {
      await DimafxPlaybackSchema.updateOne({ _id: triggerID }, { $setOnInsert: { channelID, payload, state: 'queued', leaseOwner: '', leaseUntil: new Date(0) } }, { upsert: true });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    void this.processNext(channelID);
    return { ok: true, triggerID, queueLength: await this.queueLength(channelID), activeConnections: this.readySockets(channelID).length };
  }

  async processNext(channelID: string): Promise<void> {
    if (this.processingChannels.has(channelID)) return;
    this.processingChannels.add(channelID);
    try {
      while (await this.isOverlayConnected(channelID)) {
        const first = await DimafxPlaybackSchema.findOne({ channelID, state: { $nin: ['completed', 'refunded'] } }).sort({ createdAt: 1, _id: 1 }).lean();
        if (!first) return;
        const job = await DimafxPlaybackSchema.findOneAndUpdate(
          { _id: first._id, state: { $nin: ['completed', 'refunded'] }, $or: [{ leaseUntil: { $lte: new Date() } }, { leaseOwner: this.owner }] },
          { $set: { leaseOwner: this.owner, leaseUntil: new Date(Date.now() + LEASE_MS) } }, { new: true },
        ).lean();
        // The previous process may still be alive. The connection poll retries
        // after its lease expires; never steal an active producer's work.
        if (!job) return;
        const heartbeat = setInterval(() => {
          void DimafxPlaybackSchema.updateOne({ _id: job._id, leaseOwner: this.owner }, { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).catch(error => console.error('DimaFX lease renewal failed', error));
        }, LEASE_MS / 3);
        try {
          if (job.state === 'refunding') {
            await this.refundViewer(job);
            continue;
          }
          await DimafxPlaybackSchema.updateOne({ _id: job._id, leaseOwner: this.owner }, { $set: { state: 'playing' } });
          this.dispatchedTriggerIds.set(channelID, job._id);
          try {
            await this.dispatch(channelID, job.payload);
          } catch (error) {
            if (!await this.isOverlayConnected(channelID)) return;
            const failure = error instanceof Error ? error.message : String(error);
            await DimafxPlaybackSchema.updateOne({ _id: job._id, leaseOwner: this.owner, state: 'playing' }, { $set: { state: 'refunding', failure } });
            await this.refundViewer(job);
            continue;
          }
          // A disconnect cannot turn an unacknowledged purchase into success.
          // Keep its stable ID so the player can acknowledge/redeliver on reconnect.
          if (!await this.isOverlayConnected(channelID)) return;
          await DimafxPlaybackSchema.updateOne({ _id: job._id, leaseOwner: this.owner, state: 'playing' }, { $set: { state: 'completed' } });
        } finally {
          clearInterval(heartbeat);
          this.dispatchedTriggerIds.delete(channelID);
          await DimafxPlaybackSchema.updateOne({ _id: job._id, leaseOwner: this.owner }, { $set: { leaseOwner: '', leaseUntil: new Date(0) } });
        }
      }
    } catch (error) {
      // A storage failure leaves the durable job recoverable; it must not be
      // mistaken for a playback failure and refunded while still playing.
      console.error('DimaFX queue processing failed', { channelID, error });
    } finally {
      this.processingChannels.delete(channelID);
    }
  }

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
      throw new Error("DimaFX overlay disconnected before dispatch");
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
      const done = this.waitForCompletion(channelID, queueItem.triggerID, waitMs);
      const deliver = () => { for (const socket of this.readySockets(channelID)) socket.emit('dimafx-play', body); };
      deliver();
      // Stable IDs let the OBS player reject duplicate deliveries, including
      // a lost acknowledgement or API restart during playback.
      const redelivery = setInterval(deliver, 5_000);
      console.log("DimaFX trigger dispatched", {
        channelID,
        triggerID: queueItem.triggerID,
        itemID: queueItem.itemID,
        source: queueItem.source,
        queuedMs: Date.now() - queueItem.enqueuedAt,
      });

      try { await done; } finally { clearInterval(redelivery); }
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

  /** Only authenticated, ready DimaFX sockets can complete their channel's job. */
  async handleTriggerEnded(channelID: string, triggerID?: string): Promise<void> {
    if (!triggerID || this.dispatchedTriggerIds.get(channelID) !== triggerID) return;
    await DimafxPlaybackSchema.updateOne(
      { _id: triggerID, channelID, leaseOwner: this.owner, state: 'playing' },
      { $set: { state: 'completed' } },
    );
    const key = `${channelID}:${triggerID}`;
    const waiter = this.completionWaiters.get(key);
    this.completionWaiters.delete(key);
    waiter?.();
  }

  async resumeIfIdle(channelID: string): Promise<void> {
    await this.processNext(channelID);
  }

  private async refundViewer(job: IDimafxPlayback): Promise<void> {
    const refund = job.payload.refundOnFailure;
    if (refund) await refundDimafxOnce(job.channelID, refund.userID, refund.priceBits, `refund:${job._id}`);
    await DimafxPlaybackSchema.updateOne({ _id: job._id, leaseOwner: this.owner }, { $set: { state: 'refunded' } });
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
