import { Polar } from "@polar-sh/sdk";
import { randomUUID } from "node:crypto";
import { getDragonflyClient } from "./databases/dragonfly.database.js";
import { error, info } from "./logger.js";

const INGEST_LOCK_PREFIX = "locks:polar-ingest:";
const INGEST_LOCK_TTL_MS = 8000;
const INGEST_LOCK_MAX_WAIT_MS = 2500;
const INGEST_LOCK_RETRY_MS = 350;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let polarshClient: Polar | null = null;

export async function getPolarShClient(caller: string): Promise<Polar> {
  if (polarshClient) return polarshClient;

  if (!process.env.POLARSH_OAT) {
    throw new Error("POLARSH_OAT is not set");
  }

  polarshClient = new Polar({
    accessToken: process.env.POLARSH_OAT,
  });

  info(
    { message: `PolarSH client initialized for ${caller}` },
    { destination: "console" },
  );

  return polarshClient;
}

interface LLMMetadata {
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface IngestPolarSHEventOptions {
  customerId: string;
  channelID?: string;
  cost: number;
  reason: string;
  llm?: LLMMetadata;
  /** For TTS/audio services - Polar.sh _cost field (1 = 1 cent) */
  _cost?: number;
  /** For TTS/audio services - number of characters processed */
  characters?: number;
  mode?: "immediate" | "batch" | "cache";
}

interface IngestPolarSHEventResponse {
  error: boolean;
  message?: string;
  details?: any;
}

interface GrantPolarAiCreditsOptions {
  customerId: string;
  credits: number;
  reason: string;
  adminLogin?: string;
}

interface EventData {
  name: string;
  customerId: string;
  metadata: {
    cost: number;
    currency: string;
    credits: number;
    reason: string;
    characters?: number;
    _cost?: {
      amount: number;
      currency: string;
    };
    _llm?: {
      vendor: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
  };
}

/**
 * The ingest response is { inserted, duplicates } — there is no `error` field
 * (HTTP failures throw instead). An ingest is only complete when every event
 * we sent was actually stored (or deduplicated because it was already stored).
 */
function isIngestComplete(result: unknown, expectedCount: number): boolean {
  const r = result as { inserted?: unknown; duplicates?: unknown } | null | undefined;
  const inserted = typeof r?.inserted === "number" ? r.inserted : 0;
  const duplicates = typeof r?.duplicates === "number" ? r.duplicates : 0;
  return inserted + duplicates >= expectedCount;
}

type DragonflyClient = Awaited<ReturnType<typeof getDragonflyClient>>;

async function acquireIngestLock(cache: DragonflyClient, lockKey: string): Promise<string | null> {
  const lockValue = randomUUID();
  const deadline = Date.now() + INGEST_LOCK_MAX_WAIT_MS;

  do {
    const result = await cache.set(lockKey, lockValue, { NX: true, PX: INGEST_LOCK_TTL_MS });
    if (result === "OK") return lockValue;
    await sleep(INGEST_LOCK_RETRY_MS);
  } while (Date.now() < deadline);

  return null;
}

async function releaseIngestLock(cache: DragonflyClient, lockKey: string, lockValue: string): Promise<void> {
  try {
    const current = await cache.get(lockKey);
    if (current === lockValue) {
      await cache.del(lockKey);
    }
  } catch {
    // Lock expires on its own (PX TTL); nothing else to do.
  }
}

/**
 * Pending events used to be stored as a single JSON-array string. The queue is
 * now a Redis list (atomic RPUSH/LTRIM, no read-modify-write races), so migrate
 * the legacy format on first access.
 */
async function migrateLegacyQueueIfNeeded(cache: DragonflyClient, cacheKey: string): Promise<void> {
  const keyType = await cache.type(cacheKey);
  if (keyType !== "string") return;

  const stored = await cache.get(cacheKey);
  let legacy: EventData[] = [];
  try {
    legacy = stored ? (JSON.parse(stored) as EventData[]) : [];
  } catch {
    legacy = [];
  }

  await cache.del(cacheKey);
  if (legacy.length > 0) {
    await cache.rPush(cacheKey, legacy.map((event) => JSON.stringify(event)));
  }
}

async function queueEvent(cache: DragonflyClient, cacheKey: string, eventData: EventData): Promise<void> {
  await migrateLegacyQueueIfNeeded(cache, cacheKey);
  await cache.rPush(cacheKey, JSON.stringify(eventData));
}

export async function ingestPolarSHEvent(
  options: IngestPolarSHEventOptions,
): Promise<IngestPolarSHEventResponse> {
  const {
    customerId,
    channelID,
    cost,
    reason,
    llm,
    _cost,
    characters,
    mode = "batch",
  } = options;

  if (!customerId) {
    return { error: true, message: "customerId is required" };
  }

  if ((mode === "batch" || mode === "cache") && !channelID) {
    return {
      error: true,
      message: "channelID is required for batch/cache modes",
    };
  }

  try {
    const cacheClient = await getDragonflyClient("PolarSH");
    const cacheKey = `twitch:${channelID}:ai:polarshevent`;

    let eventData: EventData = {
      name: "ai_usage",
      customerId: customerId,
      metadata: {
        cost: cost,
        currency: "usd",
        credits: Math.ceil(cost * 1000),
        reason: reason,
      },
    };

    if (llm) {
      let amountValue = Math.round(cost * 100 * 1e10) / 1e10;
      let amountStr = amountValue.toString();
      if (amountStr.length > 17) {
        amountStr = amountStr.substring(0, 17);
        amountValue = parseFloat(amountStr);
      }

      let costValue = Math.round(cost * 100 * 1e8) / 1e8;
      let costStr = costValue.toString();
      if (costStr.length > 12) {
        costStr = costStr.substring(0, 12);
        costValue = parseFloat(costStr);
      }

      let vendor = "unknown";
      let modelName = llm.model || "unknown";
      if (llm.model) {
        const parts = llm.model.split("/");
        vendor = parts[0] || "unknown";
        const actualModel = parts[1] || llm.model;
        modelName = actualModel.split(":")[0];
      }

      eventData.metadata = {
        _cost: {
          amount: amountValue,
          currency: "usd",
        },
        _llm: {
          vendor: vendor,
          model: modelName,
          inputTokens: llm.usage?.prompt_tokens || 0,
          outputTokens: llm.usage?.completion_tokens || 0,
          totalTokens: llm.usage?.total_tokens || 0,
        },
        cost: costValue,
        credits: Math.ceil(costValue * 1000),
        currency: "usd",
        reason: reason,
      };
    } else if (_cost !== undefined) {
      // For TTS/audio services that don't use LLM
      eventData.metadata = {
        _cost: {
          amount: _cost,
          currency: "usd",
        },
        cost: cost,
        credits: Math.ceil(_cost * 1000),
        currency: "usd",
        reason: reason,
        characters: characters,
      };
    }

    if (mode === "immediate") {
      const polarshClientInstance = await getPolarShClient(
        "ingestPolarSHEvent immediate mode",
      );
      const ingestResult = (await polarshClientInstance.events.ingest({
        events: [eventData],
      })) as any;

      if (!isIngestComplete(ingestResult, 1)) {
        return {
          error: true,
          message: "PolarSH ingest incomplete",
          details: ingestResult,
        };
      }

      return { error: false };
    }

    // Serialize queue mutations + flush per channel. Only one process/container
    // flushes a channel's queue at a time; concurrent callers just queue their
    // event durably and let the next flush carry it.
    const lockKey = `${INGEST_LOCK_PREFIX}${channelID}`;
    const lockValue = await acquireIngestLock(cacheClient, lockKey);

    if (!lockValue) {
      try {
        await queueEvent(cacheClient, cacheKey, eventData);
      } catch (queueErr) {
        await error(
          {
            function: "ingestPolarSHEvent",
            error: "Failed to queue AI event while flush in progress",
            err: queueErr instanceof Error ? queueErr.message : String(queueErr),
          },
          { channelId: channelID, destination: "both" },
        );
        return { error: true, message: "Failed to queue AI event" };
      }
      return { error: false, message: "queued (flush in progress)" };
    }

    try {
      // Durably queue the event BEFORE any network call — a failed or
      // interrupted ingest must never lose it.
      await queueEvent(cacheClient, cacheKey, eventData);

      if (mode === "cache") {
        return { error: false };
      }

      const pendingRaw = await cacheClient.lRange(cacheKey, 0, -1);
      if (pendingRaw.length === 0) {
        return { error: false };
      }

      const events: EventData[] = [];
      for (const raw of pendingRaw) {
        try {
          events.push(JSON.parse(raw) as EventData);
        } catch {
          // Skip malformed queue entries; they are removed by the trim below.
        }
      }

      if (events.length === 0) {
        await cacheClient.del(cacheKey);
        return { error: false };
      }

      const polarshClientInstance = await getPolarShClient(
        "ingestPolarSHEvent batch/cache mode",
      );

      const ingestResult = (await polarshClientInstance.events.ingest({
        events,
      })) as any;

      if (!isIngestComplete(ingestResult, events.length)) {
        // Queue is left intact so a later event re-sends everything.
        await error(
          {
            function: "ingestPolarSHEvent",
            error: "PolarSH ingest incomplete",
            expected: events.length,
            ingestResult,
          },
          { channelId: channelID, destination: "both" },
        );
        return {
          error: true,
          message: "PolarSH ingest incomplete",
          details: ingestResult,
        };
      }

      // Remove exactly the events we sent; events queued during the ingest survive.
      await cacheClient.lTrim(cacheKey, pendingRaw.length, -1);
      return { error: false };
    } finally {
      await releaseIngestLock(cacheClient, lockKey, lockValue);
    }
  } catch (err) {
    await error(
      {
        function: "ingestPolarSHEvent",
        error: err instanceof Error ? err.message : String(err),
      },
      { channelId: channelID, destination: "both" },
    );
    return {
      error: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function grantPolarAiCredits(
  options: GrantPolarAiCreditsOptions,
): Promise<IngestPolarSHEventResponse> {
  const credits = Math.floor(Number(options.credits));

  if (!options.customerId) {
    return { error: true, message: "customerId is required" };
  }

  if (!Number.isFinite(credits) || credits <= 0) {
    return { error: true, message: "credits must be a positive number" };
  }

  try {
    const polarshClientInstance = await getPolarShClient(
      "grantPolarAiCredits",
    );

    const ingestResult = (await polarshClientInstance.events.ingest({
      events: [
        {
          name: "ai_usage",
          customerId: options.customerId,
          metadata: {
            credits: -credits,
            cost: 0,
            currency: "usd",
            reason: options.reason,
            source: "admin_credit_grant",
            adminLogin: options.adminLogin || "unknown",
          },
        },
      ],
    })) as any;

    if (!isIngestComplete(ingestResult, 1)) {
      return {
        error: true,
        message: "PolarSH grant credits ingest incomplete",
        details: ingestResult,
      };
    }

    return { error: false };
  } catch (err) {
    await error(
      {
        function: "grantPolarAiCredits",
        customerId: options.customerId,
        credits,
        error: err instanceof Error ? err.message : String(err),
      },
      { destination: "both" },
    );

    return {
      error: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
