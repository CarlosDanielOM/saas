import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { ThrottleClickDirective } from '../../../shared/directives/throttle-click.directive';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { AssistantPresenceService } from '../assistant-presence.service';
import { AssistantStore } from '../assistant.store';
import { AssistantChangesComponent } from './assistant-changes.component';
import { AssistantComposerComponent } from './assistant-composer.component';
import { AssistantSessionsComponent } from './assistant-sessions.component';
import { AssistantThreadComponent } from './assistant-thread.component';

type Tab = 'chat' | 'changes';
type Sheet = 'full' | 'peek';

const DESKTOP = '(min-width: 1024px)';
/** Drag distance (px) that shrinks the sheet to the peek bar / expands it again. */
const DRAG_SHRINK = 110;
const DRAG_EXPAND = 40;

/**
 * The assistant panel. Desktop (≥1024 px): side panel under the navbar, the page stays usable.
 * Tablet/phone: bottom sheet (92dvh) with a drag handle; after the assistant opens a page it
 * shrinks to a peek bar so the page is visible. Rendered once on first open, then only hidden,
 * so chats, forms and scroll position survive closing it.
 */
@Component({
  selector: 'app-assistant-panel',
  imports: [
    AssistantChangesComponent,
    AssistantComposerComponent,
    AssistantSessionsComponent,
    AssistantThreadComponent,
    LfIconComponent,
    ThrottleClickDirective,
  ],
  providers: [AssistantStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './assistant-panel.component.html',
  styleUrl: './assistant-panel.component.css',
})
export class AssistantPanelComponent {
  /** Login from the URL (`/:streamer/...`). */
  readonly streamer = input.required<string>();

  readonly store = inject(AssistantStore);
  readonly presence = inject(AssistantPresenceService);
  private readonly i18n = inject(LanguageService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly composer = viewChild(AssistantComposerComponent);

  readonly tab = signal<Tab>('chat');
  readonly listOpen = signal(false);
  readonly sheet = signal<Sheet>('full');
  /** Rendered after the first open; afterwards only hidden. */
  readonly rendered = signal(false);
  readonly desktop = signal(false);
  /** Bottom of the sticky navbar (desktop side panel starts there). */
  readonly navBottom = signal<number | null>(null);
  readonly dragOffset = signal(0);
  readonly dragging = signal(false);

  readonly isOpen = computed(() => this.presence.open() && this.presence.enabled());
  readonly peek = computed(() => !this.desktop() && this.sheet() === 'peek');
  readonly subtitle = computed(() => {
    if (this.tab() === 'changes') return this.t('assistant.tabs.changes');
    const title = this.store.currentSession()?.title?.trim();
    return title || this.t('assistant.sessions.untitled');
  });
  readonly peekText = computed(() => {
    if (this.store.waitingForUser()) return this.t('assistant.peek.needsYou');
    if (this.store.running()) return this.store.statusLine()?.label || this.t('assistant.peek.working');
    return this.t('assistant.peek.idle');
  });
  readonly transform = computed(() => {
    const offset = this.dragOffset();
    return offset ? `translateY(${offset}px)` : null;
  });

  private returnFocus: HTMLElement | null = null;
  private dragStart: { y: number; id: number } | null = null;
  private dragMoved = false;

  constructor() {
    effect(() => {
      const streamer = this.streamer();
      untracked(() => void this.store.init(streamer));
    });
    effect(() => {
      const open = this.isOpen();
      untracked(() => (open ? this.opened() : this.closed()));
    });
    // Desktop: while the panel is open the page makes room for it (the layout narrows its content),
    // so nothing — a highlighted setting, a save bar — ever hides under the panel.
    effect(() => {
      const docked = this.desktop() && this.isOpen();
      if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-assistant-docked', docked);
    });
    this.destroyRef.onDestroy(() => {
      if (typeof document !== 'undefined') document.documentElement.removeAttribute('data-assistant-docked');
    });
    // The assistant opened a page: on phones and tablets, show the page under a peek bar.
    let lastPeek = 0;
    effect(() => {
      const count = this.store.peekRequest();
      if (count === lastPeek) return;
      lastPeek = count;
      untracked(() => {
        if (!this.desktop() && this.presence.open()) {
          this.sheet.set('peek');
          this.listOpen.set(false);
        }
      });
    });

    afterNextRender(() => {
      const desktop = window.matchMedia(DESKTOP);
      const sync = () => {
        this.desktop.set(desktop.matches);
        this.measureNav();
      };
      sync();
      desktop.addEventListener('change', sync);
      const navbar = document.querySelector('.auth-navbar');
      const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.measureNav()) : null;
      if (navbar) observer?.observe(navbar);
      window.addEventListener('resize', this.measureNav, { passive: true });
      this.destroyRef.onDestroy(() => {
        desktop.removeEventListener('change', sync);
        observer?.disconnect();
        window.removeEventListener('resize', this.measureNav);
      });
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(key, params);
  }

  close(): void {
    this.presence.hide();
  }

  expand(): void {
    this.sheet.set('full');
  }

  setTab(tab: Tab): void {
    this.tab.set(tab);
    this.listOpen.set(false);
    if (tab === 'changes' && this.store.changesState() !== 'loading') void this.store.loadChanges();
  }

  onTabKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: Tab = this.tab() === 'chat' ? 'changes' : 'chat';
    this.setTab(next);
    this.panel()?.nativeElement.querySelector<HTMLElement>(`#assistant-tab-${next}`)?.focus();
  }

  newChat(): void {
    this.store.newChat();
    this.setTab('chat');
    this.focusComposer();
  }

  toggleList(): void {
    this.listOpen.update((open) => !open);
    if (this.listOpen() && this.store.sessionsState() !== 'loading') void this.store.loadSessions();
  }

  closeList(): void {
    this.listOpen.set(false);
    setTimeout(() => this.panel()?.nativeElement.querySelector<HTMLElement>('[data-assistant-chats-btn]')?.focus());
  }

  pickedFromList(): void {
    this.listOpen.set(false);
    this.tab.set('chat');
    this.focusComposer();
  }

  sendExample(text: string): void {
    // Fill the box instead of sending: each message counts toward the daily limit.
    this.composer()?.prefill(text);
  }

  showChanges(): void {
    this.setTab('changes');
  }

  onEscape(event: Event): void {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (this.listOpen()) this.closeList();
    else this.close();
  }

  // ---------------------------------------------------------------- sheet drag (phones/tablets)

  onHandleDown(event: PointerEvent): void {
    if (this.desktop() || (event.pointerType === 'mouse' && event.button !== 0)) return;
    this.dragStart = { y: event.clientY, id: event.pointerId };
    this.dragMoved = false;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  onHandleMove(event: PointerEvent): void {
    if (!this.dragStart || event.pointerId !== this.dragStart.id) return;
    const dy = event.clientY - this.dragStart.y;
    if (Math.abs(dy) > 6) this.dragMoved = true;
    if (!this.dragMoved) return;
    this.dragging.set(true);
    // The full sheet drags down only; the peek bar drags up only.
    this.dragOffset.set(this.sheet() === 'full' ? Math.max(0, dy) : Math.min(0, dy) * 0.35);
  }

  onHandleUp(event: PointerEvent): void {
    if (!this.dragStart || event.pointerId !== this.dragStart.id) return;
    const dy = event.clientY - this.dragStart.y;
    this.dragStart = null;
    this.dragging.set(false);
    this.dragOffset.set(0);
    if (!this.dragMoved) return;
    if (this.sheet() === 'full' && dy > DRAG_SHRINK) this.sheet.set('peek');
    else if (this.sheet() === 'peek' && dy < -DRAG_EXPAND) this.sheet.set('full');
  }

  onHandleClick(): void {
    // A drag ends with a click event too; only a tap (or Enter/Space) toggles.
    if (this.dragMoved) {
      this.dragMoved = false;
      return;
    }
    this.sheet.update((sheet) => (sheet === 'full' ? 'peek' : 'full'));
  }

  // ---------------------------------------------------------------- open / close

  private opened(): void {
    if (!this.isBrowser) return;
    this.rendered.set(true);
    this.sheet.set('full');
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement && !this.panel()?.nativeElement.contains(active) ? active : null;
    void this.store.onPanelOpen();
    setTimeout(() => {
      if (!this.isOpen()) return;
      // Don't pop the phone keyboard over the conversation.
      if (this.desktop()) this.composer()?.focus();
      else this.panel()?.nativeElement.querySelector<HTMLElement>('#assistant-panel-title')?.focus({ preventScroll: true });
    });
  }

  private closed(): void {
    if (!this.isBrowser) return;
    this.listOpen.set(false);
    const panel = this.panel()?.nativeElement;
    const active = document.activeElement;
    // Only hand focus back when it was in the panel (or got lost when the panel hid).
    const focusInside = !active || active === document.body || (!!panel && panel.contains(active));
    if (focusInside && this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  private focusComposer(): void {
    setTimeout(() => this.composer()?.focus());
  }

  private readonly measureNav = (): void => {
    const navbar = document.querySelector('.auth-navbar');
    const bottom = navbar?.getBoundingClientRect().bottom;
    this.navBottom.set(bottom && bottom > 0 ? Math.round(bottom) : null);
  };
}
