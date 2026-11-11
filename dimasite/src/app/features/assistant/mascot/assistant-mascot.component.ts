import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, PLATFORM_ID, afterNextRender, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { NavigationStart, Router } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { ThrottleClickDirective } from '../../../shared/directives/throttle-click.directive';
import { AssistantGuideService, type GuideTarget } from '../assistant-guide.service';
import { AssistantPresenceService } from '../assistant-presence.service';
import { ASSISTANT_ANCHORS, routeKeyForPath } from '../assistant-routes';
import { anchorSelector, flightPoint, isOnScreen, placeFigure, placeLabel, ringBox, type Box } from './guide-geometry';
import { MascotFigureComponent } from './mascot-figure.component';

/** Guide figure size (px); the viewBox is 944×1024. */
const FIG = { width: 64, height: 70 };
const FIND_MS = 8000;
const SHOW_MS = 8000;
const FLY_MS = 650;
const BACK_MS = 450;
/** Pointer presses this soon after a guide starts belong to the click that started it. */
const START_GRACE_MS = 250;
const SEEN_KEY = 'dimasite.assistant.mascotSeen';
/** Bottom bars the docked mascot must not cover (sticky save bars, anything a page marks). */
const AVOID = '.lf-save-bar, [data-assistant-avoid]';
/** The panel marks its surface so the dock can stand at its edge. */
const PANEL = '[data-assistant-panel]';

type Phase = 'off' | 'search' | 'fly' | 'show' | 'back';
interface Point { x: number; y: number }

/**
 * The assistant's character. Docked bottom-right (tap = open/close the panel); "show me where" flies a copy of it to an
 * element marked `data-assistant-anchor` on a fixed full-screen layer that never takes clicks or moves the page.
 */
