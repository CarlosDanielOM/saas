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
import { trackAiOperation } from "../utils/posthog_events.js";

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
  speechID: string;
  timestamp: number;
  piperFallbackVoice?: string;
  usageRequestID?: string;
  usageEntryID?: string;
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

class TtsQueueHandler {
  private cache: RedisClientType | null = null;
  private initialized = false;
  private processingChannels = new Set<string>();
  private currentTimeouts = new Map<string, NodeJS.Timeout>();
  private currentFiles = new Map<string, string>();
  private fileCleanupTimeouts = new Map<string, NodeJS.Timeout>();
  synthesisTimeoutMs = DEFAULT_TTS_SYNTHESIS_TIMEOUT_MS;
  private readonly services: Record<RuntimeTtsProvider, TtsServiceContract> = {
    piper: piperTtsService,
    fish: fishTtsService,
  };

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.cache = await getDragonflyClient("TtsQueueHandler:init");
    this.initialized = true;
  }

  async isOverlayConnected(channelID: string): Promise<boolean> {
    if (!this.cache) {
      await this.init();
    }

    const connected = await this.cache!.exists(
      `twitch:${channelID}:tts:connected`,
    );
    return connected === 1;
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
    let processingActive = this.processingChannels.has(payload.channelID);
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
      speechID,
      timestamp: Date.now(),
      piperFallbackVoice: settings.voices[payload.language],
      usageRequestID,
      usageEntryID: randomUUID(),
    };

    await this.cache!.set(
      `twitch:${payload.channelID}:tts:queue:data:${speechID}`,
      JSON.stringify(queueItem),
    );
    await this.cache!.zAdd(`twitch:${payload.channelID}:tts:queue`, {
      score: queueItem.timestamp,
      value: speechID,
    });

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

    if (this.processingChannels.has(channelID)) {
      return;
    }
    this.processingChannels.add(channelID);

    let activeSpeechID: string | undefined;
    try {
      while (true) {
        const next = await this.cache!.zPopMin(`twitch:${channelID}:tts:queue`);
        if (!next?.value) {
          this.processingChannels.delete(channelID);
          await this.cache!.del(`twitch:${channelID}:tts:processing`);
          if ((await this.cache!.zCard(`twitch:${channelID}:tts:queue`)) > 0) {
            void this.processNext(channelID);
          }
          return;
        }

        const speechID = next.value;
        activeSpeechID = speechID;

        const rawData = await this.cache!.get(
          `twitch:${channelID}:tts:queue:data:${speechID}`,
        );
        if (!rawData) {
          continue;
        }

        let queueItem: TtsQueueItem;
        try {
          queueItem = JSON.parse(rawData) as TtsQueueItem;
        } catch {
          await this.cache!.del(`twitch:${channelID}:tts:queue:data:${speechID}`);
          continue;
        }

        const usageRequestID = queueItem.usageRequestID ||= randomUUID();
        const usageEntryID = queueItem.usageEntryID ||= randomUUID();
        queueItem.timestamp ||= Date.now();
        const requestedProvider = queueItem.provider;
        let fallbackReason: string | undefined;

        await this.cache!.set(`twitch:${channelID}:tts:processing`, speechID, {
          EX: TTS_PROCESSING_TTL_SECONDS,
        });

        let streamer: Awaited<ReturnType<typeof TwitchStreamers.getTwitchAccountById>> = null;
        try {
          streamer = await TwitchStreamers.getTwitchAccountById(channelID);
        } catch (error) {
          console.error("Failed to load TTS billing account; using free voice", { channelID, error });
        }
        let creditStatus: AiCreditStatus = "available";
        if (queueItem.provider === "fish") {
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

          queueItem = resolveTtsForCreditStatus(queueItem, creditStatus);
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
          await this.cleanupSpeech(channelID, speechID);
          this.processingChannels.add(channelID);
          continue;
        }

        const synthesize = async () => {
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
        };

        let synthesisResult = await synthesize();
        if ((synthesisResult.error || !synthesisResult.outputPath || !synthesisResult.publicPath)
          && queueItem.provider === "fish") {
          const fishError = synthesisResult.message;
          queueItem = resolveTtsForCreditStatus(queueItem, "unavailable");
          fallbackReason = "fish_synthesis_failed";
          if (queueItem.text.trim()) {
            synthesisResult = await synthesize();
          }
          console.warn("Fish TTS unavailable; used Piper fallback", {
            channelID,
            speechID,
            fishError,
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

          await this.cleanupSpeech(channelID, speechID);
          this.processingChannels.add(channelID);
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
            characters: queueItem.text.length,
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

        const io = getIO();
        if (!io) {
          console.error("Socket.IO not initialized for TTS playback");
          await this.cleanupSpeech(channelID, speechID);
          this.processingChannels.add(channelID);
          continue;
        }

        const timeout = setTimeout(() => {
          void this.handleSpeechEnded(channelID, speechID);
        }, 30000);

        this.currentTimeouts.set(`${channelID}:${speechID}`, timeout);

        io.of(`/speech/${channelID}`).emit("speech", {
          speechID,
          audioUrl: synthesisResult.publicPath,
          mimeType: synthesisResult.mimeType || "audio/wav",
          mode: queueItem.mode,
          text: queueItem.text,
        });
        return;
      }
    } catch (error) {
      console.error("TTS queue failed:", {
        channelID,
        speechID: activeSpeechID,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      this.processingChannels.delete(channelID);
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
    }
  }

  async handleSpeechEnded(channelID: string, speechID?: string): Promise<void> {
    if (!this.cache) {
      await this.init();
    }

    const storedSpeechID = await this.cache!.get(
      `twitch:${channelID}:tts:processing`,
    );
    const currentSpeechID =
      speechID ||
      (storedSpeechID && storedSpeechID !== "pending" ? storedSpeechID : undefined);
    if (!currentSpeechID) {
      this.processingChannels.delete(channelID);
      await this.cache!.del(`twitch:${channelID}:tts:processing`);
      void this.processNext(channelID);
      return;
    }

    await this.cleanupSpeech(channelID, currentSpeechID);
    void this.processNext(channelID);
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
    if (this.processingChannels.has(channelID)) {
      return;
    }

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
    }
  }

  async cleanupSpeech(channelID: string, speechID: string): Promise<void> {
    if (!this.cache) {
      await this.init();
    }

    const timeoutKey = `${channelID}:${speechID}`;
    const timeout = this.currentTimeouts.get(timeoutKey);
    if (timeout) {
      clearTimeout(timeout);
      this.currentTimeouts.delete(timeoutKey);
    }

    const outputPath = this.currentFiles.get(timeoutKey);
    if (outputPath) {
      this.scheduleFileCleanup(timeoutKey, outputPath);
    }

    await this.cache!.del(`twitch:${channelID}:tts:processing`);
    await this.cache!.del(`twitch:${channelID}:tts:queue:data:${speechID}`);
    this.processingChannels.delete(channelID);
  }

  async cleanupChannel(channelID: string): Promise<void> {
    if (!this.cache) {
      await this.init();
    }

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
