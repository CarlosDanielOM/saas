import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { LanguageService } from '../../services/language.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { WIDGET_MAX_PERK_COPIES, WIDGET_MAX_PERK_WEIGHT, WIDGET_MIN_WHEEL_PERKS, WidgetCatalog, WidgetConfig, WidgetEntry, WidgetPerkTuning, WidgetRole } from './widgets-api.service';

export interface WidgetPool { includeUnavailable: boolean; excludedIds: string[]; perkTuning: Record<string, WidgetPerkTuning> }
type Tab = 'killer-character' | 'survivor-character' | 'killer-perk' | 'survivor-perk';
const TABS: { id: Tab; role: WidgetRole; kind: 'character' | 'perk'; key: string }[] = [
  {id: 'killer-character', role: 'killer', kind: 'character', key: 'killers'}, {id: 'survivor-character', role: 'survivor', kind: 'character', key: 'survivors'},
  {id: 'killer-perk', role: 'killer', kind: 'perk', key: 'killerPerks'}, {id: 'survivor-perk', role: 'survivor', kind: 'perk', key: 'survivorPerks'},
];
const poolOf = (config: WidgetConfig): WidgetPool => ({includeUnavailable: config.includeUnavailable, excludedIds: [...config.excludedIds], perkTuning: {...config.perkTuning}});
const same = (a: WidgetPool, b: WidgetPool) => JSON.stringify([a.includeUnavailable, [...a.excludedIds].sort(), Object.entries(a.perkTuning).sort()]) === JSON.stringify([b.includeUnavailable, [...b.excludedIds].sort(), Object.entries(b.perkTuning).sort()]);

/** Who and which perks can be drawn. Saved on its own so Bits edits to the wheel aren't overwritten by unrelated settings. */
@Component({ selector: 'app-widget-pool', imports: [NgOptimizedImage, LfIconComponent], templateUrl: './widget-pool.component.html', styleUrls: ['./widgets-base.css', './widget-pool.component.css'], changeDetection: ChangeDetectionStrategy.OnPush })
export class WidgetPoolComponent {
  readonly catalog = input.required<WidgetCatalog>();
  readonly config = input.required<WidgetConfig>();
  readonly role = input<WidgetRole>('killer');
  readonly disabled = input(false);
  readonly save = output<WidgetPool>();
  readonly language = inject(LanguageService);
  readonly tabs = TABS;
  readonly maxCopies = WIDGET_MAX_PERK_COPIES;
  readonly maxWeight = WIDGET_MAX_PERK_WEIGHT;
  readonly minWheel = WIDGET_MIN_WHEEL_PERKS;
  /** null = showing what is saved; an object = the streamer's unsaved edit and what it started from. */
  private readonly draft = signal<{ pool: WidgetPool; base: WidgetPool } | null>(null);
  readonly tab = signal<Tab | null>(null);
  readonly query = signal('');
  readonly limit = signal(40);
  readonly tuning = signal(false);
  readonly failedImages = signal<ReadonlySet<string>>(new Set());
  /** Desktop shows every perk's steppers inline; phones open one perk at a time to keep the list short. */
  readonly wide = signal(false);
  readonly expanded = signal<string | null>(null);

  readonly saved = computed(() => poolOf(this.config()));
  readonly pool = computed(() => this.draft()?.pool ?? this.saved());
  readonly dirty = computed(() => this.draft() !== null);
  /** A Bits action changed the wheel after editing started; saving would overwrite it. */
  readonly changedElsewhere = computed(() => { const draft = this.draft(); return !!draft && !same(draft.base, this.saved()); });
  readonly activeTab = computed(() => TABS.find(t => t.id === (this.tab() ?? `${this.role()}-character`))!);
  readonly isPerkTab = computed(() => this.activeTab().kind === 'perk');
  private eligible(e: WidgetEntry, pool = this.pool()): boolean { return pool.includeUnavailable || e.available; }
  on(e: WidgetEntry): boolean { const pool = this.pool(); return this.eligible(e, pool) && !pool.excludedIds.includes(e.id); }
  readonly counts = computed(() => {
    const pool = this.pool(), out = {} as Record<Tab, {on: number; total: number}>;
    for (const tab of TABS) {
      const rows = this.catalog().entries.filter(e => e.role === tab.role && e.kind === tab.kind && this.eligible(e, pool));
      out[tab.id] = {on: rows.filter(e => !pool.excludedIds.includes(e.id)).length, total: rows.length};
    }
    return out;
  });
  readonly tooFewPerks = computed(() => (['killer', 'survivor'] as const).filter(role => this.counts()[`${role}-perk`].on < WIDGET_MIN_WHEEL_PERKS));
  readonly entries = computed(() => {
    const tab = this.activeTab(), query = this.query().toLowerCase().trim(), pool = this.pool();
    return this.catalog().entries.filter(e => e.role === tab.role && e.kind === tab.kind && this.eligible(e, pool)
      && (!query || e.english.toLowerCase().includes(query) || e.spanish.toLowerCase().includes(query)));
  });
  readonly shown = computed(() => this.entries().slice(0, this.limit()));
  /** Chance of each perk on a fresh wheel: (slots × weight) ÷ everyone's (slots × weight). */
  readonly totals = computed(() => {
    const pool = this.pool(), out: Record<WidgetRole, number> = {killer: 0, survivor: 0};
    for (const e of this.catalog().entries) if (e.kind === 'perk' && this.on(e)) out[e.role] += this.copies(e) * this.weight(e, pool);
    return out;
  });
  readonly tunedCount = computed(() => Object.keys(this.pool().perkTuning).length);