@Component({
  selector: 'app-assistant-mascot',
  imports: [MascotFigureComponent, ThrottleClickDirective],
  templateUrl: './assistant-mascot.component.html',
  styleUrl: './assistant-mascot.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssistantMascotComponent {
  readonly presence = inject(AssistantPresenceService);
  private readonly guide = inject(AssistantGuideService);
  private readonly language = inject(LanguageService);
  private readonly router = inject(Router);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Dock offsets: raise above stuck bottom bars, slide to the panel's edge, or tuck away behind a phone sheet. */
  readonly lift = signal(0);
  readonly shift = signal(0);
  readonly tucked = signal(false);
  /** Phones show the default "Ask" bubble until the assistant has been opened once. */
  readonly seen = signal(false);
  readonly greeting = signal(false);

  readonly phase = signal<Phase>('off');
  readonly guideLabel = signal('');
  readonly guideFlip = signal(false);
  /** Screen-reader line for the guide (kept outside the layer so it is announced). */
  readonly liveText = signal('');

  readonly mood = this.presence.mood;
  readonly busy = computed(() => this.mood() === 'thinking' || this.mood() === 'reading');
  readonly customBubble = computed(() => this.presence.bubble() ?? (this.presence.unread() ? this.t('unreadBubble') : null));
  readonly bubbleText = computed(() => this.customBubble() ?? this.t('ask'));
  readonly away = computed(() => this.phase() === 'fly' || this.phase() === 'show' || this.phase() === 'back');
  readonly triggerLabel = computed(() => this.presence.open() ? this.t('close') : this.presence.unread() ? this.t('openUnread') : this.t('open'));

  private readonly dockArt = viewChild<ElementRef<HTMLElement>>('dockArt');
  private readonly dockButton = viewChild<ElementRef<HTMLElement>>('dockButton');
  private readonly guideFig = viewChild<ElementRef<HTMLElement>>('guideFig');
  private readonly ringEl = viewChild<ElementRef<HTMLElement>>('ring');
  private readonly labelEl = viewChild<ElementRef<HTMLElement>>('label');
  private readonly layerEl = viewChild<ElementRef<HTMLElement>>('layer');

  // Guide run state (plain fields: read every animation frame).
  private run = 0;
  private target: HTMLElement | null = null;
  private targetRadius = 8;
  private anchorRoute: string | null = null;
  private startedAt = 0;
  private from: Point = { x: 0, y: 0 };
  private fromScale = 1;
  private phaseStart = 0;
  private figPos: Point | null = null;
  private frame = 0;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private findTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private lastRing = '';
  private greetTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private panelObserved: Element | null = null;
  /** Left edge of the open desktop side panel: the guide keeps the figure and label left of it. */
  private panelLeft: number | null = null;

  constructor() {
    const destroy = inject(DestroyRef);
    const listeners = new AbortController();
    destroy.onDestroy(() => {
      this.stopGuide();
      listeners.abort();
      if (this.greetTimer) clearTimeout(this.greetTimer);
    });
    if (!this.isBrowser) return;

    try { this.seen.set(localStorage.getItem(SEEN_KEY) === '1'); } catch { /* storage blocked: keep showing the hint */ }
    effect(() => {
      if (!this.presence.open() || untracked(this.seen)) return;
      this.seen.set(true);
      try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* fine */ }
    });

    this.watchDock(destroy);

    effect(() => {
      const target = this.guide.target();
      const enabled = this.presence.enabled();
      untracked(() => {
        if (target && enabled) this.startGuide(target);
        else if (this.phase() !== 'back') this.stopGuide();
      });
    });

    // A move to another page ends the guide; the navigation to the anchor's own page doesn't.
    const sub = this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationStart) || this.phase() === 'off') return;
      const segments = this.router.parseUrl(event.url).root.children['primary']?.segments.map((segment) => segment.path) ?? [];
      if (routeKeyForPath(segments.slice(1)) !== this.anchorRoute) this.stopGuide(true);
    });
    destroy.onDestroy(() => sub.unsubscribe());

    // Any press anywhere (capture, passive: never stopped) or Escape ends the guide.
    const active = () => this.phase() !== 'off' && this.phase() !== 'back';
    document.addEventListener('pointerdown', () => {
      if (active() && performance.now() - this.startedAt > START_GRACE_MS) this.dismiss();
    }, { capture: true, passive: true, signal: listeners.signal });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && active()) this.dismiss();
    }, { capture: true, signal: listeners.signal });
  }

  t(key: string): string {
    return this.language.translate('assistantMascot.' + key);
  }

  toggle(): void {
    this.presence.toggle();
  }

  greet(): void {
    if (this.reducedMotion() || this.presence.open()) return;
    this.greeting.set(true);
    if (this.greetTimer) clearTimeout(this.greetTimer);
    this.greetTimer = setTimeout(() => this.greeting.set(false), 1050);
  }

  // ---------------------------------------------------------------- dock

  private watchDock(destroy: DestroyRef): void {
    let queued = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; this.measureDock(); });
    };
    const later = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(measure, 120);
    };
    const events = new AbortController();
    afterNextRender(() => {
      window.addEventListener('scroll', measure, { passive: true, capture: true, signal: events.signal });
      window.addEventListener('resize', measure, { passive: true, signal: events.signal });
      window.visualViewport?.addEventListener('resize', measure, { passive: true, signal: events.signal });
      const pageObserver = new MutationObserver(later);
      pageObserver.observe(document.body, { childList: true, subtree: true });
      this.resizeObserver = new ResizeObserver(measure);
      destroy.onDestroy(() => {
        pageObserver.disconnect();
        this.resizeObserver?.disconnect();
        events.abort();
        if (debounce) clearTimeout(debounce);
      });
      measure();
    });
    // Opening/closing the panel (and its slide-in) changes where the dock belongs.
    effect(() => {
      this.presence.open();
      this.presence.enabled();
      untracked(() => { measure(); setTimeout(measure, 320); });
    });
  }

  private measureDock(): void {
    if (!this.presence.enabled()) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let shift = 0;
    let tucked = false;
    this.panelLeft = null;
    if (this.presence.open()) {
      // Side panel: stand at its edge. Bottom sheet (or no marked panel): tuck away behind it.
      const panel = document.querySelector(PANEL) ?? document.querySelector('app-assistant-panel > *');
      if (panel !== this.panelObserved) {
        if (this.panelObserved) this.resizeObserver?.unobserve(this.panelObserved);
        if (panel) this.resizeObserver?.observe(panel);
        this.panelObserved = panel;
      }
      const rect = panel?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0 && vw >= 640 && rect.left > vw * 0.3) {
        shift = Math.max(0, Math.round(vw - rect.left - 26));
        this.panelLeft = rect.left;
      } else tucked = true;
    }
    const button = this.dockButton()?.nativeElement.getBoundingClientRect();
    const width = button?.width || 140;
    const bandLeft = vw - shift - width - 16;
    const bandRight = vw - shift;
    let lift = 0;
    for (const bar of Array.from(document.querySelectorAll<HTMLElement>(AVOID))) {
      if (bar.closest('app-assistant-root')) continue;
      const rect = bar.getBoundingClientRect();
      // Only bars stuck to the bottom of the screen (sticky or fixed) under the dock.
      if (!rect.width || !rect.height || rect.bottom < vh - 48 || rect.top >= vh) continue;
      if (rect.right <= bandLeft || rect.left >= bandRight) continue;
      const style = getComputedStyle(bar);
      if ((style.position !== 'sticky' && style.position !== 'fixed') || style.visibility === 'hidden') continue;
      lift = Math.max(lift, Math.round(vh - rect.top + 8));
    }
    this.lift.set(Math.min(lift, Math.round(vh * 0.5)));
    this.shift.set(shift);
    this.tucked.set(tucked);
  }

  // ---------------------------------------------------------------- guide

  private reducedMotion(): boolean {
    return this.isBrowser && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private startGuide(target: GuideTarget): void {
    // A new target while the figure is out: fly on from where it is.
    const resume = this.figPos && this.away() ? { ...this.figPos } : null;
    this.stopGuide();
    const run = ++this.run;
    this.anchorRoute = ASSISTANT_ANCHORS[target.anchor] ?? null;
    this.startedAt = performance.now();
    this.guideLabel.set(target.label);
    this.phase.set('search');
    const found = () => {
      if (run !== this.run) return true;
      const element = this.findAnchor(target.anchor);
      if (!element) return false;
      this.observer?.disconnect();
      this.observer = null;
      if (this.findTimer) clearTimeout(this.findTimer);
      this.findTimer = null;
      this.show(element, resume);
      return true;
    };
    if (found()) return;
    // The page may still be loading (navigation, data): watch for the anchor for a while, then give up quietly.
    let queued = false;
    this.observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; found(); });
    });
    this.observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['data-assistant-anchor', 'class', 'hidden', 'open', 'style'],
    });
    this.findTimer = setTimeout(() => { if (run === this.run && this.phase() === 'search') this.stopGuide(true); }, FIND_MS);
  }

  /** First visible element with the anchor; opens closed `<details>` around one that is otherwise hidden. */
  private findAnchor(key: string): HTMLElement | null {
    const all = Array.from(document.querySelectorAll<HTMLElement>(anchorSelector(key))).filter((element) => !element.closest('app-assistant-root'));
    const visible = all.find((element) => this.isVisible(element));
    if (visible) return visible;
    for (const element of all) {
      let details = this.closedDetails(element);
      if (!details) continue;
      while (details) {
        details.open = true;
        details = this.closedDetails(element);
      }
      if (this.isVisible(element)) return element;
    }
    return null;
  }

  /** The closest closed `<details>` hiding this element (its own `<summary>` stays visible, so that doesn't count). */
  private closedDetails(element: HTMLElement): HTMLDetailsElement | null {
    let details = element.parentElement?.closest<HTMLDetailsElement>('details:not([open])') ?? null;
    while (details) {
      const summary = details.querySelector(':scope > summary');
      if (!summary?.contains(element)) return details;
      details = details.parentElement?.closest<HTMLDetailsElement>('details:not([open])') ?? null;
    }
    return null;
  }

  private isVisible(element: HTMLElement): boolean {
    // Content of a closed <details> keeps its layout boxes in Chrome (hidden by content-visibility), so check it first.
    if (!element.isConnected || !element.getClientRects().length || this.closedDetails(element)) return false;
    if (typeof element.checkVisibility === 'function') return element.checkVisibility({ visibilityProperty: true });
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  private show(element: HTMLElement, resume: Point | null): void {
    const reduced = this.reducedMotion();
    this.target = element;
    this.targetRadius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 8;
    this.lastRing = '';
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'instant' : 'smooth' });
    // The flight starts where the docked figure is (or just below the screen when it is tucked away).
    if (resume) {
      this.from = resume;
      this.fromScale = 1;
    } else {
      const home = this.homePoint();
      this.from = home.at;
      this.fromScale = home.scale;
    }
    this.figPos = null;
    this.phaseStart = performance.now();
    this.liveText.set(this.language.translate('assistantMascot.pointing', { label: this.guideLabel() }));
    if (reduced) this.arrive();
    else this.phase.set('fly');
    this.loop();
  }

  private arrive(): void {
    this.phase.set('show');
    if (this.showTimer) clearTimeout(this.showTimer);
    const run = this.run;
    this.showTimer = setTimeout(() => { if (run === this.run) this.dismiss(); }, SHOW_MS);
  }

  /** User interaction or timeout: fly home, and tell the panel the guide is over. */
  private dismiss(): void {
    if (this.phase() === 'off' || this.phase() === 'back') return;
    if (this.phase() === 'search' || this.reducedMotion() || !this.figPos) {
      this.stopGuide(true);
      return;
    }
    if (this.showTimer) clearTimeout(this.showTimer);
    this.showTimer = null;
    this.from = { ...this.figPos };
    this.phaseStart = performance.now();
    this.phase.set('back');
    this.liveText.set('');
    this.guide.clear();
  }

  /** Ends the guide now (no flight back). `clear` also clears the shared target. */
  private stopGuide(clear = false): void {
    this.run++;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.showTimer) clearTimeout(this.showTimer);
    if (this.findTimer) clearTimeout(this.findTimer);
    this.showTimer = this.findTimer = null;
    this.observer?.disconnect();
    this.observer = null;
    this.target = null;
    this.figPos = null;
    this.phase.set('off');
    this.liveText.set('');
    if (clear && this.guide.target()) this.guide.clear();
  }

  private loop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    const run = this.run;
    const tick = (now: number) => {
      if (run !== this.run) return;
      this.frame = requestAnimationFrame(tick);
      this.paint(now);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** One animation frame: the figure, ring and label follow the element by transform only. */
  private paint(now: number): void {
    const figure = this.guideFig()?.nativeElement;
    const ring = this.ringEl()?.nativeElement;
    const label = this.labelEl()?.nativeElement;
    const layer = this.layerEl()?.nativeElement;
    if (!figure || !ring || !label || !layer) return; // the layer renders on the next change detection
    const element = this.target;
    if (!element?.isConnected) {
      this.stopGuide(this.phase() !== 'back');
      return;
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // Beside an open desktop panel only the part left of it is free.
    const free = { width: this.panelLeft && this.panelLeft > 320 ? this.panelLeft : viewport.width, height: viewport.height };
    const rect = element.getBoundingClientRect();
    const box: Box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    const spot = placeFigure(box, free, FIG);
    const phase = this.phase();
    let at: Point = spot;
    let scale = 1;
    if (phase === 'fly') {
      const progress = (now - this.phaseStart) / FLY_MS;
      at = flightPoint(this.from, spot, progress);
      scale = this.fromScale + (1 - this.fromScale) * Math.min(1, progress);
      if (progress >= 1) this.arrive();
    } else if (phase === 'back') {
      const progress = (now - this.phaseStart) / BACK_MS;
      const home = this.homePoint();
      at = flightPoint(this.from, home.at, progress, 28);
      scale = 1 + (home.scale - 1) * Math.min(1, progress);
      if (progress >= 1) {
        this.stopGuide(false);
        return;
      }
    }
    if (phase !== 'back' && this.guideFlip() !== spot.flip) this.guideFlip.set(spot.flip);
    this.figPos = at;
    figure.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
    const padded = ringBox(box);
    const ringKey = `${padded.width.toFixed(1)}x${padded.height.toFixed(1)}`;
    if (ringKey !== this.lastRing) {
      // Size changes only touch the overlay's own box (fixed layer, out of the page flow).
      ring.style.width = `${padded.width}px`;
      ring.style.height = `${padded.height}px`;
      ring.style.borderRadius = `${this.targetRadius + 6}px`;
      this.lastRing = ringKey;
    }
    ring.style.transform = `translate3d(${padded.left.toFixed(1)}px, ${padded.top.toFixed(1)}px, 0)`;
    const labelAt = placeLabel(spot, FIG, { width: label.offsetWidth, height: label.offsetHeight }, free, spot.side);
    label.style.transform = `translate3d(${labelAt.x.toFixed(1)}px, ${labelAt.y.toFixed(1)}px, 0)`;
    layer.dataset['offscreen'] = String(!isOnScreen(box, viewport));
  }

  /** Where the docked figure is (top-left, viewport px) and its size relative to the guide figure. */
  private homePoint(): { at: Point; scale: number } {
    const art = this.dockArt()?.nativeElement.getBoundingClientRect();
    if (art && art.width && !this.tucked()) return { at: { x: art.left, y: art.top }, scale: art.width / FIG.width };
    return { at: { x: window.innerWidth - FIG.width - 16, y: window.innerHeight + 8 }, scale: 1 };
  }
}
