import { readTtsQueueChannels, readTtsAvailable, parkReadTts, reserveReadTts, prepareReadTts, releaseReadTts, reportReadTts, isReadTtsConfigured, hasReadTtsTurn, readTtsTurnCurrent, protectReadTtsTurn, type ReadTtsRoute } from '../pets/tts_bridge.js';
import { studioQueueChannels, publishStudioReadTts, endStudioReadTts } from '../overlays/bridge.js';
import type { TtsStatusData } from '../utils/tts/tts_status.js';
import { telemetryContext, restoreContext, traced, observe, type TraceContext } from '../utils/observability/telemetry.js';
import { studioHasSource, studioHasLiveSource, publishStudioMedia, controlStudioTts, studioTtsStatus } from '../overlays/bridge.js';
import type { RedisClientType } from "redis";
import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import path from "path";

import { getDragonflyClient } from "../utils/databases/dragonfly.database.js";
import type {
  ChannelTtsSettingsData,
  TtsLanguage,
  TtsMode,
} from "../schemas/channel_tts_settings.schema.js";
import { generateSpeechID } from "../utils/tts/generate_speech_id.util.js";
import { getIO } from "../server/websocket.js";
import {
  piperTtsService,
  PIPER_PUBLIC_SPEECH_DIR,
} from "../server/services/tts/piper_tts.service.js";
import { kokoroTtsService } from "../server/services/tts/kokoro_tts.service.js";
import { fishTtsService } from "../server/services/tts/fish_tts.service.js";
import type {
  RuntimeTtsProvider,
  TtsProvider as TtsServiceContract,
} from "../server/services/tts/tts_provider.interface.js";
import TwitchStreamers from "../classes/twitch_streamers.class.js";
import { trackTtsUsage } from "../utils/tts_usage.js";
import {
  getAiCredits,
  isAiCreditsExhausted,
  type AiCreditStatus,
} from "../utils/billing.js";
import { resolveTtsForCreditStatus } from "../utils/tts/tts_credit_fallback.util.js";
import { promiseWithTimeout } from "../utils/tts/tts_deadline.util.js";
import { getTtsPlaybackTimeoutMs } from "../utils/tts/tts_playback_timeout.util.js";
import { trackAiOperation } from "../utils/posthog_events.js";
import { enqueueTtsSession, popTtsSession } from '../utils/tts/tts_session.util.js';
import { petLaneItem, startPetLaneTurn, endPetLaneTurn, type PetLaneItem } from '../pets/tts_lane.js';

const TTS_PROCESSING_TTL_SECONDS = 150;
const DEFAULT_TTS_SYNTHESIS_TIMEOUT_MS = 45_000;

export interface TtsRequestPayload {
  channelID: string;
  source: "chat-command" | "ast" | "redemption";
  mode: TtsMode;
  provider: RuntimeTtsProvider;
  model?: string;
  text: string;
  language: TtsLanguage;
  voice: string;
  cloneName?: string;
  requestedBy?: {
    userID?: string;
    userLogin?: string;
    userName?: string;
    userLevel?: number;
  };
  meta?: {
    originalText?: string;
    skipEmotes?: boolean;
    stripLinks?: boolean;
  };
}

export interface TtsQueueItem extends TtsRequestPayload {
  observability?: TraceContext;
  speechID: string;
  timestamp: number;
  piperFallbackVoice?: string;
  kokoroFallbackVoice?: string;
  usageRequestID?: string;
  usageEntryID?: string;
  queueSession?: string | null;
}

export interface QueueTtsResponse {
  error: boolean;
  message: string;
  status: number;
  data?: {
    speechID: string;
    queueLength: number;
    mode: TtsMode;
  };
}