  constructor() {
    const query = typeof matchMedia === 'function' ? matchMedia('(min-width: 960px)') : null;
    if (query) {
      const sync = () => this.wide.set(query.matches); sync();
      query.addEventListener('change', sync); inject(DestroyRef).onDestroy(() => query.removeEventListener('change', sync));
    }
  }
  showTuners(e: WidgetEntry): boolean { return this.tuning() && this.on(e) && (this.wide() || this.expanded() === e.id); }
  toggleExpanded(e: WidgetEntry): void { this.expanded.update(id => id === e.id ? null : e.id); }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('widgets.' + key, params); }
  label(entry: WidgetEntry): string { return this.language.currentLanguage() === 'es' ? entry.spanish : entry.english; }
  imageFailed(entry: WidgetEntry): void { this.failedImages.update(ids => new Set([...ids, entry.id])); }
  copies(e: WidgetEntry, pool = this.pool()): number { return pool.perkTuning[e.id]?.copies ?? 1; }
  weight(e: WidgetEntry, pool = this.pool()): number { return pool.perkTuning[e.id]?.weight ?? 1; }
  chance(e: WidgetEntry): string {
    const total = this.totals()[e.role], share = this.on(e) && total ? this.copies(e) * this.weight(e) / total : 0;
    return share >= .1 ? `${Math.round(share * 100)}%` : `${(share * 100).toFixed(1)}%`;
  }

  private edit(change: (pool: WidgetPool) => WidgetPool): void {
    const draft = this.draft(), base = draft?.base ?? this.saved(), pool = change(structuredClone(draft?.pool ?? this.saved()));
    this.draft.set(same(pool, this.saved()) ? null : {pool, base});
  }
  chooseTab(id: Tab): void { this.tab.set(id); this.query.set(''); this.limit.set(40); }
  onQuery(event: Event): void { this.query.set((event.target as HTMLInputElement).value); this.limit.set(40); }
  more(): void { this.limit.update(n => n + 40); }
  setIncludeUnavailable(value: boolean): void { this.edit(pool => ({...pool, includeUnavailable: value})); }
  toggle(e: WidgetEntry): void { this.edit(pool => ({...pool, excludedIds: pool.excludedIds.includes(e.id) ? pool.excludedIds.filter(id => id !== e.id) : [...pool.excludedIds, e.id]})); }
  setAll(on: boolean): void {
    const ids = new Set(this.entries().map(e => e.id));
    this.edit(pool => ({...pool, excludedIds: on ? pool.excludedIds.filter(id => !ids.has(id)) : [...new Set([...pool.excludedIds, ...ids])]}));
  }
  tune(e: WidgetEntry, field: keyof WidgetPerkTuning, delta: number): void {
    const max = field === 'copies' ? WIDGET_MAX_PERK_COPIES : WIDGET_MAX_PERK_WEIGHT;
    this.edit(pool => {
      const current = {copies: this.copies(e, pool), weight: this.weight(e, pool)}, next = {...current, [field]: Math.min(max, Math.max(1, current[field] + delta))};
      const rest = Object.fromEntries(Object.entries(pool.perkTuning).filter(([id]) => id !== e.id));
      return {...pool, perkTuning: next.copies === 1 && next.weight === 1 ? rest : {...rest, [e.id]: next}};
    });
  }
  resetTuning(): void {
    const tab = this.activeTab();
    this.edit(pool => ({...pool, perkTuning: Object.fromEntries(Object.entries(pool.perkTuning).filter(([id]) => this.catalog().entries.find(e => e.id === id)?.role !== tab.role))}));
  }
  toggleTuning(): void { this.tuning.update(on => !on); }
  discard(): void { this.draft.set(null); }
  submit(): void { const draft = this.draft(); if (draft && !this.disabled()) this.save.emit(draft.pool); }
  /** Called by the page once the server accepted the save. */
  markSaved(): void { this.draft.set(null); }
}
