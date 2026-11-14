/**
 * Site agent ("Dima assistant") shared contracts. Every module in `site_agent/` and the dimasite
 * client (`dimasite/src/app/features/assistant/assistant.types.ts`, which mirrors the wire part)
 * builds against these types. See `dimabot/SITE_AGENT.md`.
 */

export type PlanTier = 'free' | 'premium' | 'pro';
export type Lang = 'en' | 'es';
export type JsonSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Model context (provider-neutral). Stored per session; compaction rewrites it.
// ---------------------------------------------------------------------------

export interface ToolCallRequest {
    id: string;
    name: string;
    /** Raw JSON text exactly as the model produced it. */
    arguments: string;
}

/** Opaque provider reasoning kept so multi-step tool calls keep their chain of thought. */
export interface ReasoningCarry {
    provider: 'openrouter';
    model: string;
    details: unknown[];
    /**
     * `promptHash` of the request that produced it (tools + messages). Claude models only get the reasoning
     * back while the history before it still hashes the same (see `toMessages`).
     */
    prefixHash?: string;
    /** Claude: the step's reasoning tokens. Replayed thinking is billed at this size, so estimates use it. */
    tokens?: number;
}

export type ContextItem =
    | { role: 'user'; content: string; at: number }
    | { role: 'assistant'; content: string | null; toolCalls?: ToolCallRequest[]; reasoning?: ReasoningCarry; at: number }
    | { role: 'tool'; toolCallId: string; name: string; content: string; at: number }
    /** Compaction summary. Sent to the model as a user message labelled as data. */
    | { role: 'summary'; content: string; covers: number; at: number };

// ---------------------------------------------------------------------------
// LLM client (site_agent/llm/openrouter.ts)
// ---------------------------------------------------------------------------

export interface LlmToolDefinition {
    name: string;
    description: string;
    parameters: JsonSchema;
}

export type LlmMessage =
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; reasoning_details?: unknown[] }
    | { role: 'tool'; tool_call_id: string; content: string };

export interface LlmRequest {
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh';
    messages: LlmMessage[];
    tools?: LlmToolDefinition[];
    toolChoice?: 'auto' | 'none';
    /** Sent as OpenRouter session_id/user for cache affinity and tracing (session id, never a login). */
    sessionKey: string;
    maxOutputTokens?: number;
    /** Claude models: mark the prompt for caching (default true). Off for one-off calls such as compaction. */
    promptCache?: boolean;
    signal?: AbortSignal;
}

export interface LlmUsage {
    promptTokens: number;
    cachedTokens: number;
    /** Prompt tokens written to the cache (Claude bills them at 1.25× input). Only set when > 0. */
    cacheWriteTokens?: number;
    completionTokens: number;
    reasoningTokens: number;
    /** What OpenAI charges the BYOK key (cost_details.upstream_inference_cost). */
    upstreamCostUsd: number | null;
    /** OpenRouter's own fee (usage.cost; 0 for BYOK within the free allowance). */
    routerCostUsd: number | null;
    /** 'reported' = from the stream, 'reconciled' = from /generation later, 'estimated' = tokens × price. */
    source: 'reported' | 'reconciled' | 'estimated' | 'unknown';
    isByok: boolean | null;
}

export interface LlmStreamHandlers {
    /** Visible answer text. */
    onText?: (delta: string) => void;
    /** Reasoning summary text (never shown verbatim; used for the "thinking" status). */
    onReasoning?: (delta: string) => void;
}

export interface LlmStepResult {
    generationId: string | null;
    provider: string | null;
    content: string;
    toolCalls: ToolCallRequest[];
    reasoning: unknown[];
    finishReason: string | null;
    /** The provider's own stop reason (Anthropic: 'end_turn', 'tool_use', 'refusal'…). */
    nativeFinishReason: string | null;
    /** The provider's safety filter declined (finish_reason 'content_filter' / native 'refusal' / a refusal text). */
    refused: boolean;
    /** Refusal text the provider sent with it, if any. */
    refusal: string | null;
    /** null when the stream ended without a usage chunk (e.g. aborted); reconcile later. */
    usage: LlmUsage | null;
    aborted: boolean;
    durationMs: number;
}

/** 'refused' = a provider or OpenRouter safety filter declined (403 refusal/moderation, or the same mid-stream). */
export type LlmErrorKind = 'config' | 'aborted' | 'timeout' | 'rate_limited' | 'overloaded' | 'bad_request' | 'context_too_long' | 'refused' | 'upstream' | 'incomplete';

// ---------------------------------------------------------------------------
// Tools (site_agent/tools/*)
// ---------------------------------------------------------------------------

export type ToolKind = 'knowledge' | 'read' | 'ui' | 'write' | 'stream';