interface ReadTtsHead {
  item: TtsQueueItem; session: string | null; epoch: number; wakeVersion: number; cancelled: boolean;
  phase: 'preparing' | 'generated' | 'parked' | 'emitted' | 'terminal'; running: boolean;
  generated?: { file: string; audioUrl: string; mime: string; text: string; mode: TtsMode; timeoutMs: number };
  analysis: NonNullable<import('../pets/tts_bridge.js').ReadTtsInput['analysis']>;
  cancellation: AbortController;
  completion?: Promise<void>;
}
const MAX_READ_TTS_HEADS = 128;
const MAX_READ_TTS_PUMPS = 8;
class TtsQueueHandler {
  private cache: RedisClientType | null = null;
  private initialized = false;
  private readHeads = new Map<string, ReadTtsHead>();
  private headWakes = new Set<string>();
  private pumpScheduled = false;
  private activePumps = 0;
  private headClaims = new Set<string>();
  private capacityWaiters = new Set<string>();
  private capacityWakeScheduled = false;
  private backlogWakeRequested = false;
  private recoveringQueues = false;
  private outputRegistry = 0;
  private outputCursors: (Iterator<string | undefined> | undefined)[] = [];
  private sessionCursor = 0;
  private controls = new Map<string, Promise<void>>();
  private dispatches = new Map<string, Promise<void>>();
  private processingChannels = new Set<string>();
  private activeSpeechIds = new Map<string, string>();
  private dispatchedSpeechIds = new Map<string, string>();
  private interruptedSpeechIds = new Map<string, string>();
  private currentTimeouts = new Map<string, NodeJS.Timeout>();
  private readTtsOwners = new Map<string, { speechId: string; source: string; emitted: boolean }>();
  /** Queue items spoken by the pet ($(pet.talk), TTS-lane $(pet.ask)); the queue waits for the pet to finish. */
  private petTurns = new Map<string, { speechID: string; item: PetLaneItem; reason?: string }>();
  private playbackPositions = new Map<string, number>();
  private currentFiles = new Map<string, string>();
  private fileCleanupTimeouts = new Map<string, NodeJS.Timeout>();
  synthesisTimeoutMs = DEFAULT_TTS_SYNTHESIS_TIMEOUT_MS;
  private readonly services: Record<RuntimeTtsProvider, TtsServiceContract> = {
    piper: piperTtsService,
    fish: fishTtsService,
    kokoro: kokoroTtsService,
  };

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.cache = await getDragonflyClient("TtsQueueHandler:init");
    this.initialized = true;
  }

  async isOverlayConnected(channelID: string): Promise<boolean> {
    return this.hasOverlayConnection(channelID);
  }

  async getStatus(channelID: string): Promise<TtsStatusData> {
    if (!this.cache) await this.init();
    const currentSpeechID = this.activeSpeechIds.get(channelID);
    const studio = await studioTtsStatus(channelID, currentSpeechID);
    const sockets = getIO()?.of(`/speech/${channelID}`).sockets;
    const connected = await readTtsAvailable(channelID) || studio.connected || !!sockets && [...sockets.values()].some(socket => socket.connected && socket.data.ttsReady);
    return {
      connected,
      playing: studio.playing || !!sockets && [...sockets.values()].some(socket => socket.connected && socket.data.ttsReady)
        && this.dispatchedSpeechIds.has(channelID),
      preparing: !!currentSpeechID && !this.dispatchedSpeechIds.has(channelID),
      queueLength: await this.cache!.zCard(`twitch:${channelID}:tts:queue`) + studio.queueLength + (this.readHeads.get(channelID)?.phase === 'parked' ? 1 : 0),
    };
  }

  private async hasOverlayConnection(channelID: string): Promise<boolean> {
    // The Redis flag can outlive a socket (especially across an API restart).
    const sockets = getIO()?.of(`/speech/${channelID}`).sockets;
    const legacy = !!sockets && [...sockets.values()].some(socket => socket.connected && socket.data.ttsReady);
    if (this.readHeads.has(channelID) || hasReadTtsTurn(channelID) || await isReadTtsConfigured(channelID)) return legacy || await readTtsAvailable(channelID) || studioHasLiveSource(channelID, 'tts');
    return studioHasSource(channelID, 'tts') || legacy;
  }

  async handleOverlayDisconnected(channelID: string): Promise<void> {
    if (this.petTurns.has(channelID)) return; // The pet, not the speech overlay, plays this item.
    const owner = this.readTtsOwners.get(channelID);
    if (owner) {
      if (!owner.emitted || !owner.source.startsWith('legacy:')) return;
      const socketId = owner.source.slice(7);
      if (!getIO()?.of(`/speech/${channelID}`).sockets.get(socketId)?.connected) await this.handleSpeechEnded(channelID, owner.speechId, 'disconnected');
      return;
    }
    if (hasReadTtsTurn(channelID)) return;
    if (await this.hasOverlayConnection(channelID) || !this.processingChannels.has(channelID)) return;
    const activeID = this.activeSpeechIds.get(channelID);
    if (activeID) this.interruptedSpeechIds.set(channelID, activeID);
    const speechID = this.dispatchedSpeechIds.get(channelID);
    if (speechID) await this.handleSpeechEnded(channelID, speechID, 'disconnected');
    // During synthesis, retain the lock until the provider settles. The result
    // is discarded before dispatch, so reconnect cannot start a second producer.
  }

  async queueRequest(
    payload: TtsRequestPayload,
    settings: ChannelTtsSettingsData,
  ): Promise<QueueTtsResponse> {
    if (!this.cache) {
      await this.init();
    }

    const connected = await this.isOverlayConnected(payload.channelID);
    if (!connected) {
      return {
        error: true,
        message:
          "Speech overlay is not connected. Open the speech URL first and try again.",
        status: 409,
      };
    }

    const processingKey = `twitch:${payload.channelID}:tts:processing`;
    if (!this.readHeads.has(payload.channelID) && this.readHeads.size + this.headClaims.size >= MAX_READ_TTS_HEADS && await isReadTtsConfigured(payload.channelID))
      return { error: true, status: 429, message: 'TTS is waiting for playback capacity' };
    let processingActive = this.processingChannels.has(payload.channelID) || this.readHeads.has(payload.channelID);
    if (!processingActive) {
      const staleLock = await this.cache!.get(processingKey);
      if (staleLock) {
        await this.cache!.del(processingKey);
      }
    }

    const queueLength = await this.cache!.zCard(
      `twitch:${payload.channelID}:tts:queue`,
    );
    const totalPending = queueLength + (processingActive ? 1 : 0);

    if (totalPending >= settings.queue.maxItems) {
      return {
        error: true,
        message: "TTS queue is full for this channel",
        status: 429,
      };
    }

    const speechID = generateSpeechID();
    const usageRequestID = randomUUID();
    const queueItem: TtsQueueItem = {
      ...payload,
      observability: telemetryContext(),
      speechID,
      timestamp: Date.now(),
      piperFallbackVoice: settings.voices[payload.language],
      kokoroFallbackVoice: settings.voices.kokoroDefault,
      usageRequestID,
      usageEntryID: randomUUID(),
    };

    await enqueueTtsSession(this.cache!, payload.channelID, speechID, queueItem.timestamp, JSON.stringify(queueItem));

    try {
      trackAiOperation({
        requestId: usageRequestID,
        channelID: payload.channelID,
        category: "tts",
        operation: "synthesize",
        source: payload.source,
        lifecycle: "queued",
        requestedProvider: payload.provider,
        resourceType: "speech",
        resourceId: speechID,
      });
    } catch {
      // Analytics must never interrupt queueing.
    }

    if (!processingActive) {
      await this.cache!.set(processingKey, "pending", {
        EX: TTS_PROCESSING_TTL_SECONDS,
      });
      void this.processNext(payload.channelID);
    }

    return {
      error: false,
      message: "TTS queued successfully",
      status: 200,
      data: {
        speechID,
        queueLength: totalPending + 1,
        mode: queueItem.mode,
      },
    };
  }

  async processNext(channelID: string): Promise<void> {
    if (!this.cache) {
      await this.init();
    }

    const head = this.readHeads.get(channelID);
    if (head) { this.capacityWaiters.delete(channelID); this.wakeHead(channelID); return; }
    if (this.controls.has(channelID) || this.processingChannels.has(channelID) || this.dispatches.has(channelID)) return;
    // Consume a capacity wake only once this channel can actually take work.
    this.capacityWaiters.delete(channelID);
    this.processingChannels.add(channelID);

    let activeSpeechID: string | undefined;
    try {
      while (true) {
        if (this.controls.has(channelID)) {
          this.processingChannels.delete(channelID);
          return;
        }
        if (!await this.hasOverlayConnection(channelID) && !await this.petHeadReady(channelID)) {
          this.processingChannels.delete(channelID);
          this.interruptedSpeechIds.delete(channelID);
          return; // Preserve waiting requests until an overlay reconnects.
        }
        if (await isReadTtsConfigured(channelID)) {
          if (this.readHeads.size + this.headClaims.size >= MAX_READ_TTS_HEADS) {
            if (this.capacityWaiters.size < MAX_READ_TTS_HEADS) this.capacityWaiters.add(channelID);
            this.processingChannels.delete(channelID); return;
          }
          this.headClaims.add(channelID);
        }
        const next = await popTtsSession(this.cache!, channelID);
        if (!next?.value) {
          this.headClaims.delete(channelID);
          await this.cache!.del(`twitch:${channelID}:tts:processing`);
          this.processingChannels.delete(channelID);
          this.activeSpeechIds.delete(channelID);
          if ((await this.cache!.zCard(`twitch:${channelID}:tts:queue`)) > 0) {
            void this.processNext(channelID);
          }
          return;
        }

        const speechID = next.value;
        activeSpeechID = speechID;
        this.activeSpeechIds.set(channelID, speechID);

        const rawData = next.payload;
        if (!rawData) {
          this.headClaims.delete(channelID);
          continue;
        }

        let queueItem: TtsQueueItem;
        try {
          queueItem = JSON.parse(rawData) as TtsQueueItem;
        } catch {
          await this.cache!.del(`twitch:${channelID}:tts:queue:data:${speechID}`);
          this.headClaims.delete(channelID);
          continue;
        }

        if ((queueItem.queueSession !== undefined && queueItem.queueSession !== next.session) ||
            await this.cache!.get(`twitch:${channelID}:tts:session`) !== next.session) {
          await this.cleanupSpeech(channelID, speechID, true); continue;
        }
        // Legacy payloads acquire the popped snapshot, never a later marker.
        // If an async pre-provider requeue crosses stream end, its old tag fences it.
        queueItem.queueSession = next.session;

        if (this.controls.has(channelID) || this.interruptedSpeechIds.get(channelID) === speechID) {
          await this.cleanupSpeech(channelID, speechID, true); continue;
        }
        const petItem = petLaneItem(queueItem);
        if (petItem) {
          this.headClaims.delete(channelID); // Pet items never create a read-TTS head.
          if (await this.runPetItem(channelID, speechID, petItem)) return;
          continue;
        }
        if (!await this.hasOverlayConnection(channelID)) {
          if (await isReadTtsConfigured(channelID)) { await this.requeueUnspoken(channelID, queueItem); return; }
          await this.cleanupSpeech(channelID, speechID, true); continue;
        }

        if (await isReadTtsConfigured(channelID)) {
          if (!this.controls.has(channelID) && !this.adoptReadHead(channelID, queueItem, next.session)) {
            await this.deferForHeadCapacity(channelID, queueItem); return;
          }
          this.headClaims.delete(channelID);
        }
        const usageRequestID = queueItem.usageRequestID ||= randomUUID();
        const usageEntryID = queueItem.usageEntryID ||= randomUUID();
        queueItem.timestamp ||= Date.now();
        observe('queue_wait', 'tts', Math.max(0, Date.now() - queueItem.timestamp), 'ok', channelID);
        const requestedProvider = queueItem.provider;
        let fallbackReason: string | undefined;

        this.activeSpeechIds.set(channelID, speechID);
        await this.cache!.set(`twitch:${channelID}:tts:processing`, speechID, {
          EX: TTS_PROCESSING_TTL_SECONDS,
        });

        const reserved = await reserveReadTts({ channelId: channelID, speechId: speechID,
          signal: this.readHeads.get(channelID)?.cancellation.signal, retainHead: this.readHeads.has(channelID),
          cancelled: () => this.controls.has(channelID) || this.interruptedSpeechIds.get(channelID) === speechID || this.activeSpeechIds.get(channelID) !== speechID,
          ended: reason => this.handleSpeechEnded(channelID, speechID, reason) });
        if (!reserved && !this.controls.has(channelID) && this.interruptedSpeechIds.get(channelID) !== speechID) { await this.requeueUnspoken(channelID, queueItem); return; }
        if (!reserved || this.controls.has(channelID) || this.interruptedSpeechIds.get(channelID) === speechID) {
          await this.cleanupSpeech(channelID, speechID, true); continue;
        }
        // Read-TTS can turn on while the processing write is pending. The reservation
        // then holds a pet turn this item has no head for; adopt it before synthesis
        // so the generated file goes through the pet hand-off, not the ordinary path.
        if (!this.readHeads.has(channelID) && hasReadTtsTurn(channelID, speechID)) {
          if (!this.adoptReadHead(channelID, queueItem, next.session)) {
            await this.deferForHeadCapacity(channelID, queueItem); return;
          }
        }

        if (await this.cache!.get(`twitch:${channelID}:tts:session`) !== next.session) { await this.cleanupSpeech(channelID, speechID, true); continue; }

        if (hasReadTtsTurn(channelID, speechID) && !await this.hasOverlayConnection(channelID)) { await this.requeueUnspoken(channelID, queueItem); return; }

        let streamer: Awaited<ReturnType<typeof TwitchStreamers.getTwitchAccountById>> = null;
        try {
          streamer = await TwitchStreamers.getTwitchAccountById(channelID);
        } catch (error) {
          console.error("Failed to load TTS billing account; using free voice", { channelID, error });
        }
        let creditStatus: AiCreditStatus = "available";
        if (queueItem.provider !== "piper") {
          creditStatus = "unavailable";
          try {
            const exhausted = await isAiCreditsExhausted(channelID, this.cache!);
            if (exhausted) {
              creditStatus = "exhausted";
            } else if (streamer) {
              creditStatus = (await getAiCredits(streamer, channelID)).status;
            }
          } catch (creditError) {
            console.error("Failed to check AI credits before TTS synthesis; using Piper", {
              channelID,
              speechID,
              error:
                creditError instanceof Error
                  ? creditError.message
                  : String(creditError),
              timestamp: new Date().toISOString(),
            });
          }

          queueItem = resolveTtsForCreditStatus(queueItem, creditStatus, streamer?.plan_tier);
          if (queueItem.provider !== requestedProvider) {
            fallbackReason = creditStatus;
          }
        }

        if (!queueItem.text.trim()) {
          try {
            trackAiOperation({
              requestId: usageRequestID,
              channelID,
              category: "tts",
              operation: "synthesize",
              source: queueItem.source,
              lifecycle: "failed",
              requestedProvider,
              actualProvider: queueItem.provider,
              fallbackReason,
              errorCode: "empty_text_after_fallback",
              resourceType: "speech",
              resourceId: speechID,
              latencyMs: Date.now() - queueItem.timestamp,
            });
          } catch {
            // Analytics must never interrupt queue processing.
          }
          await this.cleanupSpeech(channelID, speechID, true);
          continue;
        }

        const synthesize = () => restoreContext(queueItem.observability, channelID, () => traced('queue_run', `tts.${queueItem.provider}`, async () => {
          const ttsService = this.services[queueItem.provider] || piperTtsService;
          try {
            return await promiseWithTimeout(
              ttsService.synthesize({
                channelID,
                speechID,
                mode: queueItem.mode,
                provider: queueItem.provider,
                model: queueItem.model,
                text: queueItem.text,
                language: queueItem.language,
                voice: queueItem.voice,
                cloneName: queueItem.cloneName,
                outputPath: "",
              }),
              queueItem.provider === "fish"
                ? Math.min(this.synthesisTimeoutMs, 45_000)
                : this.synthesisTimeoutMs,
              "TTS synthesis timed out",
            );
          } catch (synthesisError) {
            return {
              error: true,
              message:
                synthesisError instanceof Error
                  ? synthesisError.message
                  : String(synthesisError),
            };
          }
        }, channelID));

        let synthesisResult = await synthesize();
        if ((synthesisResult.error || !synthesisResult.outputPath || !synthesisResult.publicPath)
          && queueItem.provider !== "piper") {
          const failedProvider = queueItem.provider;
          const providerError = synthesisResult.message;
          queueItem = resolveTtsForCreditStatus(queueItem, "unavailable");
          fallbackReason = `${failedProvider}_synthesis_failed`;
          if (queueItem.text.trim()) {
            synthesisResult = await synthesize();
          }
          console.warn(`${failedProvider} TTS unavailable; used Piper fallback`, {
            channelID,
            speechID,
            providerError,
            piperError: synthesisResult.error ? synthesisResult.message : undefined,
          });
        }

        if (
          synthesisResult.error ||
          !synthesisResult.outputPath ||
          !synthesisResult.publicPath
        ) {
          console.error("TTS synthesis failed:", {
            channelID,
            speechID,
            error: synthesisResult.message,
            timestamp: new Date().toISOString(),
          });

          try {
            trackAiOperation({
              requestId: usageRequestID,
              channelID,
              category: "tts",
              operation: "synthesize",
              source: queueItem.source,
              lifecycle: "failed",
              requestedProvider,
              actualProvider: queueItem.provider,
              fallbackReason,
              errorCode: "synthesis_failed",
              resourceType: "speech",
              resourceId: speechID,
              latencyMs: Date.now() - queueItem.timestamp,
            });
          } catch {
            // Analytics must never interrupt queue processing.
          }

          await this.cleanupSpeech(channelID, speechID, true);
          continue;
        }

        // Track TTS usage for billing
        try {
          await trackTtsUsage({
            channelID,
            streamer: {
              polar_sh_customer_id: streamer?.polar_sh_customer_id,
              plan_tier: streamer?.plan_tier,
            },
            provider: queueItem.provider,
            // Kokoro and Piper count Unicode characters, including surrogate pairs once.
            characters: queueItem.provider === 'fish' ? queueItem.text.length : Array.from(queueItem.text).length,
            text: queueItem.text,
            usage: {
              entryId: usageEntryID,
              requestId: usageRequestID,
              source: queueItem.source,
              resourceType: "speech",
              resourceId: speechID,
            },
          });
        } catch (trackingError) {
          console.error("Failed to track TTS usage:", {
            channelID,
            speechID,
            error:
              trackingError instanceof Error
                ? trackingError.message
                : String(trackingError),
            timestamp: new Date().toISOString(),
          });
        }

        try {
          trackAiOperation({
            requestId: usageRequestID,
            channelID,
            category: "tts",
            operation: "synthesize",
            source: queueItem.source,
            lifecycle: "completed",
            requestedProvider,
            actualProvider: queueItem.provider,
            fallbackReason,
            resourceType: "speech",
            resourceId: speechID,
            latencyMs: Date.now() - queueItem.timestamp,
          });
        } catch {
          // Analytics must never interrupt queue processing.
        }

        this.currentFiles.set(
          `${channelID}:${speechID}`,
          synthesisResult.outputPath,
        );

        if (this.controls.has(channelID) || this.interruptedSpeechIds.get(channelID) === speechID || !hasReadTtsTurn(channelID, speechID) && !await this.hasOverlayConnection(channelID)) {
          await this.cleanupSpeech(channelID, speechID, true);
          continue;
        }

        const io = getIO();
        if (!io) {
          console.error("Socket.IO not initialized for TTS playback");
          await this.cleanupSpeech(channelID, speechID, true);
          continue;
        }

        const playbackTimeoutMs = await getTtsPlaybackTimeoutMs(synthesisResult.outputPath);
        // Duration inspection yields; a disconnect may have happened meanwhile.
        if (this.controls.has(channelID) || this.interruptedSpeechIds.get(channelID) === speechID || !hasReadTtsTurn(channelID, speechID) && !await this.hasOverlayConnection(channelID)) {
          await this.cleanupSpeech(channelID, speechID, true);
          continue;
        }
        const generatedHead = this.readHeads.get(channelID);
        if (generatedHead && generatedHead.item.speechID === speechID) {
          generatedHead.generated = { file: synthesisResult.outputPath, audioUrl: synthesisResult.publicPath,
            mime: synthesisResult.mimeType || 'audio/wav', text: queueItem.text, mode: queueItem.mode, timeoutMs: playbackTimeoutMs };
          generatedHead.phase = 'generated';
          await this.runHead(channelID, generatedHead); return;
        }
        this.dispatchedSpeechIds.set(channelID, speechID);
        this.armPlaybackTimeout(channelID, speechID, Math.max(240_000, playbackTimeoutMs + 120_000));
        observe('queue_total', 'tts.ready', Math.max(0, Date.now() - queueItem.timestamp), 'ok', channelID);
        console.log('TTS dispatched', { channelID, speechID, readyMs: Date.now() - queueItem.timestamp });

        this.armPlaybackTimeout(channelID, speechID, playbackTimeoutMs);
        const dispatch = publishStudioMedia(channelID, 'tts', { type: 'audio', title: queueItem.text, volume: 1 }, synthesisResult.outputPath, synthesisResult.mimeType || 'audio/wav', queueItem.text, 'twitch', speechID);
        this.dispatches.set(channelID, dispatch);
        try { await dispatch; }
        finally { if (this.dispatches.get(channelID) === dispatch) this.dispatches.delete(channelID); }
        // A control can arrive while Studio persists the media handoff. It waits
        // for that handoff and cancels its delivery; never emit stale audio after reset.
        if (this.controls.has(channelID) || this.dispatchedSpeechIds.get(channelID) !== speechID) return;
        io.of(`/speech/${channelID}`).emit("speech", {
          speechID,
          audioUrl: synthesisResult.publicPath,
          mimeType: synthesisResult.mimeType || "audio/wav",
          mode: queueItem.mode,
          text: queueItem.text,
        });
        if (![...io.of(`/speech/${channelID}`).sockets.values()].some(socket => socket.connected && socket.data.ttsReady)) {
          await this.handleSpeechEnded(channelID, speechID, 'retained-by-overlay-studio');
        }
        return;
      }
    } catch (error) {
      console.error("TTS queue failed:", {
        channelID,
        speechID: activeSpeechID,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      if (activeSpeechID) {
        // Best effort: the local lock below must always be dropped.
        const petTurn = this.petTurns.get(channelID);
        if (petTurn?.speechID === activeSpeechID) { this.petTurns.delete(channelID); await endPetLaneTurn(petTurn.item, 'failed').catch(() => {}); }
        await releaseReadTts(channelID, activeSpeechID).catch(() => {});
        await endStudioReadTts(channelID, activeSpeechID).catch(() => {});
        this.retireReadOwner(channelID, activeSpeechID);
      }
      const failedHead = this.readHeads.get(channelID);
      if (failedHead?.item.speechID === activeSpeechID) this.readHeads.delete(channelID);
      this.processingChannels.delete(channelID);
      this.activeSpeechIds.delete(channelID);
      try {
        await this.cache!.del(`twitch:${channelID}:tts:processing`);
        if (activeSpeechID) {
          await this.cache!.del(
            `twitch:${channelID}:tts:queue:data:${activeSpeechID}`,
          );
        }
      } catch {
        // Drop the in-memory lock even when Redis is unavailable.
      }
    } finally { const freedClaim = this.headClaims.delete(channelID); this.wakeCapacityWaiters(freedClaim); }
  }

  /** The next waiting item is a pet item; it needs the pet player, not a speech overlay. */
  private async petHeadReady(channelID: string): Promise<boolean> {
    const [speechID] = await this.cache!.zRange(`twitch:${channelID}:tts:queue`, 0, 0);
    if (!speechID) return false;
    const raw = await this.cache!.get(`twitch:${channelID}:tts:queue:data:${speechID}`);
    try { return !!raw && !!petLaneItem(JSON.parse(raw)); } catch { return false; }
  }
  /**
   * Hand one queue item to the pet and hold the queue until the pet request
   * ends. Returns false when the item did not start (the loop moves on).
   */
  private async runPetItem(channelID: string, speechID: string, item: PetLaneItem): Promise<boolean> {
    this.petTurns.set(channelID, { speechID, item });
    observe('queue_wait', 'tts.pet', 0, 'ok', channelID);
    await this.cache!.set(`twitch:${channelID}:tts:processing`, speechID, { EX: TTS_PROCESSING_TTL_SECONDS });
    const cancelled = () => this.controls.has(channelID) || this.interruptedSpeechIds.get(channelID) === speechID || this.activeSpeechIds.get(channelID) !== speechID;
    let turn: Awaited<ReturnType<typeof startPetLaneTurn>> = null;
    try { turn = await startPetLaneTurn({ channelId: channelID, speechId: speechID, item, cancelled }); }
    catch (error) { console.error('Pet TTS-queue turn failed to start', { channelID, speechID, error: error instanceof Error ? error.message : String(error) }); }
    if (!turn || cancelled()) { await this.cleanupSpeech(channelID, speechID, true); return false; }
    this.dispatchedSpeechIds.set(channelID, speechID);
    // Watchdog: pet phases are each capped at 60 s (reply, voice, audio) plus delivery slack.
    this.armPlaybackTimeout(channelID, speechID, 240_000);
    console.log('TTS queue handed item to pet', { channelID, speechID, operation: item.operation });
    void turn.done.then(reason => this.handleSpeechEnded(channelID, speechID, reason)).catch(error => {
      console.error('Pet TTS-queue turn cleanup failed', { channelID, speechID, error });
    });
    return true;
  }

  private adoptReadHead(channel: string, item: TtsQueueItem, session: string | null): boolean {
    const existing = this.readHeads.get(channel);
    if (existing) return existing.item.speechID === item.speechID;
    // Converting our existing claim costs no new capacity. Both configuration
    // observation boundaries use this synchronous check-and-insert operation.
    const occupied = this.readHeads.size + this.headClaims.size - Number(this.headClaims.has(channel));
    if (occupied >= MAX_READ_TTS_HEADS) return false;
    this.readHeads.set(channel, { item, session, epoch: 0, wakeVersion: 0,
      cancelled: false, phase: 'preparing', running: false, analysis: {}, cancellation: new AbortController() });
    this.headClaims.delete(channel);
    return true;
  }
  private async deferForHeadCapacity(channel: string, item: TtsQueueItem) {
    if (this.capacityWaiters.size < MAX_READ_TTS_HEADS) this.capacityWaiters.add(channel);
    await this.requeueUnspoken(channel, item, true);
  }
  private async requeueUnspoken(channelID: string, item: TtsQueueItem, capacityBlocked = false) {
    const cancelled = () => this.controls.has(channelID) || this.interruptedSpeechIds.get(channelID) === item.speechID;
    const operation = (async () => {
      await releaseReadTts(channelID, item.speechID);
      if (!cancelled()) {
        await this.cache!.set(`twitch:${channelID}:tts:queue:data:${item.speechID}`, JSON.stringify(item));
        await this.cache!.zAdd(`twitch:${channelID}:tts:queue`, { score: item.timestamp || Date.now(), value: item.speechID });
      }
      // Controls await this dispatch fence. A control crossing the Redis write
      // removes this exact item before its captured current identity is released.
      if (cancelled()) {
        await this.cache!.zRem(`twitch:${channelID}:tts:queue`, item.speechID);
        await this.cache!.del(`twitch:${channelID}:tts:queue:data:${item.speechID}`);
      }
      await this.cache!.del(`twitch:${channelID}:tts:processing`);
      // A control can cross the final Redis response even without a head. Its
      // dispatch fence still owns this captured ungenerated item until now.
      if (cancelled()) {
        await this.cache!.zRem(`twitch:${channelID}:tts:queue`, item.speechID);
        await this.cache!.del(`twitch:${channelID}:tts:queue:data:${item.speechID}`);
      }
      if (this.activeSpeechIds.get(channelID) === item.speechID) this.activeSpeechIds.delete(channelID);
      const head = this.readHeads.get(channelID);
      if (head?.item.speechID === item.speechID) this.readHeads.delete(channelID);
      this.processingChannels.delete(channelID);
    })();
    this.dispatches.set(channelID, operation);
    try { await operation; }
    finally { if (this.dispatches.get(channelID) === operation) this.dispatches.delete(channelID); }
    if (capacityBlocked) this.wakeCapacityWaiters();
    else if (await this.hasOverlayConnection(channelID)) void this.resumeIfIdle(channelID);
  }
  private disarmPlaybackTimeout(channel: string, speech: string) {
    const key = `${channel}:${speech}`; clearTimeout(this.currentTimeouts.get(key)); this.currentTimeouts.delete(key);
  }
  private wakeHead(channel: string) {
    const head = this.readHeads.get(channel);
    if (!head || head.cancelled || head.phase === 'emitted') return;
    head.wakeVersion++;
    if (head.running || !head.generated) return;
    this.headWakes.add(channel); this.scheduleHeadPump();
  }
  private wakeCapacityWaiters(discoverBacklog = false) {
    this.backlogWakeRequested ||= discoverBacklog;
    if (this.capacityWakeScheduled || (!this.capacityWaiters.size && !this.backlogWakeRequested) || this.readHeads.size + this.headClaims.size >= MAX_READ_TTS_HEADS) return;
    this.capacityWakeScheduled = true;
    setImmediate(() => {
      this.capacityWakeScheduled = false;
      const discoverBacklog = this.backlogWakeRequested; this.backlogWakeRequested = false;
      let available = Math.min(MAX_READ_TTS_PUMPS, MAX_READ_TTS_HEADS - this.readHeads.size - this.headClaims.size);
      // Select at execution time: a newly busy first waiter cannot spend the
      // only free slot or hide ready channels behind it. Busy waiters remain for
      // their existing control/dispatch completion wake, never a polling loop.
      for (const channel of [...this.capacityWaiters]) {
        if (this.readHeads.has(channel)) { this.capacityWaiters.delete(channel); continue; }
        if (this.controls.has(channel) || this.processingChannels.has(channel) || this.dispatches.has(channel)) continue;
        if (available <= 0) break;
        available--;
        void this.processNext(channel);
      }
      if (discoverBacklog) void this.recoverQueuedTts().catch(error => console.error('TTS backlog recovery failed', error));
    });
  }
  private queueOutputCursor(registry: number): Iterator<string | undefined> | undefined {
    if (registry === 0) return readTtsQueueChannels();
    if (registry === 1) return studioQueueChannels();
    const namespaces = getIO()?._nsps;
    if (!namespaces) return;
    return (function* () {
      const entries = namespaces.values();
      for (let remaining = namespaces.size; remaining > 0; remaining--) {
        const entry = entries.next(); if (entry.done) return;
        const namespace = entry.value;
        yield namespace.name.startsWith('/speech/') && namespace.sockets.size ? namespace.name.slice('/speech/'.length) : undefined;
      }
    })();
  }
  /** Redis membership owns accepted, ungenerated work. Local descriptors are
   * bounded execution caches, so registry hints also discover overflow/restart
   * backlog. No settings filter: disabled read-TTS can use normal overlays. */
  async recoverQueuedTts(): Promise<void> {
    if (this.recoveringQueues) return;
    this.recoveringQueues = true;
    try {
      if (!this.cache) await this.init();
      const seen = new Set<string>(), exhausted = new Set<number>();
      let probes = 0;
      for (let steps = 0; steps < 64 && probes < MAX_READ_TTS_PUMPS && exhausted.size < 3; steps++) {
        const registry = this.outputRegistry; this.outputRegistry = (registry + 1) % 3;
        if (exhausted.has(registry)) continue;
        const cursor = this.outputCursors[registry] ??= this.queueOutputCursor(registry);
        const entry = cursor?.next();
        if (!entry || entry.done) { this.outputCursors[registry] = undefined; exhausted.add(registry); continue; }
        const channel = entry.value;
        if (!channel || seen.has(channel)) continue;
        seen.add(channel);
        const busy = () => this.readHeads.has(channel) || this.headClaims.has(channel) || this.controls.has(channel)
          || this.processingChannels.has(channel) || this.dispatches.has(channel);
        if (busy()) continue;
        probes++;
        if (!await this.cache!.zCard(`twitch:${channel}:tts:queue`)) continue;
        if (busy() || !await this.hasOverlayConnection(channel) && !await this.petHeadReady(channel) || busy()) continue;
        // processNext revalidates output/session/control/capacity before a provider.
        // Never resumeIfIdle here: an empty/offline probe must not schedule itself.
        void this.processNext(channel);
      }
    } finally { this.recoveringQueues = false; }
  }
  async handleSessionEnded(channel: string, session: string) {
    const head = this.readHeads.get(channel);
    if (!head) {
      // A pre-dequeue capacity waiter has no head for session recovery to visit.
      // Retire an emptied backlog on this existing boundary notification.
      if (this.capacityWaiters.has(channel)) await this.resumeIfIdle(channel);
      return;
    }
    if (head.session === session) return;
    // control captures and cancels the exact old identity synchronously.
    await this.control(channel, 'skip');
  }
  async reconcileReadTtsSessions() {
    const channels = [...this.readHeads.keys()];
    const batch = channels.length ? Array.from({ length: Math.min(64, channels.length) }, (_, i) => channels[(this.sessionCursor + i) % channels.length]) : [];
    this.sessionCursor = channels.length ? (this.sessionCursor + batch.length) % channels.length : 0;
    for (const channel of batch) {
      const session = await this.cache!.get(`twitch:${channel}:tts:session`);
      if (session !== this.readHeads.get(channel)?.session) await this.handleSessionEnded(channel, session ?? '');
    }
  }
  private scheduleHeadPump() {
    if (this.pumpScheduled || !this.headWakes.size || this.activePumps >= MAX_READ_TTS_PUMPS) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      while (this.headWakes.size && this.activePumps < MAX_READ_TTS_PUMPS) {
        const channel = this.headWakes.values().next().value!; this.headWakes.delete(channel);
        const head = this.readHeads.get(channel); if (!head || head.running || head.cancelled || head.phase === 'emitted') continue;
        void this.runHead(channel, head).catch(error => { console.error('TTS generated handoff failed', error); });
      }
    });
  }
  private async parkHead(channel: string, head: ReadTtsHead) {
    if (this.readHeads.get(channel) !== head || head.phase === 'emitted') return;
    head.phase = 'parked'; head.epoch++;
    this.dispatchedSpeechIds.delete(channel);
    this.disarmPlaybackTimeout(channel, head.item.speechID);
    if (this.readTtsOwners.get(channel)?.speechId === head.item.speechID) this.readTtsOwners.delete(channel);
    await endStudioReadTts(channel, head.item.speechID);
    await parkReadTts(channel, head.item.speechID);
    if (await this.cache!.get(`twitch:${channel}:tts:processing`) === head.item.speechID) await this.cache!.del(`twitch:${channel}:tts:processing`);
    // Identity/file stay owned by this normal-queue head. No timer or reservation while parked.
    this.processingChannels.delete(channel);
  }
  private async runHead(channel: string, head: ReadTtsHead) {
    if (!head.generated || head.running || head.cancelled || this.controls.has(channel) || this.readHeads.get(channel) !== head) return;
    if (this.activePumps >= MAX_READ_TTS_PUMPS) {
      head.running = true;
      try { await this.parkHead(channel, head); }
      finally { head.running = false; if (!head.cancelled && this.readHeads.get(channel) === head) this.headWakes.add(channel); this.scheduleHeadPump(); }
      return;
    }
    this.activePumps++;
    head.running = true; head.phase = 'generated'; this.processingChannels.add(channel);
    const version = head.wakeVersion, epoch = ++head.epoch, speech = head.item.speechID, input = head.generated;
    const phase = (): ReadTtsHead['phase'] => head.phase;
    const current = () => this.readHeads.get(channel) === head && !head.cancelled && head.epoch === epoch && !this.controls.has(channel);
    const operation = (async () => {
      if (await this.cache!.get(`twitch:${channel}:tts:session`) !== head.session) { head.cancelled = true; await this.finishHead(channel, head, 'stream_ended'); return; }
      if (!current()) return;
      if (!await this.hasOverlayConnection(channel)) { await this.parkHead(channel, head); return; }
      if (!current()) return;
      await this.cache!.set(`twitch:${channel}:tts:processing`, speech, { EX: TTS_PROCESSING_TTL_SECONDS });
      if (!current()) return;
      this.dispatchedSpeechIds.set(channel, speech);
      const holdMs = Math.max(240_000, input.timeoutMs + 180_000);
      let route = await prepareReadTts({ channelId: channel, speechId: speech, file: input.file, mime: input.mime, text: input.text,
        holdMs, retainHead: true, attemptId: `${epoch}`, analysis: head.analysis, signal: head.cancellation.signal, cancelled: () => !current(), ended: reason => this.handleSpeechEnded(channel, speech, reason) });
      if (!current()) return;
      if (!route || route.audio === 'waiting' || route.audio === 'cancelled') { await this.parkHead(channel, head); return; }
      if (!await protectReadTtsTurn(channel, speech, holdMs) || !current()) { await this.parkHead(channel, head); return; }
      if (await this.cache!.get(`twitch:${channel}:tts:session`) !== head.session) { head.cancelled = true; await this.finishHead(channel, head, 'stream_ended'); return; }
      const owner = { speechId: speech, source: 'pet', emitted: false };
      this.readTtsOwners.set(channel, owner);
      const markEmission = () => {
        if (!current() || this.readTtsOwners.get(channel) !== owner || !readTtsTurnCurrent(channel, speech, input.timeoutMs + 60_000)) return false;
        owner.emitted = true; head.phase = 'emitted'; this.armPlaybackTimeout(channel, speech, input.timeoutMs); return true;
      };
      if (route.audio === 'pet') {
        const emitted = route.emit ? await route.emit(markEmission) : markEmission();
        if (!current()) return;
        if (emitted) { await publishStudioReadTts(channel, { speechID: speech, durationMs: route.durationMs, text: input.text, legacy: false, cancelled: () => !current() }); return; }
        if (owner.emitted) return;
        route = route.fallback ? await route.fallback() : { audio: 'overlay', durationMs: route.durationMs };
        if (!current()) return;
      }
      const legacy = [...getIO()?.of(`/speech/${channel}`).sockets.values() ?? []]
        .filter(socket => socket.connected && socket.data.ttsReady).sort((a,b) => a.id.localeCompare(b.id))[0];
      if (!legacy && !studioHasLiveSource(channel, 'tts')) { await this.parkHead(channel, head); return; }
      owner.source = legacy ? `legacy:${legacy.id}` : 'studio';
      const outcome = await publishStudioReadTts(channel, { speechID: speech, durationMs: route.durationMs || 60_000, text: input.text,
        legacy: !!legacy, cancelled: () => !current(), ...(!legacy ? { beforeEmit: markEmission } : {}), file: input.file, mime: input.mime });
      if (!current()) return;
      if (legacy?.connected && legacy.data.ttsReady && markEmission()) {
        legacy.emit('speech', { speechID: speech, audioUrl: input.audioUrl, mimeType: input.mime, mode: input.mode, text: input.text }); return;
      }
      if (owner.emitted) return;
      if (!legacy && outcome === 'emitted' && markEmission()) return;
      await this.parkHead(channel, head);
    })();
    this.dispatches.set(channel, operation);
    try { await operation; }
    catch (error) {
      if (phase() === 'emitted') await this.handleSpeechEnded(channel, speech, 'outcome_unknown');
      else if (current()) await this.parkHead(channel, head);
      console.error('TTS handoff ended or parked after failure', error);
    } finally {
      if (this.dispatches.get(channel) === operation) this.dispatches.delete(channel);
      head.running = false;
      if (phase() !== 'emitted' && (!this.activeSpeechIds.has(channel) || this.activeSpeechIds.get(channel) === speech) && (!this.readHeads.has(channel) || this.readHeads.get(channel) === head)) this.processingChannels.delete(channel);
      if (this.readHeads.get(channel) === head && !head.cancelled && phase() === 'parked' && version !== head.wakeVersion) this.wakeHead(channel);
      this.activePumps--; this.scheduleHeadPump();
      if (!this.readHeads.has(channel) && !this.controls.has(channel)) setImmediate(() => { void this.processNext(channel); });
    }
  }
  private finishHead(channel: string, head: ReadTtsHead, reason: string): Promise<void> {
    if (head.completion) return head.completion;
    if (this.readHeads.get(channel) !== head) return Promise.resolve();
    // Claim the entire terminal operation before any await, including Studio
    // teardown. Controls and natural/private completion join this same promise.
    // It cannot wait on dispatch: dispatch may itself be reporting its terminal.
    const speech = head.item.speechID;
    head.cancelled = true; head.epoch++; head.phase = 'terminal'; this.headWakes.delete(channel);
    head.cancellation.abort(); this.retireReadOwner(channel, speech);
    if (this.dispatchedSpeechIds.get(channel) === speech) this.dispatchedSpeechIds.delete(channel);
    const completion = Promise.resolve().then(async () => {
      // Each step runs even if an earlier one fails, so a failed external call
      // can never leave this cancelled head holding the channel.
      let failure: unknown;
      try { await endStudioReadTts(channel, speech); } catch (error) { failure = error; }
      try { await this.cleanupSpeech(channel, speech); } catch (error) { failure ??= error; }
      if (!head.running && !this.controls.has(channel)) void this.processNext(channel);
      if (failure) throw failure;
    }).catch(error => {
      // An unsuccessful terminal operation may be retried on this same head;
      // successful completion stays attached, fencing even late old callbacks.
      if (head.completion === completion) head.completion = undefined;
      throw error;
    });
    head.completion = completion;
    return completion;
  }

  private armPlaybackTimeout(channelID: string, speechID: string, delay: number): void {
    const key = `${channelID}:${speechID}`;
    clearTimeout(this.currentTimeouts.get(key));
    this.currentTimeouts.set(key, setTimeout(() => {
      console.warn('TTS overlay playback timed out', { channelID, speechID, delay });
      this.handleSpeechEnded(channelID, speechID, 'timeout').catch(error => { console.error('TTS timeout cleanup failed', { channelID, speechID, error }); });
    }, delay));
  }

  handleSpeechPlayback(channelID: string, data: { speechID?: string; phase?: string; position?: number }, source?: string): void {
    if (!this.acceptsOverlayReport(channelID, data?.speechID, source)) return;
    if (!data?.speechID || this.dispatchedSpeechIds.get(channelID) !== data.speechID) return;
    const key = `${channelID}:${data.speechID}`;
    const previous = this.playbackPositions.get(key);
    const position = data.position;
    // Only the first receipt or advancing media time extends the deadline.
    // A stuck client sending heartbeats must not hold the queue forever.
    void reportReadTts(channelID, data.speechID, data.phase || '', Number(position)).catch(() => {});
    if (previous === undefined || (Number.isFinite(position) && position! > previous + 0.05)) {
      this.playbackPositions.set(key, Number.isFinite(position) ? Math.max(0, position!) : 0);
      this.armPlaybackTimeout(channelID, data.speechID, 60_000);
      if (previous === undefined || previous === 0) {
        console.log('TTS playback', { channelID, speechID: data.speechID, phase: data.phase, position });
      }
    }
  }

  private acceptsOverlayReport(channelID: string, speechID?: string, source?: string): boolean {
    const owner = this.readTtsOwners.get(channelID);
    return !owner || owner.emitted && owner.speechId === speechID && (owner.source === 'studio' ? !!source?.startsWith('studio:') : owner.source === source);
  }
  private retireReadOwner(channel: string, speech: string) {
    const owner = this.readTtsOwners.get(channel);
    if (!owner || owner.speechId !== speech) return;
    this.readTtsOwners.delete(channel);
    if (owner.source.startsWith('legacy:')) getIO()?.of(`/speech/${channel}`).sockets.get(owner.source.slice(7))?.emit('speech-reset');
  }
  async handleOverlayEnded(channelID: string, speechID: string | undefined, reason: string | undefined, source: string) {
    if (this.acceptsOverlayReport(channelID, speechID, source)) await this.handleSpeechEnded(channelID, speechID, reason);
  }
  async handleSpeechEnded(channelID: string, speechID?: string, reason = 'ended'): Promise<void> {
    if (!speechID || this.dispatchedSpeechIds.get(channelID) !== speechID) return;
    // Claim completion before the first await. Concurrent duplicate events must
    // not both clean up and release a newer item after Redis yields.
    const head = this.readHeads.get(channelID);
    if (head?.item.speechID === speechID) {
      await this.finishHead(channelID, head, reason);
      return;
    }
    this.dispatchedSpeechIds.delete(channelID);
    this.activeSpeechIds.delete(channelID);
    const petTurn = this.petTurns.get(channelID);
    if (petTurn?.speechID === speechID) petTurn.reason = reason;
    const owner = this.readTtsOwners.get(channelID);
    if (owner?.speechId === speechID) {
      this.readTtsOwners.delete(channelID);
      if (owner.source.startsWith('legacy:')) getIO()?.of(`/speech/${channelID}`).sockets.get(owner.source.slice(7))?.emit('speech-reset');
    }
    await endStudioReadTts(channelID, speechID);
    console.log('TTS finished', { channelID, speechID, reason });
    await this.cleanupSpeech(channelID, speechID);
    if (!head?.running) void this.processNext(channelID);
  }

  /** Serialize controls while retaining the synthesis producer lock until it settles. */
  async control(channelID: string, action: 'skip' | 'clear' | 'refresh'): Promise<void> {
    const controlledHead = this.readHeads.get(channelID);
    const controlledSpeech = controlledHead?.item.speechID ?? this.activeSpeechIds.get(channelID);
    if (controlledHead) { controlledHead.cancelled = true; controlledHead.epoch++; controlledHead.cancellation.abort(); }
    if (controlledSpeech) this.interruptedSpeechIds.set(channelID, controlledSpeech);
    const previous = this.controls.get(channelID) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      if (!this.cache) await this.init();
      await this.dispatches.get(channelID)?.catch(() => {});
      const speechID = controlledSpeech;
      if (speechID) this.interruptedSpeechIds.set(channelID, speechID);
      const io = getIO();
      const namespace = io?.of(`/speech/${channelID}`);
      // Clear/reset also cancels any stale browser-side backlog. Completion is
      // claimed on the server; late acknowledgements cannot finish the next item.
      namespace?.emit('speech-reset');
      if (action === 'clear') {
        const key = `twitch:${channelID}:tts:queue`;
        const waiting = await this.cache!.zRange(key, 0, -1);
        if (waiting.length) {
          const transaction = this.cache!.multi().zRem(key, waiting);
          for (const id of waiting) transaction.del(`twitch:${channelID}:tts:queue:data:${id}`);
          await transaction.exec();
        }
      }
      await controlStudioTts(channelID, action);
      if (action === 'refresh') {
        for (const socket of namespace?.sockets.values() ?? []) {
          socket.data.ttsReady = false;
          socket.conn.close();
        }
      }
      if (speechID) {
        if (controlledHead) await this.cache!.zRem(`twitch:${channelID}:tts:queue`, speechID);
        if (controlledHead?.generated && this.readHeads.get(channelID) === controlledHead) await this.finishHead(channelID, controlledHead, action);
        else if (this.dispatchedSpeechIds.get(channelID) === speechID) await this.handleSpeechEnded(channelID, speechID, action);
        else if (!this.processingChannels.has(channelID)) await this.cache!.del(`twitch:${channelID}:tts:queue:data:${speechID}`);
      }
    });
    this.controls.set(channelID, pending);
    try { await pending; }
    finally {
      if (this.controls.get(channelID) === pending) {
        this.controls.delete(channelID);
        try { await this.resumeIfIdle(channelID); }
        finally { this.wakeCapacityWaiters(); }
      }
    }
  }

  async releaseStaleProcessingLocks(): Promise<void> {
    if (!this.cache) {
      await this.init();
    }

    const keys = await this.cache!.keys("twitch:*:tts:processing");
    for (const key of keys) {
      const channelID = key.split(":")[1];
      if (!channelID || this.processingChannels.has(channelID)) {
        continue;
      }
      await this.cache!.del(key);
    }
  }

  async resumeIfIdle(channelID: string): Promise<void> {
    if (!this.cache) {
      await this.init();
    }
    if (this.readHeads.has(channelID)) { this.capacityWaiters.delete(channelID); this.wakeHead(channelID); return; }
    if (this.controls.has(channelID) || this.processingChannels.has(channelID) || this.dispatches.has(channelID)) return;

    const processingKey = `twitch:${channelID}:tts:processing`;
    const staleLock = await this.cache!.get(processingKey);
    if (this.processingChannels.has(channelID)) {
      return;
    }
    if (staleLock) {
      await this.cache!.del(processingKey);
    }
    if (this.processingChannels.has(channelID)) {
      return;
    }

    const queueLength = await this.cache!.zCard(`twitch:${channelID}:tts:queue`);
    if (queueLength > 0) {
      void this.processNext(channelID);
    } else if (!this.controls.has(channelID) && !this.processingChannels.has(channelID) && !this.dispatches.has(channelID)) {
      this.capacityWaiters.delete(channelID);
      this.wakeCapacityWaiters();
    }
  }

  async cleanupSpeech(channelID: string, speechID: string, keepProcessing = false): Promise<void> {
    if (!this.cache) {
      await this.init();
    }

    const head = this.readHeads.get(channelID);
    if (head?.item.speechID === speechID) { head.cancelled = true; head.epoch++; head.phase = 'terminal'; head.cancellation.abort(); this.headWakes.delete(channelID); }
    this.retireReadOwner(channelID, speechID);
    // External failures are reported after local cleanup, never instead of it.
    let failure: unknown;
    const petTurn = this.petTurns.get(channelID);
    if (petTurn?.speechID === speechID) {
      this.petTurns.delete(channelID);
      // Skip/clear/timeout stop the pet; a pet that already finished is left untouched.
      try { await endPetLaneTurn(petTurn.item, petTurn.reason ?? 'skipped'); } catch (error) { failure = error; }
    }
    try { await releaseReadTts(channelID, speechID); } catch (error) { failure ??= error; }
    const timeoutKey = `${channelID}:${speechID}`;
    if (!this.controls.has(channelID) && this.interruptedSpeechIds.get(channelID) === speechID) this.interruptedSpeechIds.delete(channelID);
    if (this.dispatchedSpeechIds.get(channelID) === speechID) this.dispatchedSpeechIds.delete(channelID);
    this.playbackPositions.delete(timeoutKey);
    const timeout = this.currentTimeouts.get(timeoutKey);
    if (timeout) {
      clearTimeout(timeout);
      this.currentTimeouts.delete(timeoutKey);
    }

    const outputPath = this.currentFiles.get(timeoutKey);
    if (outputPath) {
      this.scheduleFileCleanup(timeoutKey, outputPath);
    }

    try {
      await this.cache!.del(`twitch:${channelID}:tts:processing`);
      await this.cache!.del(`twitch:${channelID}:tts:queue:data:${speechID}`);
    } catch (error) { failure ??= error; } // The processing key also expires by TTL.
    if (head?.item.speechID === speechID && this.readHeads.get(channelID) === head) this.readHeads.delete(channelID);
    this.wakeCapacityWaiters(true);
    if (!keepProcessing) this.processingChannels.delete(channelID);
    if (this.activeSpeechIds.get(channelID) === speechID) {
      this.activeSpeechIds.delete(channelID);
    }
    if (failure) throw failure;
  }

  async cleanupChannel(channelID: string): Promise<void> {
    if (!this.cache) {
      await this.init();
    }

    if (this.readHeads.has(channelID)) await this.control(channelID, 'clear');

    const queueKeys = await this.cache!.keys(
      `twitch:${channelID}:tts:queue:data:*`,
    );
    const currentSpeechID = await this.cache!.get(
      `twitch:${channelID}:tts:processing`,
    );

    for (const key of queueKeys) {
      await this.cache!.del(key);
    }

    if (currentSpeechID) {
      await this.cleanupSpeech(channelID, currentSpeechID);
    }

    await this.cache!.del(`twitch:${channelID}:tts:queue`);
    await this.cache!.del(`twitch:${channelID}:tts:connected`);
    await this.cache!.del(`twitch:${channelID}:tts:processing`);

    const channelDir = path.join(PIPER_PUBLIC_SPEECH_DIR, channelID);
    for (const [fileKey, filePath] of this.currentFiles.entries()) {
      if (!fileKey.startsWith(`${channelID}:`)) {
        continue;
      }

      const cleanupTimeout = this.fileCleanupTimeouts.get(fileKey);
      if (cleanupTimeout) {
        clearTimeout(cleanupTimeout);
        this.fileCleanupTimeouts.delete(fileKey);
      }

      try {
        await fs.unlink(filePath);
      } catch {
        // Ignore missing temp files during cleanup.
      }

      this.currentFiles.delete(fileKey);
    }

    try {
      await fs.rm(channelDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures on missing directories.
    }

    this.processingChannels.delete(channelID);
    this.activeSpeechIds.delete(channelID);
    this.capacityWaiters.delete(channelID);
    this.wakeCapacityWaiters(true);
  }

  private scheduleFileCleanup(fileKey: string, outputPath: string): void {
    const existingTimeout = this.fileCleanupTimeouts.get(fileKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const cleanupTimeout = setTimeout(() => {
      void fs
        .unlink(outputPath)
        .catch(() => {
          // Ignore missing temp files during delayed cleanup.
        })
        .finally(() => {
          this.currentFiles.delete(fileKey);
          this.fileCleanupTimeouts.delete(fileKey);
        });
    }, 120000);

    this.fileCleanupTimeouts.set(fileKey, cleanupTimeout);
  }
}

const ttsQueueHandler = new TtsQueueHandler();

export { ttsQueueHandler };
