import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { NgOptimizedImage, NgStyle } from '@angular/common';
import { WidgetCatalog, WidgetEntry, WidgetLayout, WidgetRole, WidgetState } from './widgets-api.service';
import { widgetText } from './widget-text';
import { RouletteDisplayComponent } from '../roulette/roulette-display.component';
import { widgetRoulette } from './widget-roulette';
import { widgetGeometry, WidgetRect } from './widget-layout';

@Component({ selector: 'app-widget-display', imports: [NgOptimizedImage, NgStyle, RouletteDisplayComponent], templateUrl: './widget-display.component.html', styleUrl: './widget-display.component.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class WidgetDisplayComponent {
  readonly catalog = input.required<WidgetCatalog>();
  readonly state = input.required<WidgetState>();
  readonly editor = input(false);
  readonly gameplayPreview = input(false);
  readonly layoutChange = output<WidgetLayout>();
  readonly frame = viewChild<ElementRef<HTMLElement>>('frame');
  readonly infoBody = viewChild<ElementRef<HTMLElement>>('infoBody');
  readonly rouletteBody = viewChild<ElementRef<HTMLElement>>('rouletteBody');
  readonly scale = signal(1);
  readonly infoHeight = signal(500);
  readonly rouletteHeight = signal(540);
  readonly now = signal(Date.now());
  private offset = 0;
  private drag: AbortController | null = null;
  readonly failedImages = signal<ReadonlySet<string>>(new Set());
  readonly role = computed<WidgetRole>(() => this.state().packId.includes('-survivor-') ? 'survivor' : 'killer');
  readonly mode = computed(() => this.state().run?.operation ?? this.state().packId.split('-').at(-1));
  readonly gameplay = computed(() => this.gameplayPreview() || this.state().phase === 'complete' && this.mode() === 'challenge');
  readonly geometry = computed(() => widgetGeometry(this.state().config.layout, this.gameplay()));
  readonly entriesById = computed(() => new Map(this.catalog().entries.map(e => [e.id, e])));
  readonly pool = computed(() => {
    const state = this.state(), kind = state.run?.draw?.kind ?? (this.mode() === 'perks' ? 'perk' : 'character');
    const ids = state.run?.draw?.poolIds;
    return ids ? ids.flatMap(id => { const entry = this.entriesById().get(id); return entry ? [entry] : []; }) : this.catalog().entries.filter(e => e.kind === kind && e.role === this.role() && (state.config.includeUnavailable || e.available) && !state.config.excludedIds.includes(e.id));
  });
  readonly character = computed(() => this.entriesById().get(this.state().run?.characterId ?? this.state().loadouts[this.role()].characterId ?? '') ?? null);
  readonly perks = computed(() => (this.state().run?.perkIds ?? this.state().loadouts[this.role()].perkIds).flatMap(id => { const entry = this.entriesById().get(id); return entry ? [entry] : []; }));
  readonly perkSlots = computed(() => Array.from({length: 4}, (_, i) => this.perks()[i] ?? null));
  readonly roulette = computed(() => widgetRoulette(this.state(), this.pool(), this.title()));
  readonly rouletteScale = computed(() => Math.min(1.06, (this.geometry().active.width - 96) / 760, 576 / this.rouletteHeight()));
  readonly infoScale = computed(() => Math.min(1, (this.geometry().info.width - 52) / 456, (this.geometry().info.height - 52) / this.infoHeight()));
  readonly voteStage = computed(() => ['poll-starting', 'polling', 'poll-error', 'reveal'].includes(this.state().phase) || this.mode() === 'poll' && this.state().phase === 'complete');
  readonly countdown = computed(() => Math.max(0, Math.ceil(((this.state().run?.pollEndsAt ?? 0) - this.now() - this.offset) / 1000)));
  readonly totalVotes = computed(() => this.state().run?.votes.reduce((total, votes) => total + votes, 0) ?? 0);
  readonly title = computed(() => this.voteStage() ? this.t('pollTitle') : this.gameplay() ? this.t('roundReady') : this.t('pack.' + this.role() + '.' + (this.state().run?.draw?.kind === 'perk' || this.mode() === 'perks' ? 'perks' : 'characters') + '.title'));
  readonly roles: WidgetRole[] = ['killer','survivor'];
  constructor() {
    effect(() => { this.offset = this.state().serverTime - Date.now(); });
    effect(onCleanup => {
      const frame = this.frame()?.nativeElement, info = this.infoBody()?.nativeElement, roulette = this.rouletteBody()?.nativeElement;
      const observer = new ResizeObserver(() => {
        if (frame) this.scale.set(frame.clientWidth / 1920);
        if (info) this.infoHeight.set(Math.max(1, info.offsetHeight));
        if (roulette) this.rouletteHeight.set(Math.max(1, roulette.offsetHeight));
      });
      if (frame) observer.observe(frame); if (info) observer.observe(info); if (roulette) observer.observe(roulette);
      onCleanup(() => observer.disconnect());
    });
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => { clearInterval(timer); this.drag?.abort(); });
  }
  rect(rect: WidgetRect): Record<string, string> { return {left: rect.x+'px', top: rect.y+'px', width: rect.width+'px', height: rect.height+'px'}; }
  t(key: string, params?: Record<string, string | number>): string { return widgetText(this.state().config.language, key, params); }
  label(entry: WidgetEntry): string { return this.state().config.language === 'es' ? entry.spanish : entry.english; }
  imageFailed(entry: WidgetEntry): void { this.failedImages.update(ids => new Set([...ids, entry.id])); }
  voteShare(index: number): number { return this.totalVotes() ? Math.round((this.state().run!.votes[index] ?? 0) / this.totalVotes() * 100) : 0; }
  stars(role: WidgetRole): number[] { return Array.from({length: Math.min(10, this.state().config.targets[role])}, (_, i) => i); }
  resize(event: PointerEvent, axis: 'width' | 'height' | 'both'): void {
    if (!this.editor()) return;
    event.preventDefault(); this.drag?.abort(); const abort = this.drag = new AbortController(), layout = {...this.state().config.layout};
    const x = event.clientX, y = event.clientY, scale = this.scale();
    const left = layout.cameraCorner.endsWith('left'), top = layout.cameraCorner.startsWith('top');
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', e => this.changeSize(layout, axis, (e.clientX-x)/scale*(left?1:-1), (e.clientY-y)/scale*(top?1:-1)), {signal: abort.signal});
    window.addEventListener('pointerup', () => abort.abort(), {once: true, signal: abort.signal});
    window.addEventListener('pointercancel', () => abort.abort(), {once: true, signal: abort.signal});
  }
  resizeKey(event: KeyboardEvent, axis: 'width' | 'height' | 'both'): void {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const step = event.shiftKey ? 1 : 16;
    this.changeSize(this.state().config.layout, axis, event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0, event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0);
  }
  private changeSize(layout: WidgetLayout, axis: 'width' | 'height' | 'both', x: number, y: number): void {
    this.layoutChange.emit({...layout, cameraWidth: axis === 'height' ? layout.cameraWidth : Math.round(Math.max(320,Math.min(800,layout.cameraWidth+x))), cameraHeight: axis === 'width' ? layout.cameraHeight : Math.round(Math.max(180,Math.min(640,layout.cameraHeight+y)))});
  }
}
