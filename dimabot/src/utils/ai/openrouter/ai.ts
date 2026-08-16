/**
 * AI Harness - Unified Entry Point
 *
 * A ReAct-style AI harness that uses OpenRouter's tool_calling feature.
 * The AI decides when to use tools (search, code_execution) and the harness
 * executes them, feeding results back to continue the conversation.
 */

import { randomBytes } from "crypto";
import toolsJson from "../tools.json" with { type: "json" };
import TwitchStreamers from "../../../classes/twitch_streamers.class.js";
import {
  ChannelAIPersonalitySchema,
  type IChannelAIPersonality,
} from "../../../schemas/channel_ai_personality.schema.js";
import { formatBadges, type IBadge } from "../../badges.js";
import { getDragonflyClient } from "../../databases/dragonfly.database.js";
import { ingestPolarSHEvent } from "../../polarsh.js";
import { constructChatSystemMessages } from "../prompts.ai.js";
import { MODELS, TOKEN_LIMITS } from "../constants.js";
import { createFetchWithRetry } from "../fetch.utils.js";
import {
  executeTool,
  getToolDefinitions,
  type ToolContext,
  type ToolResult,
} from "../tools/index.js";
import { error, debug } from "../../logger.js";
import {
  retrieveSemanticChatContext,
  getSemanticMemoryLimitForTier,
} from "../../qdrant/functions/chat_logs/retrieve_chat_context.qdrant.js";
import { retrieveChannelMemoryContext } from "../../qdrant/functions/memory/retrieve_memory_context.qdrant.js";
import {
  getKnownUserMemoryContext,
  recordChannelMemoryUsage,
  validateChannelMemoryContext,
} from "../memory/memory.service.js";
import type { ChatMemoryContext } from "../prompts.ai.js";

const OPENROUTER_TIMEOUT = 30000;
const fetchWithRetry = createFetchWithRetry({
  timeout: OPENROUTER_TIMEOUT,
  retries: 3,
});

// ============================================================================
// UUID v7 GENERATOR
// ============================================================================

/**
 * Generates a UUIDv7 (timestamp-ordered UUID) for tracing
 */
