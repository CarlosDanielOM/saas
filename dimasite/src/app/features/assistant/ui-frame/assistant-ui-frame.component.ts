import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, PLATFORM_ID, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';
import type { UiBlock } from '../assistant.types';
import { clampFrameHeight, validateFrameMessage, type HostMessage } from './ui-frame-bridge';
import { UI_FRAME_SANDBOX, assistantFramePolicy, buildRelayDocument, buildUiFrameDocument, readFrameTheme, type FrameTheme } from './ui-frame-document';

/** A frame that never says it is ready (stuck or replaced page) is stopped after this long. */
const READY_MS = 5000;
/** After a submit the card stays locked; if the panel still shows it open after this, unlock it (the send failed). */
const SUBMIT_UNLOCK_MS = 8000;
const ACTION_GAP_MS = 1000;

export type UiFrameState = 'open' | 'submitted' | 'closed';

/**
 * Runs a model-written UI block (`show_ui`) in sandboxed frames (page → relay → card, see ui-frame-document.ts):
 * `sandbox="allow-scripts"` only (opaque origins, so no access to the site's login in localStorage), no network, no
 * way to load another page, the site's theme tokens and a small Live First kit (`window.dima`). The card can only
 * ask: send values (when the block waits for input), resize, open a known page. It can never apply a change itself.
 */
@Component({
  selector: 'app-assistant-ui-frame',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './assistant-ui-frame.component.css',
  template: `
    <section class="uf" [attr.data-state]="state()" [attr.aria-labelledby]="titleId">
      <header class="uf__head">
        <div class="uf__heading">
          <!-- Native label outside the frame: card content can't pass for the site's own controls (e.g. Apply). -->
          <p class="uf__made">{{ t('madeBy') }}</p>
          <h3 class="uf__title" [id]="titleId">{{ block().title }}</h3>
        </div>
        @if (state() === 'submitted') {
          <span class="uf__chip uf__chip--ok">{{ t('sent') }}</span>
        } @else if (state() === 'closed') {
          <span class="uf__chip">{{ t('closed') }}</span>
        }
      </header>
      @if (stopped()) {
        <p class="uf__note" role="status">{{ t('stopped') }}</p>
      }
      <div class="uf__slot" #slot [hidden]="stopped()" [style.height.px]="height()" [attr.data-ui-frame]="status()"></div>
    </section>
  `,
})
export class AssistantUiFrameComponent {
  readonly block = input.required<UiBlock>();
  readonly state = input<UiFrameState>('open');
  /** Optional: true while the panel sends the answer. When it ends and the card is still open (send failed), unlock. */
  readonly busy = input(false);
  /** Values the card sent with `dima.submit` (plain JSON object, ≤ 16 KB). Only while the block waits for input. */
  readonly submitted = output<Record<string, unknown>>();
  /** A route key from ASSISTANT_ROUTES the card asked to open. */
  readonly navigateRequest = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly language = inject(LanguageService);
  private readonly themeService = inject(ThemeService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly slot = viewChild<ElementRef<HTMLElement>>('slot');

  private static count = 0;
  readonly titleId = `uf-title-${++AssistantUiFrameComponent.count}`;
  readonly height = signal(120);
  readonly stopped = signal(false);
  readonly status = signal<'loading' | 'ready' | 'stopped'>('loading');

  /** Rebuild only when the code changes (a new object with the same code keeps what the user typed). */
  private readonly codeKey = computed(() => {
    const block = this.block();
    return `${block.html?.length ?? 0}:${block.css?.length ?? 0}:${block.js?.length ?? 0}:${block.html ?? ''}\u0000${block.css ?? ''}\u0000${block.js ?? ''}`;
  });

  private frame: HTMLIFrameElement | null = null;
  private token = '';
  private ready = false;
  private sentTheme = '';
  private lockedByHost = false;
  private lastSubmit = -Infinity;
  private lastNavigate = -Infinity;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private unlockTimer: ReturnType<typeof setTimeout> | null = null;
  private rendered = signal(false);

  constructor() {
    const destroy = inject(DestroyRef);
    if (!this.isBrowser) return;
    const onMessage = (event: MessageEvent) => this.receive(event);
    window.addEventListener('message', onMessage);
    destroy.onDestroy(() => {
      window.removeEventListener('message', onMessage);
      this.clearTimers();
      this.frame?.remove();
      this.frame = null;
    });
    afterNextRender(() => this.rendered.set(true));

    effect(() => {
      this.codeKey();
      if (!this.rendered()) return;
      untracked(() => this.createFrame());
    });
    // Theme switch: send the new tokens once the page has applied them.
    effect(() => {
      this.themeService.theme();
      untracked(() => requestAnimationFrame(() => this.postTheme()));
    });
    effect(() => {
      const state = this.state();
      untracked(() => this.applyState(state));
    });
    let wasBusy = false;
    effect(() => {
      const busy = this.busy();
      if (wasBusy && !busy) untracked(() => { if (this.state() === 'open') this.unlockNow(); });
      wasBusy = busy;
    });
  }

  t(key: string): string {
    return this.language.translate('assistantMascot.frame.' + key);
  }

  private currentTheme(): FrameTheme {
    const mode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    const style = getComputedStyle(this.host.nativeElement);
    return readFrameTheme(mode, (property) => style.getPropertyValue(property));
  }

  private createFrame(): void {
    this.clearTimers();
    this.frame?.remove();
    this.frame = null;
    this.ready = false;
    this.stopped.set(false);
    this.status.set('loading');
    const slot = this.slot()?.nativeElement;
    if (!slot) return;
    const block = this.block();
    this.height.set(clampFrameHeight(typeof block.height === 'number' && Number.isFinite(block.height) ? block.height : 120));
    this.token = crypto.randomUUID();
    this.lockedByHost = this.state() !== 'open';
    const theme = this.currentTheme();
    this.sentTheme = JSON.stringify(theme);
    const card = buildUiFrameDocument(block, {
      token: this.token,
      theme,
      locked: this.lockedByHost,
      locale: this.language.currentLanguage() === 'es' ? 'es-MX' : 'en',
      strings: {
        error: this.t('error'), needsClick: this.t('needsClick'), chartError: this.t('chartError'), table: this.t('table'), other: this.t('other'),
        total: this.t('total'), series: this.t('series'), label: this.t('label'),
      },
    });
    const title = block.title || this.t('fallbackTitle');
    const html = buildRelayDocument(card, { token: this.token, title, mode: theme.mode });
    const frame = document.createElement('iframe');
    // Sandbox and policy are set before the document loads; allow-same-origin is never added.
    frame.setAttribute('sandbox', UI_FRAME_SANDBOX);
    frame.setAttribute('csp', assistantFramePolicy());
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', title);
    frame.className = 'uf__frame';
    Object.assign(frame.style, { display: 'block', width: '100%', height: '100%', border: '0', background: 'transparent' });
    // Same colour scheme as the frame's document keeps its background transparent.
    frame.style.colorScheme = theme.mode;
    let loads = 0;
    frame.addEventListener('load', () => {
      if (this.frame !== frame) return;
      // The first load is the relay; it never navigates, so a later load means something replaced it.
      if (++loads > 1) { this.stop(); return; }
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = setTimeout(() => { if (this.frame === frame && !this.ready) this.stop(); }, READY_MS);
    });
    frame.srcdoc = html;
    slot.append(frame);
    this.frame = frame;
  }

  private stop(): void {
    this.clearTimers();
    this.frame?.remove();
    this.frame = null;
    this.ready = false;
    this.stopped.set(true);
    this.status.set('stopped');
  }

  private clearTimers(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.unlockTimer) clearTimeout(this.unlockTimer);
    this.readyTimer = this.unlockTimer = null;
  }

