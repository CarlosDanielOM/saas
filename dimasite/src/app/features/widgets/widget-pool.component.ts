import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { LanguageService } from '../../services/language.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { WIDGET_MAX_PERK_COPIES, WIDGET_MAX_PERK_WEIGHT, WIDGET_MAX_SUB_WHEELS, WIDGET_MIN_SUB_WHEEL_PERKS, WIDGET_MIN_WHEEL_PERKS, WidgetCatalog, WidgetConfig, WidgetEntry, WidgetPerkTuning, WidgetRole, WidgetSubWheel } from './widgets-api.service';

export interface WidgetPool { includeUnavailable: boolean; excludedIds: string[]; perkTuning: Record<string, WidgetPerkTuning>; subWheels: WidgetSubWheel[] }
type Tab = 'killer-character' | 'survivor-character' | 'killer-perk' | 'survivor-perk';
const TABS: { id: Tab; role: WidgetRole; kind: 'character' | 'perk'; key: string }[] = [
  {id: 'killer-character', role: 'killer', kind: 'character', key: 'killers'}, {id: 'survivor-character', role: 'survivor', kind: 'character', key: 'survivors'},
  {id: 'killer-perk', role: 'killer', kind: 'perk', key: 'killerPerks'}, {id: 'survivor-perk', role: 'survivor', kind: 'perk', key: 'survivorPerks'},
];
const poolOf = (config: WidgetConfig): WidgetPool => ({includeUnavailable: config.includeUnavailable, excludedIds: [...config.excludedIds], perkTuning: {...config.perkTuning}, subWheels: structuredClone(config.subWheels ?? [])});
const key = (p: WidgetPool) => JSON.stringify([p.includeUnavailable, [...p.excludedIds].sort(), Object.entries(p.perkTuning).sort(), p.subWheels]);
const same = (a: WidgetPool, b: WidgetPool) => key(a) === key(b);
type WheelDraft = { id: string; isNew: boolean; name: string; perkIds: string[]; copies: number; weight: number; query: string; tried: boolean };

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
  /** The long lists start closed; the tab chips double as a summary and a way in. */
  readonly open = signal(false);
  readonly query = signal('');
  readonly limit = signal(40);
  readonly tuning = signal(false);
  readonly failedImages = signal<ReadonlySet<string>>(new Set());
  /** Desktop shows every perk's steppers inline; phones open one perk at a time to keep the list short. */
  readonly wide = signal(false);
  readonly expanded = signal<string | null>(null);
  readonly maxWheels = WIDGET_MAX_SUB_WHEELS;
  readonly minWheelPerks = WIDGET_MIN_SUB_WHEEL_PERKS;
  readonly wheelDialog = viewChild<ElementRef<HTMLDialogElement>>('wheelDialog');
  /** The mini roulette being edited in the dialog; applied to the pool draft on Done. */
  readonly wheelDraft = signal<WheelDraft | null>(null);

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
  readonly roleWheels = computed(() => this.pool().subWheels.filter(w => w.role === this.activeTab().role));
  /** Which mini roulette holds each perk. */
  readonly wheelOf = computed(() => new Map(this.pool().subWheels.flatMap(w => w.perkIds.map(id => [id, w] as const))));
  readonly tooFewPerks = computed(() => (['killer', 'survivor'] as const).filter(role => this.counts()[`${role}-perk`].on < WIDGET_MIN_WHEEL_PERKS));
  readonly entries = computed(() => {
    const tab = this.activeTab(), query = this.query().toLowerCase().trim(), pool = this.pool();
    return this.catalog().entries.filter(e => e.role === tab.role && e.kind === tab.kind && this.eligible(e, pool)
      && (!query || e.english.toLowerCase().includes(query) || e.spanish.toLowerCase().includes(query)));
  });
  readonly shown = computed(() => this.entries().slice(0, this.limit()));
  /** Chance of each slice on a fresh main wheel: (slots × weight) ÷ every slice's (slots × weight). A mini roulette
   *  counts once, and only while it still has a perk on; perks inside it share its chance by their own slots × weight. */
  readonly totals = computed(() => {
    const pool = this.pool(), wheels = this.wheelOf(), out: Record<WidgetRole, number> = {killer: 0, survivor: 0}, inner = new Map<string, number>();
    for (const e of this.catalog().entries) if (e.kind === 'perk' && this.on(e)) {
      const wheel = wheels.get(e.id), share = this.copies(e) * this.weight(e, pool);
      if (wheel) inner.set(wheel.id, (inner.get(wheel.id) ?? 0) + share); else out[e.role] += share;
    }
    for (const w of pool.subWheels) if (inner.get(w.id)) out[w.role] += w.copies * w.weight;
    return {main: out, inner};
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
  private percent(share: number): string { return share >= .1 ? `${Math.round(share * 100)}%` : `${(share * 100).toFixed(1)}%`; }
  private wheelShare(w: WidgetSubWheel): number { const total = this.totals().main[w.role]; return this.totals().inner.get(w.id) && total ? w.copies * w.weight / total : 0; }
  chance(e: WidgetEntry): string {
    if (!this.on(e)) return this.percent(0);
    const wheel = this.wheelOf().get(e.id), own = this.copies(e) * this.weight(e);
    if (wheel) return this.percent(this.wheelShare(wheel) * own / (this.totals().inner.get(wheel.id) || 1));
    const total = this.totals().main[e.role];
    return this.percent(total ? own / total : 0);
  }
  wheelChance(w: WidgetSubWheel): string { return this.percent(this.wheelShare(w)); }
  wheelOnCount(w: WidgetSubWheel): number { return w.perkIds.filter(id => { const e = this.catalog().entries.find(x => x.id === id); return !!e && this.on(e); }).length; }

  private edit(change: (pool: WidgetPool) => WidgetPool): void {
    const draft = this.draft(), base = draft?.base ?? this.saved(), pool = change(structuredClone(draft?.pool ?? this.saved()));
    this.draft.set(same(pool, this.saved()) ? null : {pool, base});
  }
  chooseTab(id: Tab): void { this.tab.set(id); this.query.set(''); this.limit.set(40); this.open.set(true); }
  toggleOpen(): void { this.open.update(open => !open); }
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

  // Mini roulettes: edited in a dialog, applied to the pool draft, saved with the rest of the roulette.
  readonly wheelPerks = computed(() => {
    const draft = this.wheelDraft(), role = this.activeTab().role, query = draft?.query.toLowerCase().trim() ?? '', pool = this.pool();
    const perks = this.catalog().entries.filter(e => e.role === role && e.kind === 'perk' && this.eligible(e, pool));
    // Chosen perks first so the streamer sees what's inside without scrolling.
    return perks.filter(e => !query || e.english.toLowerCase().includes(query) || e.spanish.toLowerCase().includes(query))
      .sort((a, b) => Number(draft?.perkIds.includes(b.id)) - Number(draft?.perkIds.includes(a.id)));
  });
  otherWheel(e: WidgetEntry): WidgetSubWheel | null { const w = this.wheelOf().get(e.id); return w && w.id !== this.wheelDraft()?.id ? w : null; }
  addWheel(): void {
    const n = this.roleWheels().length + 1, id = `${this.activeTab().role}-${Date.now().toString(36)}`;
    this.openWheel({id, isNew: true, name: this.t('subWheel.defaultName', {n}), perkIds: [], copies: 1, weight: 1, query: '', tried: false});
  }
  editWheel(w: WidgetSubWheel): void { this.openWheel({...structuredClone(w), isNew: false, query: '', tried: false}); }
  private openWheel(draft: WheelDraft): void { this.wheelDraft.set(draft); this.wheelDialog()?.nativeElement.showModal(); }
  closeWheel(): void { this.wheelDialog()?.nativeElement.close(); this.wheelDraft.set(null); }
  patchWheel(change: Partial<WheelDraft>): void { this.wheelDraft.update(d => d && {...d, ...change}); }
  onWheelName(event: Event): void { this.patchWheel({name: (event.target as HTMLInputElement).value}); }
  onWheelQuery(event: Event): void { this.patchWheel({query: (event.target as HTMLInputElement).value}); }
  toggleWheelPerk(e: WidgetEntry): void { this.wheelDraft.update(d => d && {...d, perkIds: d.perkIds.includes(e.id) ? d.perkIds.filter(id => id !== e.id) : [...d.perkIds, e.id]}); }
  stepWheel(field: 'copies' | 'weight', delta: number): void {
    const max = field === 'copies' ? WIDGET_MAX_PERK_COPIES : WIDGET_MAX_PERK_WEIGHT;
    this.wheelDraft.update(d => d && {...d, [field]: Math.min(max, Math.max(1, d[field] + delta))});
  }
  readonly wheelErrors = computed(() => {
    const d = this.wheelDraft();
    return {name: !d?.name.trim() || d.name.trim().length > 40, perks: (d?.perkIds.length ?? 0) < WIDGET_MIN_SUB_WHEEL_PERKS};
  });
  applyWheel(): void {
    const d = this.wheelDraft(); if (!d) return;
    if (this.wheelErrors().name || this.wheelErrors().perks) { this.patchWheel({tried: true}); return; }
    const wheel: WidgetSubWheel = {id: d.id, role: this.activeTab().role, name: d.name.trim(), perkIds: d.perkIds, copies: d.copies, weight: d.weight};
    // A perk lives in one mini roulette: picking it here moves it out of any other.
    this.edit(pool => {
      const others = pool.subWheels.filter(w => w.id !== wheel.id).map(w => ({...w, perkIds: w.perkIds.filter(id => !wheel.perkIds.includes(id))}));
      const kept = others.filter(w => w.perkIds.length >= WIDGET_MIN_SUB_WHEEL_PERKS);
      const index = pool.subWheels.findIndex(w => w.id === wheel.id);
      const next = [...kept]; next.splice(index < 0 ? next.length : Math.min(index, next.length), 0, wheel);
      return {...pool, subWheels: next};
    });
    this.closeWheel();
  }
  /** Its perks go back onto the main wheel. Only the draft changes until the roulette is saved. */
  removeWheel(w: WidgetSubWheel): void { this.edit(pool => ({...pool, subWheels: pool.subWheels.filter(x => x.id !== w.id)})); }
  emptiedBy(): WidgetSubWheel[] {
    const d = this.wheelDraft(); if (!d) return [];
    return this.pool().subWheels.filter(w => w.id !== d.id && w.perkIds.some(id => d.perkIds.includes(id)) && w.perkIds.filter(id => !d.perkIds.includes(id)).length < WIDGET_MIN_SUB_WHEEL_PERKS);
  }
  discard(): void { this.draft.set(null); }
  submit(): void { const draft = this.draft(); if (draft && !this.disabled()) this.save.emit(draft.pool); }
  /** Called by the page once the server accepted the save. */
  markSaved(): void { this.draft.set(null); }
}
