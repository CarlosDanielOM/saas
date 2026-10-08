import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { WidgetCatalog, WidgetEntry, WidgetState } from './widgets-api.service';
import { widgetText } from './widget-text';
import { RouletteDisplayComponent } from '../roulette/roulette-display.component';
import { widgetRoulette } from './widget-roulette';

@Component({ selector: 'app-widget-display', imports: [NgOptimizedImage, RouletteDisplayComponent], templateUrl: './widget-display.component.html', styleUrl: './widget-display.component.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class WidgetDisplayComponent {
  readonly catalog = input.required<WidgetCatalog>();
  readonly state = input.required<WidgetState>();
  readonly now = signal(Date.now());
  private offset = 0;
  readonly failedImages = signal<ReadonlySet<string>>(new Set());
  readonly pack = computed(() => this.catalog().packs.find(p => p.id === this.state().packId)!);
  readonly pool = computed(() => {
    const state = this.state(), kind = this.pack().mode === 'perks' || state.phase === 'perk-spin' ? 'perk' : 'character';
    const ids = state.run?.draw?.kind === kind ? state.run.draw.poolIds : null;
    return ids ? ids.flatMap(id => { const entry = this.entriesById().get(id); return entry ? [entry] : []; }) : this.catalog().entries.filter(e => e.kind === kind && e.role === this.pack().role && (state.config.includeUnavailable || e.available) && !state.config.excludedIds.includes(e.id));
  });
  readonly spinning = computed(() => ['character-spin', 'perk-spin'].includes(this.state().phase));
  readonly progress = computed(() => {
    const draw = this.state().run?.draw;
    return draw && this.spinning() ? Math.max(0, Math.min(1, (this.now() + this.offset - draw.startedAt) / (draw.endsAt - draw.startedAt))) : 1;
  });
  readonly entriesById = computed(() => new Map(this.catalog().entries.map(e => [e.id, e])));
  readonly current = computed(() => {
    const draw = this.state().run?.draw, pool = this.pool();
    if (!draw) return pool[0] ?? null;
    if (!this.spinning() || this.progress() >= 1) return this.entriesById().get(draw.itemId) ?? null;
    return pool[Math.floor((1 - Math.pow(1 - this.progress(), 3)) * 60) % pool.length] ?? null;
  });
  readonly character = computed(() => this.entriesById().get(this.state().run?.characterId ?? '') ?? null);
  readonly perks = computed(() => (this.state().run?.perkIds ?? []).flatMap(id => { const entry = this.entriesById().get(id); return entry ? [entry] : []; }));
  readonly wheel = computed(() => this.pack().mode === 'perks' || this.state().phase === 'perk-spin');
  readonly roulette = computed(() => widgetRoulette(this.state(), this.pool(), this.title()));
  readonly cards = computed(() => {
    const pool = this.pool(), winner = this.entriesById().get(this.state().run?.draw?.itemId ?? '');
    const items = pool.slice(0, 8); if (winner && !items.includes(winner)) items.push(winner);
    else if (pool[8]) items.push(pool[8]); return items;
  });
  readonly highlight = computed(() => this.spinning() && this.progress() < 1 ? Math.floor((1 - Math.pow(1 - this.progress(), 3)) * 60) % Math.max(1, this.cards().length) : this.cards().findIndex(e => e.id === this.state().run?.draw?.itemId));
  readonly voteStage = computed(() => ['poll-starting', 'polling', 'poll-error', 'reveal'].includes(this.state().phase));
  readonly countdown = computed(() => Math.max(0, Math.ceil(((this.state().run?.pollEndsAt ?? 0) - this.now() - this.offset) / 1000)));
  readonly totalVotes = computed(() => this.state().run?.votes.reduce((total, votes) => total + votes, 0) ?? 0);
  readonly pointsVotes = computed(() => this.state().run?.channelPointsVotes ?? [0, 0, 0, 0, 0]);
  voteShare(index: number): number { return this.totalVotes() ? Math.round((this.state().run!.votes[index] ?? 0) / this.totalVotes() * 100) : 0; }
  regularVotes(index: number): number { return Math.max(0, (this.state().run?.votes[index] ?? 0) - this.pointsVotes()[index]); }
  readonly title = computed(() => this.t(`pack.${this.pack().role}.${this.pack().mode}.title`));
  constructor() {
    effect(() => { this.offset = this.state().serverTime - Date.now(); });
    const timer = setInterval(() => this.now.set(Date.now()), 50);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  t(key: string, params?: Record<string, string | number>): string { return widgetText(this.state().config.language, key, params); }
  label(entry: WidgetEntry): string { return this.state().config.language === 'es' ? entry.spanish : entry.english; }
  imageFailed(entry: WidgetEntry): void { this.failedImages.update(ids => new Set([...ids, entry.id])); }
}
