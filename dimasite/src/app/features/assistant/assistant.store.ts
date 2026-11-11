import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, Injectable, PLATFORM_ID, computed, effect, inject, signal, untracked } from '@angular/core';
import { PRIMARY_OUTLET, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { AssistantApiError, AssistantApiService, newClientRequestId, type SessionSnapshot } from './assistant-api.service';
import { applyTextDelta } from './assistant-text';
import { AssistantGuideService } from './assistant-guide.service';
import { AssistantPresenceService, type MascotMood } from './assistant-presence.service';
import { ASSISTANT_ANCHORS, ASSISTANT_ROUTES, routeKeyForPath } from './assistant-routes';
import type { SseFrame } from './assistant-sse';
import type {
  AgentEvent,
  ChangeView,
  DisplayItem,
  InputMode,
  LimitsView,
  PageContext,
  SessionMeta,
  StatusView,
  TurnStatus,
} from './assistant.types';
import {
  DOCS_TOOLS,
  RETRYABLE_STATUSES,
  buildTurns,
  isActiveStatus,
  upsertItem,
  type ApprovalItem,
  type UiItem,
} from './assistant-view';

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface ActiveTurn {
  turnId: string;
  status: TurnStatus;
  inputRevision: number;
}

/** A message the user sent that the transcript doesn't show yet. */
export interface PendingInput {
  id: string;
  text: string;
  mode: InputMode;
  state: 'sending' | 'sent';
}

export interface StatusLine {
  phase: 'thinking' | 'tool' | 'compacting' | 'waiting';
  label?: string;
  since: number;
}

export interface StoreError {
  code: string;
  message?: string;
  data?: unknown;
}

export const MAX_MESSAGE_CHARS = 4000;

/** Notice codes after which Retry makes sense (the turn ended failed, stopped or interrupted). */
const RETRY_NOTICE_CODES = new Set(['interrupted', 'stopped', 'cancelled', 'failed', 'error', 'internal_error', 'lease_lost', 'result_unknown']);

export function isRetryNotice(code: string): boolean {
  return RETRY_NOTICE_CODES.has(code) || (code.startsWith('model_') && code !== 'model_config');
}

const STALL_MS = 45_000;
const HAPPY_MS = 2_500;
const ERROR_MS = 6_000;
const SPEAKING_MS = 1_300;

function asError(error: unknown): AssistantApiError {
  if (error instanceof AssistantApiError) return error;
  return new AssistantApiError(0, 'network', error instanceof Error ? error.message : String(error));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * State of the assistant panel for one channel: status/limits, chats, the open chat's
 * transcript and its live turn (SSE with cursor resume), approvals, forms, changes, and the
 * mascot's mood through AssistantPresenceService. Provided by the panel component, so it lives
 * as long as the logged-in layout shows the assistant.
 */
@Injectable()
export class AssistantStore {
  private readonly api = inject(AssistantApiService);
  private readonly auth = inject(SessionAuthService);
  private readonly presence = inject(AssistantPresenceService);
  private readonly guide = inject(AssistantGuideService);
  private readonly router = inject(Router);
  private readonly i18n = inject(LanguageService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Route param as the URL has it (used to build navigation paths). */
  readonly streamer = signal('');
  readonly channelId = signal<string | null>(null);
  readonly status = signal<StatusView | null>(null);
  readonly limits = signal<LimitsView | null>(null);

  readonly sessions = signal<SessionMeta[]>([]);
  readonly sessionsState = signal<LoadState>('idle');
  readonly sessionId = signal<string | null>(null);
  readonly sessionState = signal<LoadState>('idle');
  readonly items = signal<DisplayItem[]>([]);
  readonly activeTurn = signal<ActiveTurn | null>(null);
  readonly statusLine = signal<StatusLine | null>(null);
  /** How finished turns ended (from `done` events this visit). */
  readonly outcomes = signal<Readonly<Record<string, { status: TurnStatus; errorCode?: string }>>>({});
  readonly pending = signal<PendingInput[]>([]);
  readonly sendError = signal<StoreError | null>(null);
  readonly connection = signal<'idle' | 'live' | 'reconnecting'>('idle');
  readonly stopping = signal(false);
  /** Approval / form call ids with a request in flight. */
  readonly busyCalls = signal<ReadonlySet<string>>(new Set());
  readonly callErrors = signal<Readonly<Record<string, StoreError>>>({});
  readonly feedbackGiven = signal<Readonly<Record<string, boolean>>>({});
  readonly retrying = signal(false);
  /** Polite screen-reader announcement (answer ready, needs approval, …). */
  readonly announcement = signal('');
  /** Bumped when the assistant opened a page: phones shrink the sheet to the peek bar. */
  readonly peekRequest = signal(0);
  /** Ticks every second while something on screen counts (elapsed time, approval expiry). */
  readonly now = signal(Date.now());

  readonly changes = signal<ChangeView[]>([]);
  readonly changesNext = signal<string | null>(null);
  readonly changesState = signal<LoadState>('idle');
  readonly changesLoadingMore = signal(false);
  readonly undoing = signal<string | null>(null);
  readonly undoErrors = signal<Readonly<Record<string, StoreError>>>({});

  readonly turns = computed(() => buildTurns(this.items()));
  readonly running = computed(() => isActiveStatus(this.activeTurn()?.status));
  readonly waitingForUser = computed(() => {
    const status = this.activeTurn()?.status;
    return status === 'awaiting_approval' || status === 'awaiting_input';
  });
  readonly remaining = computed(() => {
    const limits = this.limits();
    return limits ? Math.max(0, limits.limit - limits.used) : null;
  });
  readonly atLimit = computed(() => this.remaining() === 0);
  readonly currentSession = computed(() => this.sessions().find((session) => session.id === this.sessionId()) ?? null);
  readonly isEmpty = computed(() => !this.items().length && !this.pending().length);
  /** The last turn, when it ended in a way Retry can fix. */
  readonly retryableTurnId = computed(() => {
    if (this.running()) return null;
    const turns = this.turns();
    const last = turns[turns.length - 1];
    if (!last) return null;
    const outcome = this.outcomes()[last.turnId];
    if (outcome) return RETRYABLE_STATUSES.includes(outcome.status) ? last.turnId : null;
    const tail = last.blocks[last.blocks.length - 1];
    return tail?.type === 'notice' && isRetryNotice(tail.item.code) ? last.turnId : null;
  });
  readonly hasOpenCards = computed(() =>
    this.items().some((item) => (item.kind === 'approval' && item.state === 'pending') || (item.kind === 'ui' && item.state === 'open')),
  );

  private channelGen = 0;
  private sessionGen = 0;
  private streamGen = 0;
  private stream: AbortController | null = null;
  private followedTurn: string | null = null;
  /** Set when a text gap is seen: the follow loop reloads the snapshot and continues from its cursor. */
  private resyncWanted = false;
  /** A message request is on its way (sends are serialized). */
  readonly sending = signal(false);
  private queuedTurns: string[] = [];
  private readonly navigated = new Set<string>();
  private panelOpened = false;
  private flash: MascotMood | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private speakTimer: ReturnType<typeof setTimeout> | undefined;
  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTextAt = 0;

  constructor() {
    effect((onCleanup) => {
      if (!this.isBrowser || !(this.running() || this.hasOpenCards())) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    // Panel open/closed and unread change what the mascot bubble says.
    effect(() => {
      this.presence.open();
      this.presence.unread();
      untracked(() => this.refreshMood());
    });
    inject(DestroyRef).onDestroy(() => {
      this.channelGen++;
      this.endSessionStreams();
      clearTimeout(this.flashTimer);
      clearTimeout(this.speakTimer);
      clearTimeout(this.announceTimer);
      this.presence.enabled.set(false);
      this.presence.mood.set('idle');
      this.presence.bubble.set(null);
    });
  }

  // -------------------------------------------------------------------------
  // Channel + status
  // -------------------------------------------------------------------------

  /** Called with the URL's streamer; resolves the channel and loads `GET /status`. */
  async init(streamer: string): Promise<void> {
    if (!this.isBrowser) return;
    const param = streamer.trim();
    if (param === this.streamer()) return;
    const gen = ++this.channelGen;
    this.resetChannel();
    this.streamer.set(param);
    if (!param) return;
    const channelId = await firstValueFrom(this.auth.resolveChannelID(param)).catch(() => null);
    if (gen !== this.channelGen) return;
    if (!channelId) return;
    this.channelId.set(channelId);
    let status: StatusView;
    try {
      status = await this.api.status(channelId);
    } catch {
      return;
    }
    if (gen !== this.channelGen) return;
    this.status.set(status);
    this.limits.set(status.limits ?? null);
    this.presence.enabled.set(!!status.enabled);
    if (!status.enabled) return;
    if (this.presence.open()) {
      await this.onPanelOpen();
      return;
    }
    // A chat that is still working (opened before a reload): follow it so the mascot shows progress.
    const remembered = this.readRemembered();
    if (!remembered) return;
    await this.loadSessions();
    if (gen !== this.channelGen || this.sessionId()) return;
    const meta = this.sessions().find((session) => session.id === remembered);
    if (meta?.activeTurnId) void this.openSession(meta.id);
  }

  /** Panel opened: load the chat list once and reopen the last chat. */
  async onPanelOpen(): Promise<void> {
    if (this.panelOpened || !this.channelId() || !this.presence.enabled()) return;
    this.panelOpened = true;
    const gen = this.channelGen;
    if (this.sessionsState() === 'idle') await this.loadSessions();
    if (gen !== this.channelGen || this.sessionId()) return;
    const remembered = this.readRemembered();
    if (remembered && this.sessions().some((session) => session.id === remembered)) void this.openSession(remembered);
  }

  private resetChannel(): void {
    this.endSessionStreams();
    this.presence.enabled.set(false);
    this.channelId.set(null);
    this.status.set(null);
    this.limits.set(null);
    this.sessions.set([]);
    this.sessionsState.set('idle');
    this.sessionId.set(null);
    this.sessionState.set('idle');
    this.items.set([]);
    this.pending.set([]);
    this.activeTurn.set(null);
    this.statusLine.set(null);
    this.outcomes.set({});
    this.changes.set([]);
    this.changesNext.set(null);
    this.changesState.set('idle');
    this.undoErrors.set({});
    this.panelOpened = false;
    this.refreshMood();
  }

  // -------------------------------------------------------------------------
  // Chats
  // -------------------------------------------------------------------------

  async loadSessions(): Promise<void> {
    const channelId = this.channelId();
    if (!channelId) return;
    const gen = this.channelGen;
    this.sessionsState.set('loading');
    try {
      const sessions = await this.api.sessions(channelId);
      if (gen !== this.channelGen) return;
      this.sessions.set([...sessions].sort((a, b) => b.updatedAt - a.updatedAt));
      this.sessionsState.set('ready');
    } catch {
      if (gen === this.channelGen) this.sessionsState.set('error');
    }
  }

  async openSession(sessionId: string): Promise<void> {
    const channelId = this.channelId();
    if (!channelId) return;
    const gen = this.beginSession(sessionId);
    this.remember(sessionId);
    this.sessionState.set('loading');
    try {
      const snapshot = await this.api.session(channelId, sessionId);
      if (gen !== this.sessionGen) return;
      this.applySnapshot(snapshot, gen);
      this.sessionState.set('ready');
    } catch (error) {
      if (gen !== this.sessionGen) return;
      const failure = asError(error);
      if (failure.status === 404) {
        this.forget();
        this.sessions.update((list) => list.filter((session) => session.id !== sessionId));
        this.sessionId.set(null);
        this.sessionState.set('idle');
      } else {
        this.sessionState.set('error');
      }
    }
  }

  newChat(): void {
    this.beginSession(null);
    this.forget();
    this.sessionState.set('idle');
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const channelId = this.channelId();
    if (!channelId) return false;
    try {
      await this.api.deleteSession(channelId, sessionId);
    } catch (error) {
      if (asError(error).status !== 404) return false;
    }
    this.sessions.update((list) => list.filter((session) => session.id !== sessionId));
    if (this.sessionId() === sessionId) this.newChat();
    return true;
  }

  /**
   * Reload the open chat (after `resync`, a 409, or a finished turn). False only when the request failed
   * (the screen keeps what it has); a chat that changed meanwhile counts as done.
   */
  async refreshSession(): Promise<boolean> {
    const channelId = this.channelId();
    const sessionId = this.sessionId();
    if (!channelId || !sessionId) return true;
    const gen = this.sessionGen;
    try {
      const snapshot = await this.api.session(channelId, sessionId);
      if (gen === this.sessionGen) this.applySnapshot(snapshot, gen);
      return true;
    } catch (error) {
      // Gone (deleted or expired): nothing left to follow.
      if (error instanceof AssistantApiError && error.status === 404) return true;
      return false;
    }
  }

  /** refreshSession with bounded retries (a single network blip must not stop following a running turn). */
  private async refreshWithRetry(gen: number): Promise<void> {
    for (let attempt = 0; attempt < 6 && gen === this.sessionGen; attempt++) {
      if (await this.refreshSession()) return;
      this.connection.set('reconnecting');
      await sleep(Math.min(15_000, 1000 * 2 ** attempt) + Math.random() * 400);
    }
    if (gen === this.sessionGen) this.connection.set('idle');
  }

  private beginSession(sessionId: string | null): number {
    this.endSessionStreams();
    this.sessionId.set(sessionId);
    this.items.set([]);
    this.pending.set([]);
    this.activeTurn.set(null);
    this.statusLine.set(null);
    this.sendError.set(null);
    this.callErrors.set({});
    this.stopping.set(false);
    this.queuedTurns = [];
    this.refreshMood();
    return this.sessionGen;
  }

  private endSessionStreams(): void {
    this.sessionGen++;
    this.streamGen++;
    this.stream?.abort();
    this.stream = null;
    this.followedTurn = null;
    this.connection.set('idle');
  }

  private applySnapshot(snapshot: SessionSnapshot, gen: number): void {
    this.items.set(snapshot.items);
    this.prunePending(snapshot.items);
    if (snapshot.session) {
      this.sessions.update((list) => {
        const rest = list.filter((session) => session.id !== snapshot.session.id);
        return [snapshot.session, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
      });
    }
    const turn = snapshot.activeTurn;
    if (turn && isActiveStatus(turn.status)) {
      this.activeTurn.set({ turnId: turn.turnId, status: turn.status, inputRevision: turn.inputRevision });
      this.queuedTurns = this.queuedTurns.filter((id) => id !== turn.turnId);
      // The items above are the state at `cursor`: always continue from there (even when already following
      // this turn), so events newer than a late snapshot are replayed instead of lost.
      this.follow(turn.turnId, turn.cursor || null, gen);
    } else if (this.queuedTurns.length) {
      const next = this.queuedTurns.shift()!;
      this.activeTurn.set({ turnId: next, status: 'queued', inputRevision: 0 });
      this.follow(next, null, gen);
    } else {
      this.activeTurn.set(null);
      this.statusLine.set(null);
      this.stopping.set(false);
    }
    this.refreshMood();
  }

  // -------------------------------------------------------------------------
  // Event stream
  // -------------------------------------------------------------------------

  /** Follow a turn's events from `cursor` (null = from the start), reconnecting with backoff. */
  private follow(turnId: string, cursor: string | null, gen: number): void {
    const channelId = this.channelId();
    if (!channelId || gen !== this.sessionGen) return;
    this.stream?.abort();
    const streamGen = ++this.streamGen;
    this.followedTurn = turnId;
    void this.followLoop(channelId, turnId, cursor, gen, streamGen);
  }

  private async followLoop(channelId: string, turnId: string, cursor: string | null, gen: number, streamGen: number): Promise<void> {
    const alive = () => gen === this.sessionGen && streamGen === this.streamGen;
    let after = cursor;
    let attempt = 0;
    while (alive()) {
      const controller = new AbortController();
      this.stream = controller;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const kick = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), STALL_MS);
      };
      let finished = false;
      let resync = false;
      let fatal: AssistantApiError | null = null;
      kick();
      this.connection.set(attempt ? 'reconnecting' : 'live');
      try {
        await this.api.streamEvents(
          channelId,
          turnId,
          after,
          controller.signal,
          (frame: SseFrame) => {
            if (!alive()) return;
            attempt = 0;
            this.connection.set('live');
            if (frame.id) after = frame.id;
            if (frame.event === 'resync') {
              resync = true;
              controller.abort();
              return;
            }
            const event = this.parseEvent(frame);
            if (!event) return;
            this.applyEvent(event, true);
            if (event.type === 'done' && event.turnId === turnId) {
              // The server ends the stream after `done`; don't depend on it.
              finished = true;
              controller.abort();
            }
          },
          kick,
        );
      } catch (error) {
        if (error instanceof AssistantApiError && error.status >= 400 && error.status < 500 && error.status !== 429) fatal = error;
      } finally {
        clearTimeout(watchdog);
      }
      if (!alive()) return;
      if (this.resyncWanted) { this.resyncWanted = false; resync = true; }
      if (resync || fatal) {
        this.followedTurn = null;
        this.connection.set('idle');
        await this.refreshWithRetry(gen);
        return;
      }
      if (finished) {
        this.followedTurn = null;
        this.connection.set('idle');
        await this.afterDone(gen);
        return;
      }
      attempt++;
      this.connection.set('reconnecting');
      await sleep(Math.min(15_000, 1000 * 2 ** Math.min(attempt - 1, 4)) + Math.random() * 400);
      // After several failures, ask whether the turn is still going before trying again.
      if (alive() && attempt >= 4 && attempt % 2 === 0) {
        try {
          const snapshot = await this.api.turn(channelId, turnId);
          if (!isActiveStatus(snapshot.status)) {
            if (!alive()) return;
            this.followedTurn = null;
            this.connection.set('idle');
            await this.refreshWithRetry(gen);
            return;
          }
        } catch {
          /* still offline */
        }
      }
    }
  }

  private requestResync(): void {
    this.resyncWanted = true;
    this.stream?.abort();
  }

  private parseEvent(frame: SseFrame): AgentEvent | null {
    if (!frame.data) return null;
    try {
      const data = JSON.parse(frame.data) as Record<string, unknown>;
      // The SSE `event:` name is the AgentEvent type; the data may or may not repeat it.
      return { ...data, type: (data['type'] as string) || frame.event } as AgentEvent;
    } catch {
      return null;
    }
  }

  /** Apply one wire event. `live` = it just happened (navigate `go` acts only then). */
  applyEvent(event: AgentEvent, live: boolean): void {
    switch (event.type) {
      case 'turn': {
        this.activeTurn.set({ turnId: event.turnId, status: event.status, inputRevision: event.inputRevision });
        if (event.status === 'awaiting_approval' || event.status === 'awaiting_input') {
          this.statusLine.set({ phase: 'waiting', since: Date.now() });
          this.announce(this.t(event.status === 'awaiting_approval' ? 'assistant.announce.approval' : 'assistant.announce.input'));
          if (!this.presence.open()) this.presence.unread.set(true);
        }
        break;
      }
      case 'status': {
        const current = this.statusLine();
        const since = current && current.phase === event.phase && current.label === event.label ? current.since : Date.now();
        this.statusLine.set({ phase: event.phase, label: event.label, since });
        break;
      }
      case 'item': {
        this.items.update((items) => upsertItem(items, event.item));
        if (event.item.kind === 'user') this.prunePending([event.item]);
        if (event.item.kind === 'assistant' && event.item.text) this.markSpeaking();
        if (live && event.item.kind === 'navigate' && event.item.action.mode === 'go' && !this.navigated.has(event.item.id)) {
          this.navigated.add(event.item.id);
          const { route, anchor, label } = event.item.action;
          this.navigateTo(route, anchor, label);
        }
        break;
      }
      case 'text': {
        let found = false;
        let gap = false;
        this.items.update((items) =>
          items.map((item) => {
            if (item.id !== event.itemId || item.kind !== 'assistant') return item;
            found = true;
            const next = applyTextDelta(item.text, event.delta, event.offset);
            if (next === null) { gap = true; return item; }
            return next === item.text ? item : { ...item, text: next };
          }),
        );
        if (!found) {
          if (typeof event.offset === 'number' && event.offset > 0) gap = true;
          else {
            const turnId = this.activeTurn()?.turnId ?? this.followedTurn ?? '';
            this.items.update((items) => [...items, { kind: 'assistant', id: event.itemId, turnId, text: event.delta, at: Date.now(), final: false }]);
          }
        }
        // Text is missing before this delta: read the snapshot and continue from its cursor.
        if (gap) this.requestResync();
        this.statusLine.set(null);
        this.markSpeaking();
        break;
      }
      case 'update':
        this.items.update((items) => upsertItem(items, event.item));
        break;
      case 'limits':
        this.limits.set(event.limits);
        break;
      case 'done': {
        this.outcomes.update((map) => ({ ...map, [event.turnId]: { status: event.status, errorCode: event.errorCode } }));
        if (this.activeTurn()?.turnId === event.turnId) this.activeTurn.set(null);
        this.statusLine.set(null);
        this.stopping.set(false);
        const ok = event.status === 'completed';
        const failed = event.status === 'failed' || event.status === 'interrupted';
        if (ok || failed) this.flashMood(ok ? 'happy' : 'error', ok ? HAPPY_MS : ERROR_MS);
        this.announce(this.t(ok ? 'assistant.announce.ready' : failed ? 'assistant.announce.failed' : 'assistant.announce.stopped'));
        if ((ok || failed) && !this.presence.open()) this.presence.unread.set(true);
        break;
      }
    }
    this.refreshMood();
  }

  /** A turn ended: reload the chat (final items, title, a queued next turn). */
  private async afterDone(gen: number): Promise<void> {
    if (gen !== this.sessionGen) return;
    await this.refreshWithRetry(gen);
    // A queued message starts its own turn right after; the snapshot may be a moment early.
    for (let attempt = 0; attempt < 3 && gen === this.sessionGen && !this.activeTurn() && this.pending().some((p) => p.mode === 'queue'); attempt++) {
      await sleep(1500);
      if (gen === this.sessionGen) await this.refreshSession();
    }
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /** Send a message. While a turn runs, `send` becomes `steer` (or `queue` when asked). */
  async send(text: string, requested: InputMode = 'send'): Promise<boolean> {
    const channelId = this.channelId();
    const clean = text.trim();
    if (!channelId || !clean || clean.length > MAX_MESSAGE_CHARS) return false;
    // One send at a time: two quick first messages would otherwise create two chats (the text stays in the box).
    if (this.sending()) return false;
    this.sending.set(true);
    try {
      return await this.sendNow(channelId, clean, requested);
    } finally {
      this.sending.set(false);
    }
  }

  private async sendNow(channelId: string, clean: string, requested: InputMode): Promise<boolean> {
    const mode: InputMode = this.running() ? (requested === 'queue' ? 'queue' : 'steer') : 'send';
    const id = newClientRequestId();
    const gen = this.sessionGen;
    const sessionId = this.sessionId();
    this.sendError.set(null);
    this.clearFlash();
    this.pending.update((list) => [...list, { id, text: clean, mode, state: 'sending' }]);
    try {
      const result = await this.api.send(channelId, {
        ...(sessionId ? { sessionId } : {}),
        text: clean,
        mode,
        page: this.pageContext(),
        clientRequestId: id,
      });
      if (gen !== this.sessionGen) return true;
      if (result.limits) this.limits.set(result.limits);
      this.pending.update((list) => list.map((entry) => (entry.id === id ? { ...entry, state: 'sent' } : entry)));
      if (!this.sessionId() && result.sessionId) {
        this.sessionId.set(result.sessionId);
        this.remember(result.sessionId);
        this.sessionState.set('ready');
        void this.loadSessions();
      }
      if (mode === 'send') {
        this.activeTurn.set({ turnId: result.turnId, status: 'queued', inputRevision: 0 });
        this.statusLine.set({ phase: 'thinking', since: Date.now() });
        this.follow(result.turnId, null, gen);
      } else if (mode === 'queue' && result.turnId && result.turnId !== this.activeTurn()?.turnId) {
        this.queuedTurns.push(result.turnId);
      }
      this.refreshMood();
      return true;
    } catch (error) {
      this.pending.update((list) => list.filter((entry) => entry.id !== id));
      if (gen !== this.sessionGen) return false;
      const failure = asError(error);
      if (failure.code === 'turn_active' || (failure.status === 409 && mode === 'send')) {
        this.sendError.set({ code: 'turn_active' });
        await this.refreshSession();
        return false;
      }
      // The answer finished while this steer/queue was on its way: send it as a new message.
      if (failure.code === 'turn_not_active' && mode !== 'send') {
        this.activeTurn.set(null);
        this.statusLine.set(null);
        return this.sendNow(channelId, clean, 'send');
      }
      if (failure.code === 'limit_reached' || failure.code === 'daily_limit') {
        const limits = (failure.data as { limits?: LimitsView } | null)?.limits;
        if (limits && typeof limits.limit === 'number') this.limits.set(limits);
        else void this.refreshStatus();
      }
      this.sendError.set({ code: failure.code, message: failure.message, data: failure.data });
      return false;
    }
  }

  async stop(): Promise<void> {
    const channelId = this.channelId();
    const turn = this.activeTurn();
    if (!channelId || !turn || this.stopping()) return;
    this.stopping.set(true);
    try {
      await this.api.stop(channelId, turn.turnId);
    } catch (error) {
      this.stopping.set(false);
      const failure = asError(error);
      if (failure.status === 404 || failure.status === 409) await this.refreshSession();
      else this.sendError.set({ code: failure.code, message: failure.message });
    }
  }

  async retry(turnId: string): Promise<void> {
    const channelId = this.channelId();
    if (!channelId || this.running() || this.retrying()) return;
    const gen = this.sessionGen;
    this.retrying.set(true);
    this.sendError.set(null);
    this.clearFlash();
    try {
      const result = await this.api.retry(channelId, turnId, newClientRequestId());
      if (gen !== this.sessionGen) return;
      this.activeTurn.set({ turnId: result.turnId, status: 'queued', inputRevision: 0 });
      this.statusLine.set({ phase: 'thinking', since: Date.now() });
      this.follow(result.turnId, null, gen);
      this.refreshMood();
    } catch (error) {
      const failure = asError(error);
      if (gen === this.sessionGen) this.sendError.set({ code: failure.code, message: failure.message });
    } finally {
      this.retrying.set(false);
    }
  }

  async decide(item: ApprovalItem, decision: 'apply' | 'skip'): Promise<void> {
    const channelId = this.channelId();
    if (!channelId || item.state !== 'pending' || this.busyCalls().has(item.callId)) return;
    this.setBusy(item.callId, true);
    this.clearCallError(item.callId);
    try {
      const result = await this.api.decide(channelId, item.turnId, item.callId, decision);
      this.items.update((items) =>
        items.map((existing) =>
          existing.kind === 'approval' && existing.callId === item.callId && existing.state === 'pending' && result?.state
            ? { ...existing, state: result.state }
            : existing,
        ),
      );
    } catch (error) {
      const failure = asError(error);
      this.callErrors.update((map) => ({ ...map, [item.callId]: { code: failure.code, message: failure.message } }));
      if (failure.status === 404 || failure.status === 409 || failure.status === 410) void this.refreshSession();
    } finally {
      this.setBusy(item.callId, false);
    }
  }

  async submitUi(item: UiItem, values: unknown): Promise<void> {
    const channelId = this.channelId();
    if (!channelId || item.state !== 'open' || this.busyCalls().has(item.callId)) return;
    this.setBusy(item.callId, true);
    this.clearCallError(item.callId);
    try {
      await this.api.submitUi(channelId, item.turnId, item.callId, values);
      this.items.update((items) =>
        items.map((existing) => (existing.kind === 'ui' && existing.callId === item.callId && existing.state === 'open' ? { ...existing, state: 'submitted' } : existing)),
      );
    } catch (error) {
      const failure = asError(error);
      this.callErrors.update((map) => ({ ...map, [item.callId]: { code: failure.code, message: failure.message } }));
      if (failure.status === 404 || failure.status === 409 || failure.status === 410) void this.refreshSession();
    } finally {
      this.setBusy(item.callId, false);
    }
  }

  feedback(turnId: string, helpful: boolean): void {
    const channelId = this.channelId();
    if (!channelId || turnId in this.feedbackGiven()) return;
    this.feedbackGiven.update((map) => ({ ...map, [turnId]: helpful }));
    this.api.feedback(channelId, turnId, helpful).catch(() => undefined);
  }

  /** Open one of the assistant's pages under the current streamer. Unknown key → false. */
  navigateTo(routeKey: string, anchor?: string, label?: string): boolean {
    const path = Object.prototype.hasOwnProperty.call(ASSISTANT_ROUTES, routeKey) ? ASSISTANT_ROUTES[routeKey] : null;
    const streamer = this.streamer();
    if (!path || !streamer) return false;
    const point = () => {
      if (anchor && Object.prototype.hasOwnProperty.call(ASSISTANT_ANCHORS, anchor)) this.guide.point(anchor, label ?? '');
    };
    const target = this.router.serializeUrl(this.router.createUrlTree(['/', streamer, ...path]));
    // Already on that page: the router ignores same-URL navigation, so point right away.
    if (this.router.url.split(/[?#]/)[0] === target) point();
    else void this.router.navigate(['/', streamer, ...path]).then((ok) => { if (ok) point(); });
    this.peekRequest.update((count) => count + 1);
    return true;
  }

  async refreshStatus(): Promise<void> {
    const channelId = this.channelId();
    if (!channelId) return;
    try {
      const status = await this.api.status(channelId);
      if (channelId !== this.channelId()) return;
      this.status.set(status);
      if (status.limits) this.limits.set(status.limits);
    } catch {
      /* keep the last known limits */
    }
  }

  // -------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------

  async loadChanges(more = false): Promise<void> {
    const channelId = this.channelId();
    if (!channelId) return;
    if (more && (!this.changesNext() || this.changesLoadingMore())) return;
    if (more) this.changesLoadingMore.set(true);
    else this.changesState.set('loading');
    try {
      const page = await this.api.changes(channelId, more ? this.changesNext() : null);
      if (channelId !== this.channelId()) return;
      this.changes.update((list) => (more ? [...list, ...page.changes.filter((change) => !list.some((old) => old.id === change.id))] : page.changes));
      this.changesNext.set(page.next);
      this.changesState.set('ready');
    } catch {
      if (!more) this.changesState.set('error');
    } finally {
      this.changesLoadingMore.set(false);
    }
  }

  async undo(changeId: string): Promise<boolean> {
    const channelId = this.channelId();
    if (!channelId || this.undoing()) return false;
    this.undoing.set(changeId);
    this.undoErrors.update((map) => {
      const { [changeId]: _removed, ...rest } = map;
      return rest;
    });
    try {
      const change = await this.api.undo(channelId, changeId);
      if (change) this.changes.update((list) => list.map((existing) => (existing.id === changeId ? change : existing)));
      return true;
    } catch (error) {
      const failure = asError(error);
      this.undoErrors.update((map) => ({ ...map, [changeId]: { code: failure.code, message: failure.message, data: failure.data } }));
      return false;
    } finally {
      this.undoing.set(null);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Where the user is: route key for the assistant, path, and the page title. */
  pageContext(): PageContext {
    const tree = this.router.parseUrl(this.router.url);
    const segments = tree.root.children[PRIMARY_OUTLET]?.segments.map((segment) => segment.path) ?? [];
    const title = typeof document !== 'undefined' ? document.title : '';
    return { route: routeKeyForPath(segments.slice(1)), path: `/${segments.join('/')}`, ...(title ? { title } : {}) };
  }

  private prunePending(items: readonly DisplayItem[]): void {
    const texts = items.filter((item) => item.kind === 'user').map((item) => (item as { text: string }).text.trim());
    if (!texts.length || !this.pending().length) return;
    this.pending.update((list) => {
      const left = [...texts];
      return list.filter((entry) => {
        const index = left.indexOf(entry.text);
        if (index === -1) return true;
        left.splice(index, 1);
        return false;
      });
    });
  }

  private setBusy(callId: string, busy: boolean): void {
    this.busyCalls.update((set) => {
      const next = new Set(set);
      if (busy) next.add(callId);
      else next.delete(callId);
      return next;
    });
  }

  private clearCallError(callId: string): void {
    this.callErrors.update((map) => {
      const { [callId]: _removed, ...rest } = map;
      return rest;
    });
  }

  private markSpeaking(): void {
    this.lastTextAt = Date.now();
    clearTimeout(this.speakTimer);
    this.speakTimer = setTimeout(() => this.refreshMood(), SPEAKING_MS + 50);
  }

  private clearFlash(): void {
    this.flash = null;
    clearTimeout(this.flashTimer);
  }

  private flashMood(mood: MascotMood, ms: number): void {
    this.flash = mood;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = null;
      this.refreshMood();
    }, ms);
  }

  private refreshMood(): void {
    const turn = this.activeTurn();
    const running = isActiveStatus(turn?.status);
    const waiting = turn?.status === 'awaiting_approval' || turn?.status === 'awaiting_input';
    let mood: MascotMood = 'idle';
    if (running && !waiting) {
      const docsTool = this.items().some((item) => item.kind === 'tool' && (item.state === 'running' || item.state === 'pending') && DOCS_TOOLS.has(item.name));
      if (Date.now() - this.lastTextAt < SPEAKING_MS) mood = 'speaking';
      else if (docsTool) mood = 'reading';
      // A queued message may start right after an answer: let the short "happy" show first.
      else mood = this.flash ?? 'thinking';
    } else if (this.flash) {
      mood = this.flash;
    }
    this.presence.mood.set(mood);
    // Unread answers use the mascot's own "New answer" bubble.
    const bubble = waiting ? this.t('assistant.bubble.needsYou') : running ? this.t('assistant.bubble.working') : null;
    this.presence.bubble.set(bubble);
  }

  private announce(text: string): void {
    this.announcement.set('');
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => this.announcement.set(text), 60);
  }

  private t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(key, params);
  }

  private rememberKey(): string | null {
    const channelId = this.channelId();
    const userId = this.auth.getSessionSnapshot()?.twitchUser.id;
    return channelId && userId ? `dimasite.assistant.session.v1:${channelId}:${userId}` : null;
  }

  private readRemembered(): string | null {
    const key = this.rememberKey();
    if (!key) return null;
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private remember(sessionId: string): void {
    const key = this.rememberKey();
    if (!key) return;
    try {
      sessionStorage.setItem(key, sessionId);
    } catch {
      /* private mode */
    }
  }

  private forget(): void {
    const key = this.rememberKey();
    if (!key) return;
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* private mode */
    }
  }
}