export interface Requester {
    id: string;
    login: string;
    displayName: string;
}

export interface PageContext {
    /** Route key from navigation.ts (e.g. "modules.tts"), or null when unknown. */
    route: string | null;
    /** Path as the browser shows it, e.g. "/cdom201/modules/tts". */
    path: string;
    title?: string;
}

export interface ToolContext {
    channelId: string;
    channelLogin: string;
    requester: Requester;
    role: 'owner' | 'admin';
    plan: PlanTier;
    lang: Lang;
    sessionId: string;
    turnId: string;
    callId: string;
    /** The user message that started this turn (stored with changes in the change log). */
    userMessage: string;
    page: PageContext | null;
    signal: AbortSignal;
    /** True only if the requester holds EVERY permission (owner/global admin always true). */
    can(permissions: readonly string[]): Promise<boolean>;
    /** Set when the call comes through MCP (`tools/execute.ts`): the OAuth client and the scopes its token holds. */
    mcp?: { clientId: string; clientName: string; scopes: readonly string[] };
}

/** A change the user must approve. Serializable: it is stored on the turn while waiting. */
export interface ChangeProposal {
    /** Tool that created it; its `apply` runs after approval. */
    tool: string;
    /** Short title, e.g. "Create command !dice". In the user's language. */
    title: string;
    /** Area key used by the change log filter, e.g. "commands", "timers", "tts". */
    area: string;
    target: { type: string; id: string | null; label: string };
    /** Display-safe snapshots for the before → after card (null = does not exist). */
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    /** What the change can do on stream/Twitch, e.g. "Can time out viewers" (dry-run based). */
    effects: string[];
    /** Extra warnings shown on the card. */
    warnings?: string[];
    /** Permissions re-checked right before apply (ALL required). */
    permissions: string[];
    /** Tool-private data apply() needs (validated input + expected current state for compare-and-set). */
    payload: Record<string, unknown>;
}

export interface ChangeRecordInput {
    area: string;
    target: { type: string; id: string | null; label: string };
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    /** Data undo() needs to restore `before` (tool-private). */
    undo: Record<string, unknown> | null;
    summary: string;
}

export interface UiBlock {
    title: string;
    html: string;
    css?: string;
    js?: string;
    /** true = the turn waits until the user submits (dima.submit) or it expires. */
    waitForInput: boolean;
    /** Initial height hint in px (the frame auto-resizes). */
    height?: number;
}

export interface NavigateAction {
    mode: 'offer' | 'go';
    /** Route key from navigation.ts. */
    route: string;
    label: string;
    /** Anchor key from navigation.ts for the mascot highlight. */
    anchor?: string;
}

export type ToolOutcome =
    /**
     * Plain result for the model. `summary` is a short line for the tool row in the chat. `billable: false` = nothing
     * was read or done that costs credits on surfaces that charge per call (MCP): no access, needs full access,
     * feature unavailable, not found.
     */
    | { type: 'result'; result: unknown; summary?: string; billable?: false }
    /** The runner pauses for approval, then calls tool.apply(proposal). */
    | { type: 'approval'; proposal: ChangeProposal }
    /** Show a UI block. With waitForInput the runner pauses until submit. */
    | { type: 'ui'; block: UiBlock }
    /** Navigation card or immediate navigation in the browser. */
    | { type: 'navigate'; action: NavigateAction };

/** What `AgentTool.executableFields` found. */
export interface ExecutableCheck {
    /** Command-language text the change writes. */
    texts: string[];
    /** Stored text the change makes (or keeps) reachable; refused with "edit it on the website". */
    stored?: string[];
    /** Where that stored text lives, for the refusal, e.g. "in this chat event". */
    where?: string;
    /** The change turns on stored code that can't be listed here; refused with this plain reason. */
    blocked?: string;
    /**
     * Fingerprint of the stored state that was checked. The caller copies it to `proposal.payload.pinned`, and the
     * tool's `apply` throws ToolConflictError unless it still reads the same, so an edit in between can't slip in.
     */
    pinned?: Record<string, unknown>;
}

export class ToolInputError extends Error {}
/** Thrown by apply() when the target changed since the proposal (compare-and-set failed). */
export class ToolConflictError extends Error {}

