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
    const state = this.state(), kind = this.pack().mode === 'perks' || ['perk-spin', 'perk-result'].includes(state.phase) ? 'perk' : 'character';
    const ids = state.run?.draw?.kind === kind ? state.run.draw.poolIds : null;
    return ids ? ids.flatMap(id => { const entry = this.entriesById().get(id); return entry ? [entry] : []; }) : this.catalog().entries.filter(e => e.kind === kind && e.role === this.pack().role && (state.config.includeUnavailable || e.available) && !state.config.excludedIds.includes(e.id));
  });
  readonly entriesById = computed(() => new Map(this.catalog().entries.map(e => [e.id, e])));
  readonly character = computed(() => this.entriesById().get(this.state().run?.characterId ?? '') ?? null);
  readonly perks = computed(() => (this.state().run?.perkIds ?? []).flatMap(id => { const entry = this.entriesById().get(id); return entry ? [entry] : []; }));
  readonly roulette = computed(() => widgetRoulette(this.state(), this.pool(), this.title()));
  readonly voteStage = computed(() => ['poll-starting', 'polling', 'poll-error', 'reveal'].includes(this.state().phase));
  readonly countdown = computed(() => Math.max(0, Math.ceil(((this.state().run?.pollEndsAt ?? 0) - this.now() - this.offset) / 1000)));
  readonly totalVotes = computed(() => this.state().run?.votes.reduce((total, votes) => total + votes, 0) ?? 0);
  readonly pointsVotes = computed(() => this.state().run?.channelPointsVotes ?? [0, 0, 0, 0, 0]);
  voteShare(index: number): number { return this.totalVotes() ? Math.round((this.state().run!.votes[index] ?? 0) / this.totalVotes() * 100) : 0; }
  regularVotes(index: number): number { return Math.max(0, (this.state().run?.votes[index] ?? 0) - this.pointsVotes()[index]); }
  readonly title = computed(() => this.t(`pack.${this.pack().role}.${this.pack().mode}.title`));
  constructor() {
    effect(() => { this.offset = this.state().serverTime - Date.now(); });
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  t(key: string, params?: Record<string, string | number>): string { return widgetText(this.state().config.language, key, params); }
  label(entry: WidgetEntry): string { return this.state().config.language === 'es' ? entry.spanish : entry.english; }
  imageFailed(entry: WidgetEntry): void { this.failedImages.update(ids => new Set([...ids, entry.id])); }
}
