/**
 * Wire contract with the API (`dimabot/src/site_agent/types.ts`, `dimabot/SITE_AGENT.md`).
 * Keep in sync with the backend; field names match the JSON exactly.
 */

export type PlanTier = 'free' | 'premium' | 'pro';
export type TurnStatus = 'queued' | 'running' | 'awaiting_approval' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ToolCallState = 'pending' | 'running' | 'awaiting_approval' | 'awaiting_input' | 'done' | 'error' | 'denied' | 'declined' | 'superseded' | 'interrupted' | 'expired';
export type ApprovalState = 'pending' | 'applied' | 'skipped' | 'expired' | 'failed' | 'superseded';
export type InputMode = 'send' | 'steer' | 'queue';

export interface PageContext {
  route: string | null;
  path: string;
  title?: string;
}

export interface UiBlock {
  title: string;
  html: string;
  css?: string;
  js?: string;
  waitForInput: boolean;
  height?: number;
}

export interface NavigateAction {
  mode: 'offer' | 'go';
  route: string;
  label: string;
  anchor?: string;
}

export interface ProposalView {
  tool: string;
  title: string;
  area: string;
  target: { type: string; id: string | null; label: string };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  effects: string[];
  warnings?: string[];
}

export type DisplayItem =
  | { kind: 'user'; id: string; turnId: string; text: string; mode: InputMode; at: number }
  | { kind: 'assistant'; id: string; turnId: string; text: string; at: number; final: boolean }
  | { kind: 'tool'; id: string; turnId: string; callId: string; name: string; label: string; state: ToolCallState; summary?: string; at: number }
  | { kind: 'ui'; id: string; turnId: string; callId: string; block: UiBlock; state: 'open' | 'submitted' | 'closed'; at: number }
  | { kind: 'approval'; id: string; turnId: string; callId: string; proposal: ProposalView; state: ApprovalState; changeId?: string; error?: string; expiresAt: number; at: number }
  | { kind: 'navigate'; id: string; turnId: string; callId: string; action: NavigateAction; at: number }
  | { kind: 'notice'; id: string; turnId: string; code: string; at: number };

export interface LimitsView {
  plan: PlanTier;
  used: number;
  limit: number;
  resetsAt: number;
}

export type AgentEvent =
  | { type: 'turn'; turnId: string; sessionId: string; status: TurnStatus; inputRevision: number }
  | { type: 'status'; phase: 'thinking' | 'tool' | 'compacting' | 'waiting'; label?: string }
  | { type: 'item'; item: DisplayItem }
  /** Apply only when the item's local text length equals `offset` (replays can repeat deltas). */
  | { type: 'text'; itemId: string; delta: string; offset: number }
  | { type: 'update'; item: DisplayItem }
  | { type: 'limits'; limits: LimitsView }
  | { type: 'done'; turnId: string; status: TurnStatus; errorCode?: string };

export interface SessionMeta {
  id: string;
  channelId: string;
  userId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  activeTurnId: string | null;
  contextTokens: number;
  contextLimit: number;
}

export interface TurnSnapshot {
  turnId: string;
  sessionId: string;
  status: TurnStatus;
  inputRevision: number;
  cursor: string;
}

export interface StatusView {
  enabled: boolean;
  role: 'owner' | 'admin';
  limits: LimitsView;
  contextLimit: number;
}

export interface ChangeView {
  id: string;
  actor: { id: string; login: string; displayName: string; role: 'owner' | 'admin' };
  request: string;
  title: string;
  area: string;
  target: { type: string; id: string | null; label: string };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  effects: string[];
  at: number;
  undone: { at: number; by: { id: string; login: string } } | null;
  canUndo: boolean;
}

/** Envelope used by every API response. */
export interface ApiEnvelope<T> {
  error: boolean;
  message: string;
  status: number;
  data: T;
}