export interface AgentTool<Input = Record<string, unknown>> {
    name: string;
    description: string;
    parameters: JsonSchema;
    kind: ToolKind;
    /** ALL required to see and use the tool. [] = anyone with assistant access. */
    permissions: readonly string[];
    /** Minimum channel plan, if the feature itself is plan-gated. */
    minPlan?: PlanTier;
    /** Max bytes of the result sent to the model (default SITE_AGENT_LIMITS.toolResultBytes). */
    resultBytes?: number;
    /** Short status line while it runs, e.g. "Searching the docs…". */
    label(input: Input, lang: Lang): string;
    /** Validate/normalize raw model arguments. Throw ToolInputError with a model-readable message. */
    validate(raw: unknown): Input;
    run(input: Input, ctx: ToolContext): Promise<ToolOutcome>;
    /** Write tools: perform an approved proposal. Must compare-and-set against proposal.payload. */
    apply?(proposal: ChangeProposal, ctx: ToolContext): Promise<{ result: unknown; change: ChangeRecordInput | null }>;
    /** Write tools: restore a change from the log. Throw ToolConflictError if it changed since. */
    undo?(change: { undo: Record<string, unknown> | null; after: Record<string, unknown> | null; target: ChangeRecordInput['target'] }, ctx: Omit<ToolContext, 'callId'>): Promise<void>;
    /**
     * Write tools whose changes make command-language text run. Surfaces that apply without an approval card (MCP)
     * check every returned text with `tools/safe_body.ts` before `apply`: the text the change writes, and stored text
     * it makes reachable (enable flags, thresholds, access, modes, names, odds, fallbacks, deletion). `null` = it would
     * run code that can't be checked (a built-in command's own code), so those surfaces refuse it.
     */
    executableFields?(input: Input, proposal: ChangeProposal, ctx: ToolContext): string[] | ExecutableCheck | null | Promise<string[] | ExecutableCheck | null>;
    /** Where the tool is offered (default both). MCP-only tools (`tools/mcp_changes.ts`) are never in the site registry. */
    surfaces?: readonly ('site' | 'mcp')[];
}

// ---------------------------------------------------------------------------
// Turns, display transcript and wire events
// ---------------------------------------------------------------------------

export type TurnStatus = 'queued' | 'running' | 'awaiting_approval' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ToolCallState = 'pending' | 'running' | 'awaiting_approval' | 'awaiting_input' | 'done' | 'error' | 'denied' | 'declined' | 'superseded' | 'interrupted' | 'expired';
export type ApprovalState = 'pending' | 'applied' | 'skipped' | 'expired' | 'failed' | 'superseded';
export type InputMode = 'send' | 'steer' | 'queue';

export type DisplayItem =
    | { kind: 'user'; id: string; turnId: string; text: string; mode: InputMode; at: number }
    | { kind: 'assistant'; id: string; turnId: string; text: string; at: number; final: boolean }
    | { kind: 'tool'; id: string; turnId: string; callId: string; name: string; label: string; state: ToolCallState; summary?: string; at: number }
    | { kind: 'ui'; id: string; turnId: string; callId: string; block: UiBlock; state: 'open' | 'submitted' | 'closed'; at: number }
    | { kind: 'approval'; id: string; turnId: string; callId: string; proposal: Omit<ChangeProposal, 'payload' | 'permissions'>; state: ApprovalState; changeId?: string; error?: string; expiresAt: number; at: number }
    | { kind: 'navigate'; id: string; turnId: string; callId: string; action: NavigateAction; at: number }
    | { kind: 'notice'; id: string; turnId: string; code: string; at: number };

/** Server → browser events on GET /agent/:channelID/turns/:turnId/events (SSE). */
export type AgentEvent =
    /** `levelCost`: what a steer into this answer pays. */
    | { type: 'turn'; turnId: string; sessionId: string; status: TurnStatus; inputRevision: number; levelCost?: number }
    | { type: 'status'; phase: 'thinking' | 'tool' | 'compacting' | 'waiting'; label?: string }
    | { type: 'item'; item: DisplayItem }
    /**
     * Streaming text for an assistant item that is not final yet. `offset` = length of the item's
     * text before this delta: apply only when the local text length equals it (replays after a
     * reconnect may repeat deltas the snapshot already contains).
     */
    | { type: 'text'; itemId: string; delta: string; offset: number }
    /** Item replaced in place (state change, final flag, summary). */
    | { type: 'update'; item: DisplayItem }
    | { type: 'limits'; limits: LimitsView }
    | { type: 'done'; turnId: string; status: TurnStatus; errorCode?: string };

export interface LimitsView {
    plan: PlanTier;
    used: number;
    limit: number;
    /** Epoch ms of the next reset (00:00 UTC). */
    resetsAt: number;
}

export interface SessionMeta {
    id: string;
    channelId: string;
    userId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    /** Turn currently queued/running/waiting, if any. */
    activeTurnId: string | null;
    /** Last known prompt size (tokens) for the context meter. */
    contextTokens: number;
    contextLimit: number;
    /** Level and model of the last answered step (what moving the chat to the other level costs depends on it). */
    lastLevel?: 'standard' | 'expert';
    contextModel?: string;
}
