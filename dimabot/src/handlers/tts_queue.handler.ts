import { readTtsQueueChannels, readTtsAvailable, parkReadTts, reserveReadTts, prepareReadTts, releaseReadTts, reportReadTts, isReadTtsConfigured, hasReadTtsTurn, readTtsTurnCurrent, protectReadTtsTurn, type ReadTtsRoute } from '../pets/tts_bridge.js';
import { prepareSpeechActivity, startSpeechActivity, finishSpeechActivity, extendSpeechActivity, retireMatchingSpeechActivity, confirmRetiredSpeechActivity, type SpeechActivityHandle } from '../desktop_ai/activity.js';
import { studioQueueChannels, publishStudioReadTts, endStudioReadTts } from '../overlays/bridge.js';
import type { TtsStatusData } from '../utils/tts/tts_status.js';
import { telemetryContext, restoreContext, traced, observe, type TraceContext } from '../utils/observability/telemetry.js';
import { studioHasSource, studioHasLiveSource, controlStudioTts, studioTtsStatus, publishWidgetEvent } from '../overlays/bridge.js';
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
import { recordActivity } from "../utils/activity_log.js";
import { enqueueTtsSession, popTtsSession } from '../utils/tts/tts_session.util.js';
import { petLaneItem, startPetLaneTurn, endPetLaneTurn, type PetLaneItem } from '../pets/tts_lane.js';
import { rankOutputs, recordOutputFailure, recordOutputSuccess, summarizeOutputs, OUTPUT_FAILURES, type RankableOutput, type SpeechOutputInfo } from './tts_outputs.js';

const TTS_PROCESSING_TTL_SECONDS = 150;
const DEFAULT_TTS_SYNTHESIS_TIMEOUT_MS = 45_000;

/** Owner source while a message plays on several speech pages at once. */
const EVERY_OUTPUT = 'legacy:all';
/** A message tries at most this many speech pages before it gives up. */
const MAX_OUTPUTS_PER_MESSAGE = 3;
/** Current pages say when the audio is downloaded (`ready`); playback should start right after. */
const START_AFTER_READY_MS = 8_000;
/** Older pages never say `ready`: allow their whole download budget (2 x 20 s) before assuming they are stuck. */
const START_AFTER_SEND_MS = 45_000;
/** How long a current page gets to confirm it stopped a message before it moves elsewhere. */
const CANCEL_ACK_MS = 2_000;

/** What a speech page receives for one message. */
interface SpeechPayload { speechID: string; audioUrl: string; mimeType: string; mode: TtsMode; text: string }
/** One speech page a message was sent to. */
interface DeliveryMember {
  source: string; socketId: string; pageId?: string;
  /** It reported playing (or a position past the start): someone may have heard it. */
  started: boolean;
  /** It is finished with this message (ended, failed, cancelled, disconnected or moved away). */
  done: boolean;
  /** We know it is silent: it said so, or it was stopped before it ever started. */
  stopped: boolean;
  reported: boolean; position: number; readyAt?: number; timers: NodeJS.Timeout[];
}
/** A normal TTS message going out to speech pages (`/speech/<channel>`). */
interface LegacyDelivery {
  channel: string; speechID: string; payload: SpeechPayload; every: boolean;
  members: Map<string, DeliveryMember>;
  /** One-page mode: the page that owns playback now. */
  active?: string;
  /** First page sent to; drives the pet's read-TTS timeline until a page starts. */
  primary: string;
  /** "Every page" mode: the first page that started; its reports drive the read-TTS timeline. */
  clock?: string;
  /** Socket ids open when the message went out. Older pages that connect later may be a page that already saw it. */
  eligible: Set<string>;
  timeoutMs: number;
  /** A move to another page is being prepared; other endings wait for it. */
  moving: boolean;
  heard: boolean; normalEnd: boolean; finished: boolean;
}
type SpeechSocket = RankableOutput & {
  data: { ttsReady?: boolean; ttsOutput?: SpeechOutputInfo };
  emit(event: string, ...args: unknown[]): boolean;
  timeout(ms: number): { emitWithAck(event: string, ...args: unknown[]): Promise<unknown> };
};

/**
 * The source a request is reported under, and the receipt's own label. A channel-point reward that runs
 * AST arrives as 'redemption': Polar and analytics keep reporting it as 'ast', as they always have, and
 * only the usage receipt says 'redemption'.
 */
export function ttsRequestSources(wireSource: unknown): Pick<TtsRequestPayload, 'source' | 'receiptSource'> {
  if (wireSource === 'redemption') return { source: 'ast', receiptSource: 'redemption' };
  return { source: wireSource === 'ast' ? 'ast' : 'chat-command' };
}

export interface TtsRequestPayload {
  channelID: string;
  source: "chat-command" | "ast" | "redemption";
  /** Receipt-only source; see `ttsRequestSources`. Absent on requests queued by an older version. */
  receiptSource?: "redemption";
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
  /** Snapshot of `playback.allOutputs` when the message was queued (absent on older items: one page). */
  allOutputs?: boolean;
}

const ttsCharacters = (item: TtsQueueItem) => {
  const text = String(item.text ?? '');
  // Kokoro and Piper count Unicode characters, including surrogate pairs once.
  return item.provider === 'fish' ? text.length : Array.from(text).length;
};

const requester = (item: TtsQueueItem) => item.requestedBy
  ? { id: item.requestedBy.userID, login: item.requestedBy.userLogin, name: item.requestedBy.userName }
  : null;

/**
 * Owner activity row for a provider that did not speak a request: it failed, or was skipped for credits.
 * Failures are not usage, so they never become receipts; the provider that did speak has its receipt.
 */