function generateUUIDv7(): string {
  const now = Date.now();
  const timestampHex = now.toString(16).padStart(12, "0");

  // Generate random bytes for the non-timestamp parts
  const random1 = randomBytes(5).toString("hex");
  const random2 = randomBytes(6).toString("hex");

  // Format: tttttttt-tttt-7xxx-xxxx-xxxxxxxxxxxx
  // timestamp (8 hex) - timestamp (4 hex) - version 7 (1 hex) + random (3 hex) - random (4 hex) - random (12 hex)
  return `${timestampHex.slice(0, 8)}-${timestampHex.slice(8, 12)}-7${random1.slice(0, 3)}-${random1.slice(3, 7)}-${random2}`;
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

// Re-exported from tools for convenience
export type {
  ICodePlanResult,
  ICodeGenerationResult,
  ISandboxExecutionResult,
} from "../tools/code_execution.tool.js";
export type { SearchResult, SearchToolResult } from "../tools/search.tool.js";

export interface IAIDecision {
  action: "respond" | "search" | "code";
  query?: string;
  request?: string;
}

export interface IToolContext {
  name: string;
  context: any;
}

export interface ISearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface IStreamerData {
  user_id?: string;
  name?: string;
  plan_tier?: "free" | "premium" | "pro";
  polar_sh_customer_id?: string;
  bot_token?: string;
  [key: string]: any;
}

export interface IChatHistoryMessage {
  timestamp: number;
  badges?: string;
  username: string;
  message: string;
}

export interface ISemanticChatHistoryItem {
  source: "live" | "semantic";
  timestamp: number;
  badges?: string;
  username: string;
  message: string;
  relevanceScore?: number;
}

export interface IChatMessageTags {
  badges: IBadge[];
  chatter_user_name?: string;
  chatter_user_login?: string;
  username?: string;
  [key: string]: any;
}

export interface IRouterResponse {
  error: boolean;
  message?: string;
  status?: number;
  type?: string;
}

export interface AIHarnessOptions {
  channelID: string;
  message: string;
  streamer: IStreamerData;
  history?: IChatHistoryMessage[];
  tags?: IChatMessageTags;
  options?: Record<string, any>[];
}

interface IUsageData {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_details?: {
    upstream_inference_prompt_cost?: number;
    upstream_inference_completions_cost?: number;
  };
}

interface IOpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface IOpenRouterResponse {
  choices?: Array<{
    message?: IOpenRouterMessage;
    finish_reason?: string;
  }>;
  usage?: IUsageData;
  error?: boolean;
  message?: string;
  status?: number;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: any;
}

// ============================================================================
// ERROR EXTRACTION HELPERS
// ============================================================================

/**
 * OpenRouter error response can come in different formats:
 * 1. { error: true, message: "string", status: number } - custom format from some routes
 * 2. { error: { message: "string", type: "string", code: "string" } } - OpenRouter standard error
 * 3. { message: "string", status: number } - top-level error
 */
interface OpenRouterErrorResponse {
  error?: boolean | { message?: string; type?: string; code?: string };
  message?: string;
  status?: number;
}

export interface ExtractedError {
  message: string;
  type?: string;
  code?: string;
  status?: number;
}

export function extractOpenRouterError(data: unknown): ExtractedError {
  const result: ExtractedError = { message: "Unknown error" };

  if (!data || typeof data !== "object") {
    return result;
  }

  const d = data as Record<string, unknown>;

  // Handle case 1: { error: true, message: "string", status: number }
  if (d.error === true && typeof d.message === "string") {
    result.message = d.message;
    result.status = typeof d.status === "number" ? d.status : undefined;
    return result;
  }

  // Handle case 2: { error: { message, type, code } } - OpenRouter standard error
  if (d.error && typeof d.error === "object") {
    const errorObj = d.error as Record<string, unknown>;
    result.message =
      typeof errorObj.message === "string" ? errorObj.message : result.message;
    result.type = typeof errorObj.type === "string" ? errorObj.type : undefined;
    result.code = typeof errorObj.code === "string" ? errorObj.code : undefined;
    return result;
  }

  // Handle case 3: { message: "string", status: number }
  if (typeof d.message === "string") {
    result.message = d.message;
    result.status = typeof d.status === "number" ? d.status : undefined;
  }

  return result;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function selectModel(streamer: IStreamerData | null | undefined): string {
  if (streamer?.plan_tier === "pro") {
    return MODELS.pro;
  }
  if (streamer?.plan_tier === "premium") {
    return MODELS.premium;
  }
  return MODELS.free;
}

function getTokenLimit(model: string): number {
  return (
    TOKEN_LIMITS[model as keyof typeof TOKEN_LIMITS] || TOKEN_LIMITS.default
  );
}

function generateTimeLeftToNextMonthInSeconds(): number {
  const now = new Date();
  const dayOfMonth = now.getDate();
  const timeLeft = 30 - dayOfMonth;

  const timeLeftInSeconds =
    timeLeft * 24 * 3600 -
    now.getHours() * 3600 -
    now.getMinutes() * 60 -
    now.getSeconds() -
    now.getMilliseconds();

  return Math.max(timeLeftInSeconds, 3600);
}

// ============================================================================
// SEMANTIC CHAT HISTORY HELPERS
// ============================================================================

/**
 * Get the effective semantic history limit based on tier and user preference
 */
function getEffectiveSemanticLimit(
  planTier: string | undefined,
  userLimit: number | null | undefined,
): number {
  const defaultLimit = getSemanticMemoryLimitForTier(planTier || "free");
  const effectiveLimit = userLimit ?? defaultLimit;
  return Math.min(effectiveLimit, 30); // Cap at 30 (user's future UI max)
}

/**
 * Get the combined chat history limit based on tier
 * This is the max total messages (live + semantic) we send to the LLM
 */
function getCombinedHistoryLimitForTier(planTier: string | undefined): number {
  if (planTier === "pro") return 100;
  if (planTier === "premium") return 35;
  return 15;
}

function getMemoryContextLimitsForTier(planTier: string | undefined): {
  channel: number;
  currentUser: number;
} {
  if (planTier === "pro") return { channel: 6, currentUser: 5 };
  if (planTier === "premium") return { channel: 4, currentUser: 3 };
  return { channel: 2, currentUser: 2 };
}

/**
 * Merge live (Redis) and semantic (Qdrant) chat histories
 * - Live messages are always included (recency/freshness)
 * - Semantic messages are added if not duplicates
 * - Results sorted by timestamp, newest first
 * - Total limited by tier-based cap
 */
function mergeChatHistories(
  liveHistory: ISemanticChatHistoryItem[],
  semanticHistory: ISemanticChatHistoryItem[],
  maxLimit: number,
): ISemanticChatHistoryItem[] {
  // Use a Map to deduplicate by message content, preferring live version
  const uniqueByMessage = new Map<string, ISemanticChatHistoryItem>();

  // First add all live messages (they take priority)
  for (const item of liveHistory) {
    uniqueByMessage.set(item.message.toLowerCase(), item);
  }

  // Then add semantic messages that aren't duplicates
  for (const item of semanticHistory) {
    const key = item.message.toLowerCase();
    if (!uniqueByMessage.has(key)) {
      uniqueByMessage.set(key, item);
    }
  }

  // Convert to array and sort by timestamp (newest first)
  const merged = Array.from(uniqueByMessage.values()).sort(
    (a, b) => b.timestamp - a.timestamp,
  );

  return merged.slice(0, maxLimit);
}

export async function getChannelPersonality(
  channelID: string,
): Promise<IChannelAIPersonality | null> {
  const cacheClient = await getDragonflyClient("Messages");
  const streamer = await TwitchStreamers.getTwitchAccountById(channelID);

  // Try cache first
  let personality = await cacheClient.get(
    `twitch:${channelID}:chatbot:personality`,
  );
  if (personality) {
    return JSON.parse(personality) as unknown as IChannelAIPersonality;
  }

  // Try database
  const dbPersonality = await ChannelAIPersonalitySchema.findOne({
    channelID: channelID,
  });
  if (dbPersonality) {
    await cacheClient.setEx(
      `twitch:${channelID}:chatbot:personality`,
      10800,
      JSON.stringify(dbPersonality),
    );
    return dbPersonality;
  }

  // Create default personality for new channels
  const contextWindow =
    streamer?.plan_tier === "pro"
      ? 35
      : streamer?.plan_tier === "premium"
        ? 15
        : 7;

  const newPersonality = await ChannelAIPersonalitySchema.create({
    channelID,
    channel: streamer?.name || "Unknown",
    contextWindow,
    personality: `You are a friendly and playful Twitch chat moderator for ${streamer?.name || "this channel"}. You speak in Spanish by default but can adapt to other languages. You have a good sense of humor and enjoy interacting with chat users. You maintain a fun and engaging atmosphere while still being able to moderate when necessary.`,
    rules: ["Be respectful and friendly with users"],
    knownUsers: [
      {
        username: "cdom201",
        description: "Creator, Owner and Developer of you, bot",
        relationship: "professional",
        lastInteraction: new Date(),
      },
    ],
  });

  if (newPersonality) {
    await cacheClient.setEx(
      `twitch:${channelID}:chatbot:personality`,
      10800,
      JSON.stringify(newPersonality),
    );
    await debug(
      {
        message: "[AI Harness] Created default channel personality",
        channelID,
        channel: streamer?.name || "Unknown",
        planTier: streamer?.plan_tier || "free",
        contextWindow,
      },
      { channelId: channelID, destination: "both" },
    );
  }

  return newPersonality;
}

// ============================================================================
// DEFAULT PERSONALITY FALLBACK
// ============================================================================

function getDefaultPersonality(
  channelID: string,
  streamer: IStreamerData | null,
): IChannelAIPersonality {
  return {
    _id: undefined as any,
    channelID,
    channel: streamer?.name || "Unknown",
    enabled: true,
    streamSummariesEnabled: true,
    recommendationsEnabled: true,
    profiles: [],
    activeProfileId: "",
    personality: `You are a friendly and playful Twitch chat moderator for this channel. You speak in Spanish by default but can adapt to other languages. You have a good sense of humor and enjoy interacting with chat users. You maintain a fun and engaging atmosphere while still being able to moderate when necessary.`,
    personaMode: "original",
    personaReference: "",
    tonePreset: "balanced",
    language: null,
    voiceProfile: {
      tone: "friendly and playful",
      cadence: "short and dynamic",
      style: "chat-native and expressive",
      catchphrases: [],
    },
    learningConfig: {
      enabled: true,
      autoConfirmEnabled: true,
      autoConfirmThreshold: 0.82,
      minMessageLength: 12,
      maxPendingMemories: 250,
      maxConfirmedMemories: 2000,
      postStreamSummaryEnabled: true,
      weeklyMaintenanceEnabled: true,
      monthlyMaintenanceEnabled: true,
      autoApplyCreates: true,
      autoApplyEdits: true,
      autoApplyArchives: true,
      autoApplyPermanentDeletes: true,
      summaryMinDurationMinutes: 20,
      summaryMinChatMessages: 30,
      createMinConfidence: 0.72,
      editMinConfidence: 0.74,
      archiveMinConfidence: 0.8,
      deleteMinConfidence: 0.88,
      maxActionsPerRun: 20,
      maxDeletesPerRun: 5,
      minMemoryAgeDaysForDelete: 30,
      minUnusedDaysForDelete: 21,
      semanticChatHistoryEnabled: true,
      semanticChatHistoryLimit: null,
      semanticChatHistoryPrimaryMinScore: 0.75,
      semanticChatHistoryFallbackMinScore: 0.69,
    },
    memoryPolicy: {
      prioritizeRecentChat: true,
      allowSensitiveMemories: false,
      allowUserPreferenceMemories: true,
      allowRunningJokes: true,
    },
    rules: ["Be respectful and friendly with users"],
    knownUsers: [
      {
        username: "cdom201",
        description: "Creator, Owner and Developer of you, bot",
        relationship: "professional",
        lastInteraction: new Date(),
      },
    ],
    contextWindow: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ============================================================================
// OPENROUTER API CALL
// ============================================================================

async function callOpenRouter(
  model: string,
  messages: IOpenRouterMessage[],
  tools: any[],
  channelID: string,
  streamer: IStreamerData,
  maxTokens: number,
  sessionId: string,
  traceId: string,
  extraOptions: Record<string, any> = {},
): Promise<IOpenRouterResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "HTTP-Referer": "https://domdimabot.com",
    "X-OpenRouter-Title": "DomDimaBot",
    "X-OpenRouter-Description":
      "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.",
    "X-Trace-ID": traceId,
    "X-OpenRouter-Categories": "general-chat, roleplay",
  };

  const body: any = {
    model,
    messages,
    tools,
    max_tokens: maxTokens,
    user: `${channelID}`,
    usage: {
      include: true,
    },
    session_id: sessionId,
    trace: {
      trace_id: traceId,
    },
    ...extraOptions,
  };

  debug(
    {
      message: "[AI Harness] Calling OpenRouter",
      sessionId,
      traceId,
      model,
      messageCount: messages.length,
      toolCount: tools.length,
    },
    { channelId: channelID, destination: "console" },
  );

  const response = await fetchWithRetry(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );

  // Check for HTTP errors before parsing JSON
  if (!response.ok) {
    const errorText = await response.text();
    await error(
      {
        function: "callOpenRouter",
        error: "OpenRouter HTTP error",
        status: response.status,
        statusText: response.statusText,
        errorBody: errorText,
        model,
        channelId: channelID,
      },
      { channelId: channelID, destination: "both" },
    );

    return {
      error: true,
      message: `OpenRouter API error: ${response.status} ${response.statusText}`,
      status: response.status,
    } as unknown as IOpenRouterResponse;
  }

  const data: IOpenRouterResponse = await response.json();
  return data;
}

// ============================================================================
// TRACK USAGE
// ============================================================================

async function trackUsage(
  channelID: string,
  streamer: IStreamerData,
  usageData: IUsageData | undefined,
  model: string,
  reason: string,
): Promise<void> {
  if (!usageData || !channelID) return;

  const cacheClient = await getDragonflyClient("Messages");

  try {
    await cacheClient.hIncrBy(
      `${channelID}:chatbot:usage`,
      "total_tokens",
      usageData.total_tokens || 0,
    );
    await cacheClient.hIncrBy(
      `${channelID}:chatbot:usage`,
      "prompt_tokens",
      usageData.prompt_tokens || 0,
    );
    await cacheClient.hIncrBy(
      `${channelID}:chatbot:usage`,
      "completion_tokens",
      usageData.completion_tokens || 0,
    );
    await cacheClient.expire(
      `${channelID}:chatbot:usage`,
      generateTimeLeftToNextMonthInSeconds(),
    );
  } catch (cacheError) {
    await error(
      {
        function: "trackUsage",
        error: "Cache error tracking AI usage",
        err:
          cacheError instanceof Error ? cacheError.message : String(cacheError),
      },
      { channelId: channelID, destination: "both" },
    );
  }

  const actualCost =
    (usageData?.cost_details?.upstream_inference_prompt_cost || 0) +
    (usageData?.cost_details?.upstream_inference_completions_cost || 0);

  if (streamer?.polar_sh_customer_id) {
    ingestPolarSHEvent({
      customerId: streamer.polar_sh_customer_id,
      channelID: channelID,
      cost: actualCost,
      reason,
      llm: {
        model,
        usage: usageData,
      },
      mode: "batch",
    });
  }
}

// ============================================================================
// MAIN HARNESS
// ============================================================================

const MAX_TOOL_CALLS = 5; // Prevent infinite loops

/**
 * Main entry point for AI chat with tool capabilities.
 * Uses OpenRouter's tool_calling feature to let the AI decide when to use tools.
 */
export async function chat(
  options: AIHarnessOptions,
): Promise<IRouterResponse> {
  const {
    channelID,
    message,
    streamer,
    history = [],
    tags = { badges: [] },
    options: extraOptions = [],
  } = options;

  const cacheClient = await getDragonflyClient("Messages");

  // Check if user has exhausted AI credits
  const isExhausted = await cacheClient.exists(`${channelID}:ai:exhaust`);

  // Get streamer and personality data
  const streamerData = await TwitchStreamers.getTwitchAccountById(channelID);
  const personality = await getChannelPersonality(channelID);

  // Handle missing personality (fallback)
  const effectivePersonality =
    personality || getDefaultPersonality(channelID, streamerData);

  if (effectivePersonality.enabled === false) {
    return {
      error: true,
      message: "AI chat responses are disabled for this channel",
    };
  }

  // Select model based on streamer tier
  const selectedModel = isExhausted ? MODELS.free : selectModel(streamer);
  const maxTokens = getTokenLimit(selectedModel);

  // Generate tracing IDs for this conversation
  const sessionId = generateUUIDv7();
  const traceId = generateUUIDv7();

  // Build user context from EventSub message structure
  const { formattedBadges } = await formatBadges({
    badges: tags?.badges || [],
  });
  const userContext = {
    username:
      tags?.username ||
      tags?.chatter_user_name ||
      tags?.chatter_user_login ||
      "Anonymous",
    userID: String(tags?.chatter_user_id || tags?.userID || tags?.id || ""),
    badges: formattedBadges,
  };

  // Build chat history context (live/recent messages from Redis)
  const liveHistory: ISemanticChatHistoryItem[] = history.map((msg) => ({
    source: "live" as const,
    timestamp: msg.timestamp,
    badges: msg.badges || "",
    username: msg.username,
    message: msg.message,
  }));

  // Check if semantic chat history is enabled
  const semanticEnabled =
    effectivePersonality?.learningConfig?.semanticChatHistoryEnabled ?? true;
  let semanticHistory: ISemanticChatHistoryItem[] = [];

  if (semanticEnabled) {
    const effectiveLimit = getEffectiveSemanticLimit(
      streamer?.plan_tier,
      effectivePersonality?.learningConfig?.semanticChatHistoryLimit ?? null,
    );

    try {
      const semanticResult = await retrieveSemanticChatContext({
        channelID,
        query: message, // Use the current message as the search query
        limit: effectiveLimit,
        primaryMinScore:
          effectivePersonality?.learningConfig
            ?.semanticChatHistoryPrimaryMinScore ?? 0.75,
        fallbackMinScore:
          effectivePersonality?.learningConfig
            ?.semanticChatHistoryFallbackMinScore ?? 0.69,
      });

      if (!semanticResult.error && semanticResult.items.length > 0) {
        semanticHistory = semanticResult.items.map((item) => ({
          source: "semantic" as const,
          timestamp: item.timestamp,
          badges: "",
          username: item.username,
          message: item.message,
          relevanceScore: item.score,
        }));

        await debug(
          {
            message: "[AI Harness] Semantic chat history retrieved",
            channelID,
            semanticCount: semanticHistory.length,
            liveCount: liveHistory.length,
          },
          { channelId: channelID, destination: "console" },
        );
      }
    } catch (semanticError) {
      // Don't fail the whole request if semantic retrieval fails
      await error(
        {
          function: "chat.semanticRetrieval",
          error:
            semanticError instanceof Error
              ? semanticError.message
              : String(semanticError),
          channelID,
        },
        { channelId: channelID, destination: "both" },
      );
    }
  }

  const memoryLimits = getMemoryContextLimitsForTier(streamer?.plan_tier);
  const memoryPolicy = effectivePersonality.memoryPolicy;
  const effectiveMemoryPolicy = {
    allowSensitiveMemories: memoryPolicy?.allowSensitiveMemories ?? false,
    allowUserPreferenceMemories:
      memoryPolicy?.allowUserPreferenceMemories ?? true,
    allowRunningJokes: memoryPolicy?.allowRunningJokes ?? true,
  };
  let memoryContext: ChatMemoryContext = {
    channelMemories: [],
    currentUserFacts: [],
  };

  try {
    const [channelMemoryResult, currentUserFacts] = await Promise.all([
      retrieveChannelMemoryContext({
        channelID,
        query: message,
        limit: memoryLimits.channel,
      }),
      memoryPolicy?.allowUserPreferenceMemories === false
        ? Promise.resolve([])
        : getKnownUserMemoryContext({
            channelID,
            userID: userContext.userID,
            limit: memoryLimits.currentUser,
            allowSensitiveMemories:
              effectiveMemoryPolicy.allowSensitiveMemories,
          }),
    ]);

    if (!channelMemoryResult.error) {
      const validatedMemories = await validateChannelMemoryContext({
        channelID,
        candidates: channelMemoryResult.items.map((item) => ({
          memory_id: item.memory_id,
          score: item.score,
        })),
        limit: memoryLimits.channel,
        policy: effectiveMemoryPolicy,
      });
      memoryContext.channelMemories = validatedMemories
        .map((item) => ({
          memoryID: item.memory_id,
          type: item.memory_type,
          summary: item.summary,
          relevanceScore: item.score,
        }));
    }

    memoryContext.currentUserFacts = currentUserFacts.map((item) => ({
      memoryID: item.memory_id,
      type: item.memory_type,
      summary: item.summary,
    }));

    const memoryIDs = [
      ...memoryContext.channelMemories,
      ...memoryContext.currentUserFacts,
    ].map((item) => item.memoryID);
    void recordChannelMemoryUsage(channelID, memoryIDs);

    await debug(
      {
        message: "[AI Harness] Confirmed memory context retrieved",
        channelID,
        channelMemoryCount: memoryContext.channelMemories.length,
        currentUserFactCount: memoryContext.currentUserFacts.length,
      },
      { channelId: channelID, destination: "console" },
    );
  } catch (memoryError) {
    await error(
      {
        function: "chat.memoryRetrieval",
        error:
          memoryError instanceof Error
            ? memoryError.message
            : String(memoryError),
        channelID,
      },
      { channelId: channelID, destination: "both" },
    );
  }

  // Get combined history limit based on tier
  const combinedLimit = getCombinedHistoryLimitForTier(streamer?.plan_tier);

  // Merge live and semantic histories
  const chatHistory = mergeChatHistories(
    liveHistory,
    semanticHistory,
    combinedLimit,
  );

  // Use shared utility to construct messages (no tools yet at this stage)
  // constructChatSystemMessages returns: [system_message, user_message_with_prompt]
  const systemMessages = constructChatSystemMessages(
    streamerData,
    effectivePersonality,
    userContext,
    message,
    chatHistory,
    [], // tool context will be added by AI as needed
    memoryContext,
  );

  // Convert to OpenRouter message format
  const messages: IOpenRouterMessage[] = systemMessages.map((msg) => ({
    role: msg.role as "system" | "user" | "assistant",
    content: msg.content,
  }));

  // Get tool definitions
  const toolDefinitions = getToolDefinitions();

  // Track tool calls to prevent infinite loops
  let toolCallCount = 0;

  // Main AI loop
  while (toolCallCount < MAX_TOOL_CALLS) {
    // Make API call with tools
    const data = await callOpenRouter(
      selectedModel,
      messages,
      toolDefinitions,
      channelID,
      streamer,
      maxTokens,
      sessionId,
      traceId,
      extraOptions.reduce((acc, opt) => ({ ...acc, ...opt }), {}),
    );

    // Handle API errors
    if (data.error) {
      const extractedError = extractOpenRouterError(data);
      await error(
        {
          function: "aiHarness",
          error: "OpenRouter API error",
          openRouterResponse: data,
          extractedError,
          sessionId,
          traceId,
          model: selectedModel,
          channelId: channelID,
        },
        { channelId: channelID, destination: "both" },
      );

      return {
        error: true,
        message: extractedError.message || "API error occurred",
        status: extractedError.status || data.status,
        type: extractedError.type || extractedError.code || "api_error",
      };
    }

    const choice = data.choices?.[0];
    const assistantMessage = choice?.message;
    const hasToolCalls =
      assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0;

    // Track usage with appropriate reason based on whether AI called tools
    if (data.usage) {
      const reason = hasToolCalls ? "harness_tools" : "harness_end";
      await trackUsage(channelID, streamer, data.usage, selectedModel, reason);
    }

    // No tool calls - return the response
    if (!hasToolCalls) {
      const content = assistantMessage?.content || "";

      // Store last response for debugging
      if (channelID) {
        await cacheClient.set(
          `${channelID}:chatbot:response:last`,
          JSON.stringify({
            messageData: { content },
            usageData: data.usage,
            model: selectedModel,
            timestamp: new Date().toISOString(),
          }),
        );
      }

      return {
        error: false,
        message: content,
      };
    }

    // Process tool calls
    const toolCalls: ToolCall[] = assistantMessage!.tool_calls!.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    debug(
      {
        message: "[AI Harness] AI requested tool calls",
        toolCalls: toolCalls.map((tc) => tc.name),
        sessionId,
        traceId,
      },
      { channelId: channelID, destination: "console" },
    );

    // Add assistant's tool call message to conversation
    messages.push(assistantMessage);

    // Execute each tool and add results
    for (const toolCall of toolCalls) {
      toolCallCount++;

      if (toolCallCount >= MAX_TOOL_CALLS) {
        debug(
          {
            message: "[AI Harness] Max tool calls reached, stopping",
            sessionId,
            traceId,
          },
          { channelId: channelID, destination: "console" },
        );
        break;
      }

      const toolContext: ToolContext = {
        channelID,
        streamer: streamerData || streamer,
        username: userContext.username,
        userID: userContext.userID,
        tags,
      };

      const result = await executeTool(
        toolCall.name,
        toolCall.arguments,
        toolContext,
      );

      // Add tool result to messages
      const toolResultMessage: IOpenRouterMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      };

      messages.push(toolResultMessage);

      debug(
        {
          message: "[AI Harness] Tool executed",
          toolName: toolCall.name,
          success: result.success,
          sessionId,
          traceId,
        },
        { channelId: channelID, destination: "console" },
      );
    }

    // If we hit max tool calls, break and return what we have
    if (toolCallCount >= MAX_TOOL_CALLS) {
      break;
    }
  }

  // Made too many tool calls - return an error or continue without tools
  debug(
    {
      message: "[AI Harness] Max tool calls exceeded, making final request",
      sessionId,
      traceId,
    },
    { channelId: channelID, destination: "console" },
  );

  // Make one final call without tools to get a response
  const finalData = await callOpenRouter(
    selectedModel,
    messages,
    [], // no tools
    channelID,
    streamer,
    maxTokens,
    sessionId,
    traceId,
  );

  if (finalData.error) {
    const extractedError = extractOpenRouterError(finalData);
    await error(
      {
        function: "aiHarness.final",
        error: "OpenRouter API error after tool execution",
        openRouterResponse: finalData,
        extractedError,
        sessionId,
        traceId,
        model: selectedModel,
        channelId: channelID,
      },
      { channelId: channelID, destination: "both" },
    );

    return {
      error: true,
      message: extractedError.message || "AI error after tool execution",
      status: extractedError.status || finalData.status,
    };
  }

  const finalContent = finalData.choices?.[0]?.message?.content || "";

  // Track final usage
  if (finalData.usage) {
    await trackUsage(
      channelID,
      streamer,
      finalData.usage,
      selectedModel,
      "harness_end",
    );
  }

  return {
    error: false,
    message: finalContent,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export { MODELS, TOKEN_LIMITS };
