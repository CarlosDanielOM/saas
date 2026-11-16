import { randomUUID } from "node:crypto";
import { getDragonflyClient } from "./databases/dragonfly.database.js";
import { ingestPolarSHEvent } from "./polarsh.js";
import { error } from "./logger.js";
import { recordAiCreditUsage } from "./billing.js";
import { listPriceCostUsd, parkTtsUsage } from "./tts/tts_provider_cost.js";
import TtsUsagePending from "../schemas/tts_usage_pending.schema.js";
import type { AiUsageContextInput, AiUsageReceiptDetails, AiUsageResourceType } from "./ai_usage_event.js";
import type { TtsProviderCost } from "../server/services/tts/tts_provider.interface.js";

/**
 * TTS character to credit conversion rates: the fixed price streamers pay, in AI credits (1 credit =
 * $0.00001). It deliberately does not follow the provider's price; the event's `_cost` carries what the
 * provider really charged (see `utils/tts/tts_provider_cost.ts`), so a promotion changes our cost, not
 * the streamer's price.
 */
const TTS_CREDITS_PER_CHARACTER: Record<string, number> = {
  piper: 50, // One credit per 50 characters; available even after exhaustion
  kokoro: 15, // One credit per 15 characters, rounded up
  fish: 1.5, // 1.5 credits per character
};

function generateTimeLeftToNextMonthInSeconds(): number {
  const now = new Date();
  const dayOfMonth = now.getDate();
  const timeLeft = 30 - dayOfMonth;
  return (
    timeLeft * 24 * 3600 -
    now.getHours() * 3600 -
    now.getMinutes() * 60 -
    now.getSeconds()
  );
}

export interface TtsUsageTrackOptions {
  channelID: string;
  streamer: {
    polar_sh_customer_id?: string;
    plan_tier?: string;
  };
  provider: "piper" | "fish" | "kokoro";
  characters: number;
  text: string;
  requireDurableUsage?: boolean;
  /** From the synthesis result: what the provider will charge us. Absent for Piper, which runs on our host. */
  providerCost?: TtsProviderCost;
  usage?: {
    entryId?: string;
    requestId?: string;
    source?: string;
    resourceType?: AiUsageResourceType;
    resourceId?: string;
    /** Requester, voice and model for our own receipt; never sent to Polar. */
    receipt?: AiUsageReceiptDetails;
  };
}

export interface TtsUsageResult {
  characters: number;
  creditsConsumed: number;
  /** The credit price in cents. Our price, not the provider cost Polar's `_cost` carries. */
  polarshCost: number;
  /** The credit price in USD, for display. Our price, not the provider cost Polar's `_cost` carries. */
  costUsd: number;
}

/**
 * Calculate TTS usage based on character count
 * Returns the usage metrics for tracking
 */
export function calculateTtsUsage(
  provider: string,
  characters: number,
): TtsUsageResult {
  const ratio = TTS_CREDITS_PER_CHARACTER[provider] ?? 100;
  const creditsConsumed = ratio > 0
    ? provider === "fish"
      ? Math.ceil(characters * ratio)
      : Math.ceil(characters / ratio)
    : 0;

  // The credit price in cents: 1000 credits = 1 cent.
  const polarshCost = creditsConsumed / 1000;
  // The credit price in USD: 1 credit = $0.00001.
  const costUsd = creditsConsumed * 0.00001;

  return {
    characters,
    creditsConsumed,
    polarshCost: Math.round(polarshCost * 100000) / 100000,
    costUsd: Math.round(costUsd * 100000) / 100000,
  };
}

/**
 * Track TTS usage in Dragonfly cache and send to Polar.sh
 */