function recordVoiceProblem(channelID: string, item: TtsQueueItem, row: {
  outcome: 'failed' | 'skipped'; reason: string; fallback?: string; requested?: string; error?: string;
}): void {
  // Building the row must not throw into the queue either.
  try {
    recordActivity({
      kind: 'voice', name: item.provider, channelID, outcome: row.outcome, reason: row.reason,
      actor: requester(item), ref: item.speechID,
      // Recovery can run a popped request again; one row per provider and reason is enough.
      dedupeKey: `${item.speechID}:${item.provider}:${row.reason}`,
      data: { chars: ttsCharacters(item), source: item.receiptSource || item.source, voice: item.voice, latencyMs: Date.now() - item.timestamp,
        fallback: row.fallback, requested: row.requested, error: row.error }
    });
  } catch {
    // The activity log is a debugging aid; the request carries on without it.
  }
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
  private speechActivities = new Map<string, SpeechActivityHandle>();
  private audibleSpeech = new Map<string, { source: string; deadline: number }>();
  private extendingActivities = new Set<string>();
  private currentFiles = new Map<string, string>();
  private fileCleanupTimeouts = new Map<string, NodeJS.Timeout>();
  /** The normal TTS message currently out on speech pages, per channel. */
  private deliveries = new Map<string, LegacyDelivery>();
  /** Stop requests that wait for several pages to confirm before the desktop speech slot is released. */
  private retiredOutputs = new Map<string, { pending: Set<string>; expires: number }>();
  synthesisTimeoutMs = DEFAULT_TTS_SYNTHESIS_TIMEOUT_MS;
  /** Speech page timings (tests shorten them). */
  outputTimings = { startAfterReadyMs: START_AFTER_READY_MS, startAfterSendMs: START_AFTER_SEND_MS, cancelAckMs: CANCEL_ACK_MS };
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

  async getStatus(channelID: string, playback?: { allOutputs?: boolean }): Promise<TtsStatusData> {
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
      // Speech pages only: Overlay Studio and the pet report their own connection above.
      outputs: summarizeOutputs(sockets?.values() ?? [], playback?.allOutputs ? 'all' : 'one'),
    };
  }

  private speechSockets(channelID: string): SpeechSocket[] {
    return [...getIO()?.of(`/speech/${channelID}`).sockets.values() ?? []] as SpeechSocket[];
  }
  /** Where a new message goes: the best page that can play it, or every open page. */
  private speechTargets(channelID: string, every: boolean): SpeechSocket[] {
    const ranked = rankOutputs(this.speechSockets(channelID));
    return every ? ranked : ranked.slice(0, 1);
  }

  private async hasOverlayConnection(channelID: string): Promise<boolean> {
    // The Redis flag can outlive a socket (especially across an API restart).
    const sockets = getIO()?.of(`/speech/${channelID}`).sockets;
    const legacy = !!sockets && [...sockets.values()].some(socket => socket.connected && socket.data.ttsReady);
    if (this.readHeads.has(channelID) || hasReadTtsTurn(channelID) || await isReadTtsConfigured(channelID)) return legacy || await readTtsAvailable(channelID) || studioHasLiveSource(channelID, 'tts');
    return studioHasSource(channelID, 'tts') || legacy;
  }

  async handleOverlayDisconnected(channelID: string, source?: string): Promise<void> {
    if (this.petTurns.has(channelID)) return; // The pet, not the speech overlay, plays this item.
    const delivery = this.deliveries.get(channelID);
    if (delivery && this.deliveryCurrent(delivery)) {
      // Only a page that has the message matters; it may move to another page.
      const gone = [...delivery.members.values()].filter(member => !member.done &&
        (source ? member.source === source : !this.outputSocket(delivery, member)?.connected));
      for (const member of gone) await this.outputEnded(delivery, member, 'disconnected', 'disconnected');
      return;
    }
    const owner = this.readTtsOwners.get(channelID);
    if (owner) {
      if (!owner.emitted || !owner.source.startsWith('legacy:') || owner.source === EVERY_OUTPUT) return;
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
      allOutputs: settings.playback?.allOutputs === true,
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
          ended: reason => this.handleSpeechEnded(channelID, speechID, reason, reason === 'pet:completed') });
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

          const beforeCredits = queueItem;
          queueItem = resolveTtsForCreditStatus(queueItem, creditStatus, streamer?.plan_tier);
          if (queueItem.provider !== requestedProvider) {
            fallbackReason = creditStatus;
            recordVoiceProblem(channelID, beforeCredits, { outcome: 'skipped',
              reason: creditStatus === 'exhausted' ? 'no_credits' : 'credit_check_failed', fallback: queueItem.provider });
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
          recordVoiceProblem(channelID, queueItem, { outcome: 'skipped', reason: 'empty_text_after_fallback',
            requested: queueItem.provider !== requestedProvider ? requestedProvider : undefined });
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
        let fallbackSkipped = false;
        if ((synthesisResult.error || !synthesisResult.outputPath || !synthesisResult.publicPath)
          && queueItem.provider !== "piper") {
          const failedItem = queueItem;
          const failedProvider = queueItem.provider;
          const providerError = synthesisResult.message;
          queueItem = resolveTtsForCreditStatus(queueItem, "unavailable");
          fallbackReason = `${failedProvider}_synthesis_failed`;
          recordVoiceProblem(channelID, failedItem, { outcome: 'failed', reason: 'synthesis_failed', fallback: queueItem.provider, error: providerError });
          if (queueItem.text.trim()) {
            synthesisResult = await synthesize();
          } else {
            fallbackSkipped = true;
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
          const requested = queueItem.provider !== requestedProvider ? requestedProvider : undefined;
          recordVoiceProblem(channelID, queueItem, fallbackSkipped
            ? { outcome: 'skipped', reason: 'empty_text_after_fallback', requested }
            : { outcome: 'failed', reason: 'synthesis_failed', requested, error: synthesisResult.message });

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
            characters: ttsCharacters(queueItem),
            text: queueItem.text,
            usage: {
              entryId: usageEntryID,
              requestId: usageRequestID,
              source: queueItem.source,
              resourceType: "speech",
              resourceId: speechID,
              receipt: { actor: requester(queueItem), voice: queueItem.voice, model: queueItem.model, source: queueItem.receiptSource },
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
        const activity = await prepareSpeechActivity({ channelId: channelID, playbackId: speechID, outputGeneration: Date.now(), source: 'tts',
          expiresAt: Date.now() + Math.max(240_000, playbackTimeoutMs + 120_000) });
        if (!activity) { await this.cleanupSpeech(channelID, speechID, true); continue; }
        this.speechActivities.set(`${channelID}:${speechID}`, activity);
        if (this.controls.has(channelID) || this.interruptedSpeechIds.get(channelID) === speechID || !await this.hasOverlayConnection(channelID) ||
            !await startSpeechActivity(activity)) { await this.cleanupSpeech(channelID, speechID, true); continue; }
        const targets = this.speechTargets(channelID, queueItem.allOutputs === true);
        const legacy = targets[0];
        if (!legacy && !studioHasLiveSource(channelID, 'tts')) {
          // Keep the already synthesized file while an overlay reconnects.
          this.speechActivities.delete(`${channelID}:${speechID}`);
          await finishSpeechActivity(activity, 'output_unavailable');
          if (this.adoptReadHead(channelID, queueItem, next.session)) {
            const head = this.readHeads.get(channelID)!;
            head.generated = { file: synthesisResult.outputPath, audioUrl: synthesisResult.publicPath,
              mime: synthesisResult.mimeType || 'audio/wav', text: queueItem.text, mode: queueItem.mode, timeoutMs: playbackTimeoutMs };
            head.phase = 'generated'; await this.runHead(channelID, head); return;
          }
          await this.cleanupSpeech(channelID, speechID, true); continue;
        }
        this.dispatchedSpeechIds.set(channelID, speechID);
        const owner = { speechId: speechID, source: legacy ? `legacy:${legacy.id}` : 'studio', emitted: false };
        this.readTtsOwners.set(channelID, owner);
        observe('queue_total', 'tts.ready', Math.max(0, Date.now() - queueItem.timestamp), 'ok', channelID);
        console.log('TTS dispatched', { channelID, speechID, readyMs: Date.now() - queueItem.timestamp });

        this.armPlaybackTimeout(channelID, speechID, playbackTimeoutMs);
        const valid = () => !this.controls.has(channelID) && this.dispatchedSpeechIds.get(channelID) === speechID && this.readTtsOwners.get(channelID) === owner;
        const dispatch = (async () => {
          const outcome = await publishStudioReadTts(channelID, { speechID, durationMs: playbackTimeoutMs, text: queueItem.text,
            onOwner: source => { if (!legacy && valid()) { owner.source = source; const audible = this.audibleSpeech.get(`${channelID}:${speechID}`); if (audible) audible.source = source; } },
            legacy: !!legacy, cancelled: () => !valid(), ...(!legacy ? { beforeEmit: () => { if (!valid()) return false; owner.emitted = true; this.audibleSpeech.set(`${channelID}:${speechID}`, { source: owner.source, deadline: Date.now() + playbackTimeoutMs + 20_000 }); this.widgetTtsStart(channelID, queueItem, queueItem.text); return true; } } : {}),
            file: synthesisResult.outputPath, mime: synthesisResult.mimeType || 'audio/wav' });
          if (!valid()) return;
          const live = targets.filter(socket => socket.connected && socket.data.ttsReady);
          if (legacy && live.length) {
            owner.emitted = true;
            this.startDelivery(channelID, owner, live, { speechID, audioUrl: synthesisResult.publicPath!, mimeType: synthesisResult.mimeType || 'audio/wav', mode: queueItem.mode, text: queueItem.text }, playbackTimeoutMs);
            this.audibleSpeech.set(`${channelID}:${speechID}`, { source: owner.source, deadline: Date.now() + playbackTimeoutMs + 20_000 });
            this.widgetTtsStart(channelID, queueItem, queueItem.text);
          } else if (!owner.emitted) await this.handleSpeechEnded(channelID, speechID, 'output_unavailable');
        })();
        this.dispatches.set(channelID, dispatch);
        try { await dispatch; }
        finally { if (this.dispatches.get(channelID) === dispatch) this.dispatches.delete(channelID); }
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
      const activity = await prepareSpeechActivity({ channelId: channel, playbackId: speech, outputGeneration: epoch, source: 'tts',
        expiresAt: Date.now() + Math.max(240_000, input.timeoutMs + 180_000), signal: head.cancellation.signal });
      if (!activity) { if (current()) await this.finishHead(channel, head, 'suppression_unavailable'); return; }
      this.speechActivities.set(`${channel}:${speech}`, activity);
      if (!current()) { await finishSpeechActivity(activity, 'cancelled'); this.speechActivities.delete(`${channel}:${speech}`); return; }
      await this.cache!.set(`twitch:${channel}:tts:processing`, speech, { EX: TTS_PROCESSING_TTL_SECONDS });
      if (!current()) return;
      this.dispatchedSpeechIds.set(channel, speech);
      const holdMs = Math.max(240_000, input.timeoutMs + 180_000);
      let route = await prepareReadTts({ channelId: channel, speechId: speech, file: input.file, mime: input.mime, text: input.text, moodText: head.item.meta?.originalText ?? head.item.text,
        holdMs, retainHead: true, attemptId: `${epoch}`, analysis: head.analysis, signal: head.cancellation.signal, cancelled: () => !current(), ended: reason => this.handleSpeechEnded(channel, speech, reason, reason === 'pet:completed') });
      if (!current()) return;
      if (!route || route.audio === 'waiting' || route.audio === 'cancelled') { await this.parkHead(channel, head); return; }
      if (!await protectReadTtsTurn(channel, speech, holdMs) || !current()) { await this.parkHead(channel, head); return; }
      if (await this.cache!.get(`twitch:${channel}:tts:session`) !== head.session) { head.cancelled = true; await this.finishHead(channel, head, 'stream_ended'); return; }
      if (!await startSpeechActivity(activity)) { await this.finishHead(channel, head, 'suppression_unavailable'); return; }
      const owner = { speechId: speech, source: 'pet', emitted: false };
      this.readTtsOwners.set(channel, owner);
      const markEmission = () => {
        if (!current() || this.readTtsOwners.get(channel) !== owner || !readTtsTurnCurrent(channel, speech, input.timeoutMs + 60_000)) return false;
        owner.emitted = true; this.audibleSpeech.set(`${channel}:${speech}`, { source: owner.source, deadline: Date.now() + input.timeoutMs + 20_000 }); head.phase = 'emitted'; this.armPlaybackTimeout(channel, speech, input.timeoutMs);
        this.widgetTtsStart(channel, head.item, input.text); return true;
      };
      if (route.audio === 'pet') {
        const emitted = route.emit ? await route.emit(markEmission) : markEmission();
        if (!current()) return;
        if (emitted) { await publishStudioReadTts(channel, { speechID: speech, durationMs: route.durationMs, text: input.text, legacy: false, cancelled: () => !current() }); return; }
        if (owner.emitted) return;
        route = route.fallback ? await route.fallback() : { audio: 'overlay', durationMs: route.durationMs };
        if (!current()) return;
      }
      const targets = this.speechTargets(channel, head.item.allOutputs === true);
      const legacy = targets[0];
      if (!legacy && !studioHasLiveSource(channel, 'tts')) { await this.parkHead(channel, head); return; }
      owner.source = legacy ? `legacy:${legacy.id}` : 'studio';
      const outcome = await publishStudioReadTts(channel, { speechID: speech, durationMs: route.durationMs || 60_000, text: input.text,
        onOwner: source => { if (!legacy && current() && this.readTtsOwners.get(channel) === owner) { owner.source = source; const audible = this.audibleSpeech.get(`${channel}:${speech}`); if (audible) audible.source = source; } },
        legacy: !!legacy, cancelled: () => !current(), ...(!legacy ? { beforeEmit: markEmission } : {}), file: input.file, mime: input.mime });
      if (!current()) return;
      const live = targets.filter(socket => socket.connected && socket.data.ttsReady);
      if (legacy && live.length && markEmission()) {
        this.startDelivery(channel, owner, live, { speechID: speech, audioUrl: input.audioUrl, mimeType: input.mime, mode: input.mode, text: input.text }, input.timeoutMs);
        const audible = this.audibleSpeech.get(`${channel}:${speech}`); if (audible) audible.source = owner.source;
        return;
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
      if (phase() !== 'emitted') {
        const activity = this.speechActivities.get(`${channel}:${speech}`);
        if (activity) { this.speechActivities.delete(`${channel}:${speech}`); await finishSpeechActivity(activity, 'not_delivered').catch(() => {}); }
      }
      head.running = false;
      if (phase() !== 'emitted' && (!this.activeSpeechIds.has(channel) || this.activeSpeechIds.get(channel) === speech) && (!this.readHeads.has(channel) || this.readHeads.get(channel) === head)) this.processingChannels.delete(channel);
      if (this.readHeads.get(channel) === head && !head.cancelled && phase() === 'parked' && version !== head.wakeVersion) this.wakeHead(channel);
      this.activePumps--; this.scheduleHeadPump();
      if (!this.readHeads.has(channel) && !this.controls.has(channel)) setImmediate(() => { void this.processNext(channel); });
    }
  }
  private finishHead(channel: string, head: ReadTtsHead, reason: string, playbackStopped = false): Promise<void> {
    if (head.completion) return head.completion;
    if (this.readHeads.get(channel) !== head) return Promise.resolve();
    // Claim the entire terminal operation before any await, including Studio
    // teardown. Controls and natural/private completion join this same promise.
    // It cannot wait on dispatch: dispatch may itself be reporting its terminal.
    const speech = head.item.speechID;
    head.cancelled = true; head.epoch++; head.phase = 'terminal'; this.headWakes.delete(channel);
    this.widgetTtsEnd(channel, speech, reason);
    head.cancellation.abort();
    if (this.dispatchedSpeechIds.get(channel) === speech) this.dispatchedSpeechIds.delete(channel);
    const completion = Promise.resolve().then(async () => {
      // Each step runs even if an earlier one fails, so a failed external call
      // can never leave this cancelled head holding the channel.
      let failure: unknown;
      if (!playbackStopped) await this.retireAudibleSpeech(channel, speech).catch(() => {});
      this.retireReadOwner(channel, speech);
      try { await endStudioReadTts(channel, speech); } catch (error) { failure = error; }
      try { await this.cleanupSpeech(channel, speech, false, playbackStopped); } catch (error) { failure ??= error; }
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
      this.playbackTimedOut(channelID, speechID).catch(error => { console.error('TTS timeout cleanup failed', { channelID, speechID, error }); });
    }, delay));
  }

  /** The message ran out of time. On one page that never started, it first moves to another page. */
  private async playbackTimedOut(channelID: string, speechID: string): Promise<void> {
    const delivery = this.deliveryFor(channelID, speechID);
    if (!delivery) return this.handleSpeechEnded(channelID, speechID, 'timeout');
    if (delivery.moving) return; // The move re-arms the deadline or settles the message itself.
    const active = !delivery.every && delivery.active ? delivery.members.get(delivery.active) : undefined;
    if (active && !active.done && !active.started && await this.moveDelivery(delivery, active, 'timeout', 'inferred')) return;
    if (!this.deliveryCurrent(delivery)) return;
    // Pages that never started count as failing (the status page says so) and are stopped.
    for (const member of delivery.members.values()) {
      if (member.done || member.started) continue;
      this.noteOutputFailure(delivery, member, 'timeout');
      this.stopUnstarted(delivery, member);
    }
    await this.finishDelivery(delivery, 'timeout');
  }

  /**
   * Custom widget `tts` events: `start` once when the audio is handed to an output, `end` once when it finishes (only
   * after a start, so widgets always see pairs). Text is the filtered text that was spoken; never the original message.
   */
  private readonly widgetTts = new Map<string, { at: number; event: Record<string, unknown> }>();
  private widgetTtsStart(channel: string, item: TtsQueueItem, text: string): void {
    const key = `${channel}:${item.speechID}`;
    if (this.widgetTts.has(key)) return;
    for (const [old, entry] of this.widgetTts) if (Date.now() - entry.at > 3_600_000) this.widgetTts.delete(old);
    const by = item.requestedBy, name = String(by?.userName || by?.userLogin || '').slice(0, 64);
    const event = { id: item.speechID, phase: 'start', text: String(text).slice(0, 2000), reason: null, test: false,
      user: name ? { id: String(by?.userID ?? '').slice(0, 64), login: String(by?.userLogin || name.toLowerCase()).slice(0, 64), name } : null };
    this.widgetTts.set(key, { at: Date.now(), event });
    publishWidgetEvent(channel, 'tts', 'tts', { ...event, at: Date.now() });
  }
  private widgetTtsEnd(channel: string, speechID: string, reason: string): void {
    const key = `${channel}:${speechID}`, started = this.widgetTts.get(key);
    if (!started) return;
    this.widgetTts.delete(key);
    const publicReason = reason === 'ended' || reason === 'pet:completed' ? 'ended' : reason === 'skip' ? 'skipped' : reason === 'clear' ? 'cleared' : 'interrupted';
    publishWidgetEvent(channel, 'tts', 'tts', { ...started.event, phase: 'end', reason: publicReason, at: Date.now() });
  }

  handleSpeechPlayback(channelID: string, data: { speechID?: string; phase?: string; position?: number }, source?: string): void {
    if (!this.acceptsOverlayReport(channelID, data?.speechID, source)) return;
    if (!data?.speechID || this.dispatchedSpeechIds.get(channelID) !== data.speechID) return;
    const delivery = this.deliveryFor(channelID, data.speechID);
    const member = delivery && source ? delivery.members.get(source) : undefined;
    if (delivery && member) return this.outputProgress(delivery, member, data);
    const key = `${channelID}:${data.speechID}`;
    const previous = this.playbackPositions.get(key);
    const position = data.position;
    // Only the first receipt or advancing media time extends the deadline.
    // A stuck client sending heartbeats must not hold the queue forever.
    void reportReadTts(channelID, data.speechID, data.phase || '', Number(position)).catch(() => {});
    if (previous === undefined || (Number.isFinite(position) && position! > previous + 0.05)) {
      this.playbackPositions.set(key, Number.isFinite(position) ? Math.max(0, position!) : 0);
      this.extendPlayback(channelID, data.speechID);
      this.armPlaybackTimeout(channelID, data.speechID, 60_000);
      if (previous === undefined || previous === 0) {
        console.log('TTS playback', { channelID, speechID: data.speechID, phase: data.phase, position });
      }
    }
  }

  private extendPlayback(channelID: string, speechID: string): void {
    const key = `${channelID}:${speechID}`;
    const audible = this.audibleSpeech.get(key);
    if (audible) audible.deadline = Math.max(audible.deadline, Date.now() + 80_000);
    const activity = this.speechActivities.get(key);
    if (activity && activity.expiresAt - Date.now() < 90_000 && !this.extendingActivities.has(key)) {
      this.extendingActivities.add(key);
      void extendSpeechActivity(activity, Date.now() + 120_000).catch(() => {}).finally(() => this.extendingActivities.delete(key));
    }
  }

  private acceptsOverlayReport(channelID: string, speechID?: string, source?: string): boolean {
    const owner = this.readTtsOwners.get(channelID);
    if (!owner) return true;
    if (!owner.emitted || owner.speechId !== speechID) return false;
    if (owner.source === source) return true;
    const delivery = this.deliveries.get(channelID);
    return owner.source === EVERY_OUTPUT && delivery?.speechID === speechID && !!source && delivery.members.has(source);
  }
  private async retireAudibleSpeech(channel: string, speech: string) {
    const key = `${channel}:${speech}`, audible = this.audibleSpeech.get(key), activity = this.speechActivities.get(key);
    if (!audible || !activity) return;
    let source = audible.source;
    const delivery = this.deliveries.get(channel);
    if (delivery?.speechID === speech) {
      // Each page that may still be playing has to confirm it stopped before the slot is released.
      const existing = this.retiredOutputs.get(key);
      const unproven = [...delivery.members.values()].filter(member => !member.stopped && (!existing || existing.pending.has(member.source))).map(member => member.source);
      if (existing) {
        // Retired again (skip, then cleanup): keep the confirmations already received.
        existing.pending = new Set(unproven);
        if (!existing.pending.size) { this.retiredOutputs.delete(key); await confirmRetiredSpeechActivity(channel, { kind: 'tts', source: EVERY_OUTPUT }, speech); }
        return;
      }
      if (!unproven.length) {
        // Every page is known to be silent: release the slot instead of waiting for a confirmation.
        this.speechActivities.delete(key);
        await finishSpeechActivity(activity, 'ended');
        return;
      }
      if (unproven.length === 1) source = unproven[0];
      else {
        source = EVERY_OUTPUT;
        for (const [old, entry] of this.retiredOutputs) if (entry.expires < Date.now()) this.retiredOutputs.delete(old);
        this.retiredOutputs.set(key, { pending: new Set(unproven), expires: Date.now() + 600_000 });
      }
    }
    await retireMatchingSpeechActivity(channel, speech, activity.outputGeneration, audible.deadline, { kind: 'tts', source });
  }
  /** A late stop confirmation for a message that was already retired (skip, clear, timeout). */
  private async confirmOutputStopped(channelID: string, speechID: string, source: string): Promise<boolean> {
    const key = `${channelID}:${speechID}`, retired = this.retiredOutputs.get(key);
    const delivery = this.deliveries.get(channelID);
    const member = delivery?.speechID === speechID ? delivery.members.get(source) : undefined;
    if (retired?.pending.has(source)) {
      if (member) member.stopped = true; // A later retirement of the same message must not ask it again.
      retired.pending.delete(source);
      if (!retired.pending.size) {
        this.retiredOutputs.delete(key);
        await confirmRetiredSpeechActivity(channelID, { kind: 'tts', source: EVERY_OUTPUT }, speechID);
      }
      return true;
    }
    const confirmed = await confirmRetiredSpeechActivity(channelID, { kind: 'tts', source }, speechID);
    if (confirmed && member) member.stopped = true;
    return confirmed;
  }
  private retireReadOwner(channel: string, speech: string) {
    const owner = this.readTtsOwners.get(channel);
    if (!owner || owner.speechId !== speech) return;
    this.readTtsOwners.delete(channel);
    const delivery = this.deliveries.get(channel);
    if (delivery?.speechID === speech) {
      // Every page that got the message drops it and resynchronises its local queue.
      const sockets = this.speechSockets(channel);
      for (const member of delivery.members.values()) sockets.find(socket => socket.id === member.socketId)?.emit('speech-reset');
      return;
    }
    if (owner.source.startsWith('legacy:')) getIO()?.of(`/speech/${channel}`).sockets.get(owner.source.slice(7))?.emit('speech-reset');
  }
  async handleOverlayEnded(channelID: string, speechID: string | undefined, reason: string | undefined, source: string, playbackStopped = false,
      report?: { position?: unknown; started?: unknown }) {
    if (playbackStopped && speechID && await this.confirmOutputStopped(channelID, speechID, source)) return;
    const delivery = speechID ? this.deliveryFor(channelID, speechID) : undefined;
    const member = delivery?.members.get(source);
    if (delivery && member) return this.outputEnded(delivery, member, reason || 'ended', 'reported', report);
    if (reason === 'reset') return; // A page confirming a stop we asked for, never an ending.
    if (this.acceptsOverlayReport(channelID, speechID, source)) await this.handleSpeechEnded(channelID, speechID, reason, playbackStopped);
  }

  // ---- Speech pages: which page plays a message, and moving it when that page fails ----

  private deliveryFor(channelID: string, speechID: string): LegacyDelivery | undefined {
    const delivery = this.deliveries.get(channelID);
    return delivery && delivery.speechID === speechID && !delivery.finished ? delivery : undefined;
  }
  private deliveryCurrent(delivery: LegacyDelivery): boolean {
    return this.deliveries.get(delivery.channel) === delivery && !delivery.finished && !this.controls.has(delivery.channel)
      && this.dispatchedSpeechIds.get(delivery.channel) === delivery.speechID;
  }
  private clearDelivery(channelID: string, speechID?: string): void {
    const delivery = this.deliveries.get(channelID);
    if (!delivery || speechID !== undefined && delivery.speechID !== speechID) return;
    delivery.finished = true;
    for (const member of delivery.members.values()) { for (const timer of member.timers) clearTimeout(timer); member.timers = []; }
    this.deliveries.delete(channelID);
  }
  /** Sends a generated message to the chosen speech pages (several only in "every page" mode). */
  private startDelivery(channel: string, owner: { source: string }, sockets: SpeechSocket[], payload: SpeechPayload, timeoutMs: number): void {
    this.clearDelivery(channel);
    const every = sockets.length > 1;
    const delivery: LegacyDelivery = { channel, speechID: payload.speechID, payload, every, members: new Map(), primary: `legacy:${sockets[0].id}`,
      eligible: new Set(this.speechSockets(channel).filter(socket => socket.connected).map(socket => socket.id)),
      timeoutMs, moving: false, heard: false, normalEnd: false, finished: false };
    if (!every) delivery.active = delivery.primary;
    this.deliveries.set(channel, delivery);
    owner.source = every ? EVERY_OUTPUT : delivery.primary;
    for (const socket of sockets) this.sendToOutput(delivery, socket);
  }
  private sendToOutput(delivery: LegacyDelivery, socket: SpeechSocket): DeliveryMember {
    const info = socket.data.ttsOutput;
    const member: DeliveryMember = { source: `legacy:${socket.id}`, socketId: socket.id, pageId: info?.version === 2 ? info.pageId : undefined,
      started: false, done: false, stopped: false, reported: false, position: 0, timers: [] };
    delivery.members.set(member.source, member);
    member.timers.push(setTimeout(() => {
      this.outputStuck(delivery, member, 'no-start').catch(error => console.error('TTS speech page check failed', { channelID: delivery.channel, error }));
    }, this.outputTimings.startAfterSendMs));
    socket.emit('speech', delivery.payload);
    return member;
  }
  private outputSocket(delivery: LegacyDelivery, member: DeliveryMember): SpeechSocket | undefined {
    return this.speechSockets(delivery.channel).find(socket => socket.id === member.socketId);
  }
  /** The best untried page. A page ignores a speech id it already saw, even after reconnecting under a new socket id. */
  private nextOutput(delivery: LegacyDelivery): SpeechSocket | undefined {
    const tried = new Set<string>(), pages = new Set<string>();
    for (const member of delivery.members.values()) { tried.add(member.socketId); if (member.pageId) pages.add(member.pageId); }
    return rankOutputs(this.speechSockets(delivery.channel)).find(socket => {
      if (tried.has(socket.id)) return false;
      const page = socket.data.ttsOutput?.version === 2 ? socket.data.ttsOutput.pageId : undefined;
      return page ? !pages.has(page) : delivery.eligible.has(socket.id);
    });
  }
  private noteOutputFailure(delivery: LegacyDelivery, member: DeliveryMember, reason: string): void {
    if (!OUTPUT_FAILURES.has(reason)) return;
    const info = this.outputSocket(delivery, member)?.data.ttsOutput;
    if (info) recordOutputFailure(info, reason);
  }
  /** Stops a page that has not started yet. A page that never started is silent once it handles the reset. */
  private stopUnstarted(delivery: LegacyDelivery, member: DeliveryMember): void {
    member.done = true;
    this.outputSocket(delivery, member)?.emit('speech-reset');
    member.stopped ||= !member.started;
  }
  /**
   * Stops one page before the message moves elsewhere. Current pages confirm (and say if playback had
   * started after all); older pages get a reset, which every page version understands.
   */
  private async stopOutput(delivery: LegacyDelivery, member: DeliveryMember): Promise<{ started: boolean }> {
    const socket = this.outputSocket(delivery, member);
    if (socket?.connected && socket.data.ttsOutput?.version === 2) {
      try {
        const reply = await socket.timeout(this.outputTimings.cancelAckMs).emitWithAck('speech-cancel', { speechID: delivery.speechID }) as { started?: unknown } | undefined;
        if (reply?.started === true) member.started = true;
        member.stopped = true;
        return { started: member.started };
      } catch {
        // No answer in time: fall back to a reset, unless the message ended meanwhile. The page may
        // already be playing the next message, and a reset is not scoped to one speech id.
        if (!this.deliveryCurrent(delivery)) return { started: member.started };
      }
    }
    if (socket?.connected) socket.emit('speech-reset');
    member.stopped ||= !member.started;
    return { started: member.started };
  }
  /** Progress from a page playing the message. */
  private outputProgress(delivery: LegacyDelivery, member: DeliveryMember, data: { speechID?: string; phase?: string; position?: number }): void {
    if (member.done) return;
    const position = Number.isFinite(data.position) ? Math.max(0, Number(data.position)) : 0;
    const first = !member.reported; member.reported = true;
    if (data.phase === 'ready' && !member.readyAt) {
      member.readyAt = Date.now();
      member.timers.push(setTimeout(() => {
        this.outputStuck(delivery, member, 'start-timeout').catch(error => console.error('TTS speech page check failed', { channelID: delivery.channel, error }));
      }, this.outputTimings.startAfterReadyMs));
    }
    const advanced = position > member.position + 0.05;
    if (advanced) member.position = position;
    const startedNow = !member.started && (data.phase === 'playing' || data.phase === 'progress' || advanced);
    if (startedNow) {
      member.started = true; delivery.heard = true; delivery.clock ??= member.source;
      for (const timer of member.timers) clearTimeout(timer);
      member.timers = [];
      const info = this.outputSocket(delivery, member)?.data.ttsOutput;
      if (info) recordOutputSuccess(info);
    }
    // One page's clock drives the pet's read-TTS timeline; copies are never one coherent clock.
    if (member.source === (delivery.every ? delivery.clock ?? delivery.primary : delivery.active)) {
      void reportReadTts(delivery.channel, delivery.speechID, data.phase || '', position).catch(() => {});
    }
    if (first || advanced || startedNow) {
      this.extendPlayback(delivery.channel, delivery.speechID);
      this.armPlaybackTimeout(delivery.channel, delivery.speechID, 60_000);
      if (first || startedNow) console.log('TTS playback', { channelID: delivery.channel, speechID: delivery.speechID, phase: data.phase, position, ...(delivery.every || delivery.members.size > 1 ? { page: member.socketId } : {}) });
    }
  }
  /** A page did not start in time (no `ready` → play, or nothing at all from an older page). */
  private async outputStuck(delivery: LegacyDelivery, member: DeliveryMember, reason: 'no-start' | 'start-timeout'): Promise<void> {
    if (!this.deliveryCurrent(delivery) || member.done || member.started) return;
    if (delivery.every) {
      // Another page is already playing it: this one would only start late, out of step.
      if (![...delivery.members.values()].some(other => other.started)) return;
      await this.stopOutput(delivery, member);
      if (!this.deliveryCurrent(delivery) || member.done) return;
      member.done = true;
      if (!member.started) this.noteOutputFailure(delivery, member, reason);
      return this.everyOutputProgress(delivery, reason);
    }
    // Without another page this does nothing: the page may still start, and its own checks end it.
    if (member.source === delivery.active) await this.moveDelivery(delivery, member, reason, 'inferred');
  }
  /** A page finished with the message: it ended, failed or disconnected. */
  private async outputEnded(delivery: LegacyDelivery, member: DeliveryMember, reason: string, how: 'reported' | 'disconnected',
      report?: { position?: unknown; started?: unknown }): Promise<void> {
    if (member.done || delivery.finished) return;
    if (report?.started === true || Number(report?.position) > 0.05) { member.started = true; delivery.heard = true; }
    if (how === 'reported' && reason === 'reset') { member.stopped = true; return; }
    const failed = how === 'disconnected' || OUTPUT_FAILURES.has(reason);
    if (delivery.every) {
      member.done = true;
      member.stopped ||= how === 'reported' || !member.started;
      if (failed && !member.started) this.noteOutputFailure(delivery, member, reason);
      if (reason === 'ended') delivery.normalEnd = true;
      return this.everyOutputProgress(delivery, reason);
    }
    if (member.source !== delivery.active) { member.done = true; member.stopped ||= how === 'reported' || !member.started; return; }
    if (delivery.moving) return; // The move in progress decides; this page is being stopped anyway.
    if (failed && !member.started && await this.moveDelivery(delivery, member, reason, how)) return;
    member.done = true;
    member.stopped ||= how === 'reported' || !member.started;
    if (failed && !member.started) this.noteOutputFailure(delivery, member, reason);
    await this.finishDelivery(delivery, reason);
  }
  /** "Every page" mode: done when each page that started has finished; pages that never started are stopped then. */
  private async everyOutputProgress(delivery: LegacyDelivery, reason: string): Promise<void> {
    if (!this.deliveryCurrent(delivery)) return;
    const open = [...delivery.members.values()].filter(member => !member.done);
    const heard = delivery.heard || [...delivery.members.values()].some(member => member.started);
    if (open.length && !(heard && open.every(member => !member.started))) return;
    for (const member of open) this.stopUnstarted(delivery, member);
    await this.finishDelivery(delivery, delivery.normalEnd ? 'ended' : reason);
  }
  /**
   * The page playing a message failed before anyone heard it: the same audio (same file, same speech id,
   * no new synthesis or billing) goes to the next page that can play it. Returns false when there is no
   * other page, leaving the ending to the caller; true when the message continues or was settled here.
   */
  private async moveDelivery(delivery: LegacyDelivery, member: DeliveryMember, reason: string, how: 'reported' | 'inferred' | 'disconnected'): Promise<boolean> {
    if (delivery.moving) return true;
    if (!this.deliveryCurrent(delivery) || delivery.members.size >= MAX_OUTPUTS_PER_MESSAGE || !this.nextOutput(delivery)) return false;
    delivery.moving = true; // Claimed before the first await: a timeout, error and skip cannot all move it.
    try {
      if (how === 'inferred') {
        const { started } = await this.stopOutput(delivery, member);
        if (!this.deliveryCurrent(delivery)) return true;
        if (started) { member.done = true; await this.finishDelivery(delivery, reason); return true; } // It was audible after all: never replay.
      } else member.stopped ||= how === 'reported' || !member.started;
      member.done = true;
      if (how !== 'disconnected') this.noteOutputFailure(delivery, member, reason);
      const next = this.nextOutput(delivery);
      if (!next) { await this.finishDelivery(delivery, reason); return true; }
      const moved = this.sendToOutput(delivery, next);
      delivery.active = moved.source;
      const owner = this.readTtsOwners.get(delivery.channel);
      if (owner?.speechId === delivery.speechID) owner.source = moved.source;
      this.extendPlayback(delivery.channel, delivery.speechID);
      this.armPlaybackTimeout(delivery.channel, delivery.speechID, delivery.timeoutMs);
      console.log('TTS moved to another speech page', { channelID: delivery.channel, speechID: delivery.speechID, reason, from: member.socketId, to: next.id });
      return true;
    } finally { delivery.moving = false; }
  }
  private async finishDelivery(delivery: LegacyDelivery, reason: string): Promise<void> {
    if (delivery.finished) return;
    const stopped = [...delivery.members.values()].every(member => member.stopped);
    for (const member of delivery.members.values()) { for (const timer of member.timers) clearTimeout(timer); member.timers = []; }
    // Stays registered until cleanup so retirement still sees which pages may be playing.
    delivery.finished = true;
    await this.handleSpeechEnded(delivery.channel, delivery.speechID, reason, stopped);
  }
  async handleSpeechEnded(channelID: string, speechID?: string, reason = 'ended', playbackStopped = false): Promise<void> {
    if (playbackStopped && speechID && reason === 'pet:completed' &&
        await confirmRetiredSpeechActivity(channelID, { kind: 'tts', source: 'pet' }, speechID)) return;
    if (!speechID || this.dispatchedSpeechIds.get(channelID) !== speechID) return;
    // Claim completion before the first await. Concurrent duplicate events must
    // not both clean up and release a newer item after Redis yields.
    const head = this.readHeads.get(channelID);
    if (head?.item.speechID === speechID) {
      await this.finishHead(channelID, head, reason, playbackStopped);
      return;
    }
    this.dispatchedSpeechIds.delete(channelID);
    this.activeSpeechIds.delete(channelID);
    this.widgetTtsEnd(channelID, speechID, reason);
    if (!playbackStopped) await this.retireAudibleSpeech(channelID, speechID).catch(() => {});
    const petTurn = this.petTurns.get(channelID);
    if (petTurn?.speechID === speechID) petTurn.reason = reason;
    this.retireReadOwner(channelID, speechID);
    await endStudioReadTts(channelID, speechID);
    console.log('TTS finished', { channelID, speechID, reason });
    await this.cleanupSpeech(channelID, speechID, false, playbackStopped);
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
      if (speechID) await this.retireAudibleSpeech(channelID, speechID).catch(() => {});
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

  async cleanupSpeech(channelID: string, speechID: string, keepProcessing = false, playbackStopped = false): Promise<void> {
    // Any other way a played message goes away still ends its widget event (normal endings already did).
    this.widgetTtsEnd(channelID, speechID, 'interrupted');
    if (!this.cache) {
      await this.init();
    }

    const head = this.readHeads.get(channelID);
    if (head?.item.speechID === speechID) { head.cancelled = true; head.epoch++; head.phase = 'terminal'; head.cancellation.abort(); this.headWakes.delete(channelID); }
    if (!playbackStopped) await this.retireAudibleSpeech(channelID, speechID).catch(() => {});
    this.retireReadOwner(channelID, speechID);
    this.clearDelivery(channelID, speechID);
    // External failures are reported after local cleanup, never instead of it.
    let failure: unknown;
    const activityKey = `${channelID}:${speechID}`, activity = this.speechActivities.get(activityKey);
    const audioExposed = this.audibleSpeech.delete(activityKey);
    if (activity) {
      this.speechActivities.delete(activityKey);
      // A reset, disconnect or timeout requests stop but cannot prove silence.
      // The durable slot remains until its conservative execution deadline.
      if (!audioExposed || playbackStopped) try { await finishSpeechActivity(activity, 'ended'); } catch (error) { failure = error; }
    }
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