  private post(message: HostMessage): void {
    this.frame?.contentWindow?.postMessage({ dimaUi: 1, token: this.token, ...message }, '*');
  }

  private postTheme(): void {
    if (!this.frame || !this.ready) return;
    const theme = this.currentTheme();
    const key = JSON.stringify(theme);
    if (key === this.sentTheme) return;
    this.sentTheme = key;
    this.frame.style.colorScheme = theme.mode;
    this.post({ type: 'theme', theme });
  }

  private applyState(state: UiFrameState): void {
    if (state === 'open') {
      if (this.lockedByHost) { this.lockedByHost = false; this.post({ type: 'unlock' }); }
      return;
    }
    if (this.unlockTimer) clearTimeout(this.unlockTimer);
    this.unlockTimer = null;
    this.lockedByHost = true;
    this.post({ type: 'lock' });
  }

  private unlockNow(): void {
    if (this.unlockTimer) clearTimeout(this.unlockTimer);
    this.unlockTimer = null;
    this.post({ type: 'unlock' });
  }

  /**
   * A click or key press inside the card also activates this page (user activation propagates to ancestor frames),
   * so the card's own code can never fake one. Browsers without the API fall back to the kit's check.
   */
  private userActed(): boolean {
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return !activation || activation.isActive;
  }

  private receive(event: MessageEvent): void {
    if (!this.frame || event.source !== this.frame.contentWindow) return;
    const message = validateFrameMessage(event.data, this.token);
    if (!message) return;
    // Sending answers and opening pages need a real user action, and a card that is still current.
    if ((message.type === 'submit' || message.type === 'navigate') && !this.userActed()) {
      if (message.type === 'submit' && this.state() === 'open') this.post({ type: 'unlock' });
      return;
    }
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.status.set('ready');
        this.height.set(message.height);
        this.postTheme();
        if (this.state() !== 'open') this.post({ type: 'lock' });
        return;
      case 'resize':
        this.height.set(message.height);
        return;
      case 'submit': {
        const now = performance.now();
        // Only a block that waits for an answer, only while open, at most once a second.
        if (this.state() !== 'open' || !this.block().waitForInput) {
          if (this.state() === 'open') this.post({ type: 'unlock' });
          return;
        }
        if (now - this.lastSubmit < ACTION_GAP_MS) return;
        this.lastSubmit = now;
        this.submitted.emit(message.values);
        if (this.unlockTimer) clearTimeout(this.unlockTimer);
        this.unlockTimer = setTimeout(() => { if (this.state() === 'open') this.unlockNow(); }, SUBMIT_UNLOCK_MS);
        return;
      }
      case 'stopped':
        this.stop();
        return;
      case 'navigate': {
        const now = performance.now();
        if (now - this.lastNavigate < ACTION_GAP_MS) return;
        this.lastNavigate = now;
        this.navigateRequest.emit(message.route);
        return;
      }
    }
  }
}
