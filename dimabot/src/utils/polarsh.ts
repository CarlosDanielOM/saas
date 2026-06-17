import { Polar } from "@polar-sh/sdk";
import { getDragonflyClient } from "./databases/dragonfly.database.js";
import { error, info } from "./logger.js";

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
      name: "ai_credits",
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

      if (ingestResult.error) {
        return {
          error: true,
          message: "PolarSH ingest error",
          details: ingestResult,
        };
      }

      return { error: false };
    }

    let ingestData: EventData[] = [];
    const storedEvents = await cacheClient.get(cacheKey);
    try {
      ingestData = storedEvents ? JSON.parse(storedEvents) : [];
    } catch (err) {
      await error(
        {
          function: "ingestPolarSHEvent",
          error: "Failed to parse stored AI events",
          err: err instanceof Error ? err.message : String(err),
        },
        { channelId: channelID, destination: "both" },
      );
      ingestData = [];
    }

    ingestData.push(eventData);

    if (mode === "cache") {
      await cacheClient.set(cacheKey, JSON.stringify(ingestData));
      return { error: false };
    }

    const polarshClientInstance = await getPolarShClient(
      "ingestPolarSHEvent batch/cache mode",
    );

    polarshClientInstance.events
      .ingest({
        events: ingestData,
      })
      .then(() => {
        cacheClient.del(cacheKey);
      })
      .catch((err) => {
        error(
          {
            function: "ingestPolarSHEvent",
            error: "PolarSH ingest error",
            err: err instanceof Error ? err.message : String(err),
          },
          { channelId: channelID, destination: "both" },
        );
      });

    return { error: false };
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
          name: "ai_credits",
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

    if (ingestResult?.error) {
      return {
        error: true,
        message: "PolarSH grant credits ingest error",
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
