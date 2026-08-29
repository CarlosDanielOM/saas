import { getDragonflyClient } from "./databases/dragonfly.database.js";
import { ingestPolarSHEvent } from "./polarsh.js";
import { error } from "./logger.js";

/**
 * TTS character to credit conversion rates
 * These define how many characters equal 1 AI credit for each provider
 * One credit is approximate to 0.001 cent of USD so 0.00001 USD per AI token
 */
const TTS_CREDITS_PER_CHARACTER: Record<string, number> = {
  piper: 100, // Local, Cheaper cost for users
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
  provider: "piper" | "fish";
  characters: number;
  text: string;
}

export interface TtsUsageResult {
  characters: number;
  creditsConsumed: number;
  /** For Polar.sh _cost field (1 = 1 cent) */
  polarshCost: number;
  /** For Polar.sh cost field (in USD) and visual display */
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

  // Polar.sh _cost: 1 = 1 cent, so credits / 1000 (1000 credits = 1 cent = $0.01 USD)
  const polarshCost = creditsConsumed / 1000;
  // Polar.sh cost and visual display: in USD (1 credit = $0.00001 USD = 0.001 cent)
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
  const { channelID, streamer, provider, characters, text } = options;

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
  if (streamer?.polar_sh_customer_id && usage.polarshCost > 0) {
    ingestPolarSHEvent({
      customerId: streamer.polar_sh_customer_id,
      channelID,
      cost: usage.costUsd,
      _cost: usage.polarshCost,
      characters,
      reason: `tts_${provider}`,
      mode: "immediate",
    });
  }

  return usage;
}