export async function trackTtsUsage(
  options: TtsUsageTrackOptions,
): Promise<TtsUsageResult> {
  const { channelID, streamer, provider, characters, usage: usageContext } = options;

  const usage = calculateTtsUsage(provider, characters);

  const cacheClient = await getDragonflyClient("Messages");

  try {
    // Track in Dragonfly by provider
    await cacheClient.hIncrBy(
      `${channelID}:tts:usage`,
      `${provider}_characters`,
      characters,
    );
    await cacheClient.hIncrBy(
      `${channelID}:tts:usage`,
      `${provider}_credits`,
      usage.creditsConsumed,
    );
    await cacheClient.hIncrBy(
      `${channelID}:tts:usage`,
      `${provider}_cost`,
      Math.round(usage.costUsd * 100000),
    );
    await cacheClient.expire(
      `${channelID}:tts:usage`,
      generateTimeLeftToNextMonthInSeconds(),
    );

    // Track total as well
    await cacheClient.hIncrBy(
      `${channelID}:tts:usage`,
      "total_characters",
      characters,
    );
    await cacheClient.hIncrBy(
      `${channelID}:tts:usage`,
      "total_credits",
      usage.creditsConsumed,
    );
  } catch (err) {
    await error(
      {
        function: "trackTtsUsage",
        error: err instanceof Error ? err.message : String(err),
        channelID,
        provider,
        characters,
      },
      { channelId: channelID, destination: "both" },
    );
  }

  // Send to Polar.sh for billing
  if (streamer?.polar_sh_customer_id && usage.creditsConsumed > 0) {
    const customerId = streamer.polar_sh_customer_id;
    // One id for the local debit, the Polar event and the receipt, also when the line waits for its cost.
    const entryId = usageContext?.entryId || `aiu_${randomUUID()}`;
    const cost = provider === "piper"
      ? undefined
      : options.providerCost ?? { backend: provider, bytes: Buffer.byteLength(options.text, "utf8") };
    const event: TtsUsageEvent = {
      customerId,
      channelID,
      entryId,
      provider,
      credits: usage.creditsConsumed,
      characters,
      usage: {
        requestId: usageContext?.requestId,
        source: usageContext?.source,
        provider,
        quantity: characters,
        unit: "characters",
        resourceType: usageContext?.resourceType,
        resourceId: usageContext?.resourceId,
        // The receipt names the model that really spoke; Polar's event keeps its shape.
        receipt: { ...usageContext?.receipt, ...(options.providerCost ? { model: options.providerCost.backend } : {}) },
      },
    };

    // OpenRouter reports the charge only some seconds later: the line waits for it with its credits
    // already taken locally, and the `tts-usage` worker sends the event.
    if (cost?.generationId && provider !== "piper") {
      try {
        await parkTtsUsage({
          insert: (row) => TtsUsagePending.create(row),
          debit: (id, credits, externalId) => recordAiCreditUsage(id, credits, externalId),
        }, {
          entryId, channelID, customerId, provider, backend: cost.backend, generationId: cost.generationId,
          bytes: cost.bytes, characters, credits: usage.creditsConsumed, usage: event.usage,
        });
        return usage;
      } catch (err) {
        // Sending it now is safe even if the row did get stored: Polar and the local debit dedupe by entry.
        await error({ function: "trackTtsUsage", error: "Could not park voice usage; sending it with the list price",
          err: err instanceof Error ? err.message : String(err), channelID, provider }, { channelId: channelID, destination: "both" });
      }
    }

    const costUsd = cost && provider !== "piper" ? listPriceCostUsd(provider, cost.backend, cost.bytes) : 0;
    const ingestion = await sendTtsUsageEvent(event, costUsd);
    if (options.requireDurableUsage && ingestion.error) throw new Error('TTS usage recording unavailable');
  }

  return usage;
}

export interface TtsUsageEvent {
  customerId: string;
  channelID: string;
  entryId: string;
  provider: TtsUsageTrackOptions["provider"];
  /** Our fixed price per character. */
  credits: number;
  characters: number;
  usage: AiUsageContextInput;
}

/**
 * Sends one voice line's `ai_usage` event: `_cost` and `cost` are the provider charge in cents (what we
 * paid), `credits` the fixed price the streamer pays. The receipt gets the same provider cost.
 */
export function sendTtsUsageEvent(event: TtsUsageEvent, costUsd: number) {
  return ingestPolarSHEvent({
    customerId: event.customerId,
    channelID: event.channelID,
    cost: costUsd,
    credits: event.credits,
    characters: event.characters,
    reason: `tts_${event.provider}`,
    // The durable path projects the idempotent debit locally before trying
    // Polar and retains the exact event for replay when Polar is unavailable.
    mode: "batch",
    externalId: event.entryId,
    usage: { ...event.usage, receipt: { ...event.usage.receipt, costUsd } },
  });
}
