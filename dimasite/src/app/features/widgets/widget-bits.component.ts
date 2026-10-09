import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { LanguageService } from '../../services/language.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { BITS_ACTIONS, type BitsActionType, type BitsMatch, bitsAction, bitsCondition, bitsMatch, bitsMatches, bitsRange, bitsShowsRole, perkNames } from './widget-bits';
import { WIDGET_MAX_EVENT_RULES, WIDGET_MAX_PERK_COPIES, WIDGET_MIN_WHEEL_PERKS, WidgetCatalog, WidgetEntry, WidgetEventAction, WidgetEventRole, WidgetEventRule, WidgetEventSettings, WidgetRole, WidgetState } from './widgets-api.service';

interface Draft { id: string; enabled: boolean; match: BitsMatch; from: number; to: number; type: BitsActionType; role: WidgetEventRole; amount: number; pick: 'random' | 'chosen'; perkIds: string[] }
const MAX_CHOSEN = 20;
/** Quick starts open the editor prefilled; nothing is saved until the streamer confirms. */
const IDEAS: Omit<Draft, 'id'>[] = [
  {enabled: true, match: 'exact', from: 100, to: 100, type: 'remove-wins', role: 'current', amount: 1, pick: 'random', perkIds: []},
  {enabled: true, match: 'exact', from: 500, to: 500, type: 'remove-perks', role: 'current', amount: 1, pick: 'random', perkIds: []},
  {enabled: true, match: 'exact', from: 2500, to: 2500, type: 'add-win-target', role: 'current', amount: 1, pick: 'random', perkIds: []},
  {enabled: true, match: 'atLeast', from: 5000, to: 5000, type: 'reset-wins', role: 'current', amount: 1, pick: 'random', perkIds: []},
];

@Component({ selector: 'app-widget-bits', imports: [LfIconComponent, NgOptimizedImage], templateUrl: './widget-bits.component.html', styleUrls: ['./widgets-base.css', './widget-bits.component.css'], changeDetection: ChangeDetectionStrategy.OnPush })
export class WidgetBitsComponent {
  readonly catalog = input.required<WidgetCatalog>();
  readonly state = input.required<WidgetState>();
  readonly settings = input.required<WidgetEventSettings | null>();
  readonly disabled = input(false);
  readonly error = input('');
  readonly save = output<Omit<WidgetEventSettings, 'activeSince'>>();
  readonly language = inject(LanguageService);
  readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('ruleDialog');
  readonly actionGroups = (['wins', 'perks'] as const).map(group => ({group, items: BITS_ACTIONS.filter(a => a.group === group)}));
  readonly roles: WidgetEventRole[] = ['current', 'killer', 'survivor', 'both'];
  readonly matches: BitsMatch[] = ['exact', 'between', 'atLeast', 'atMost'];
  readonly maxRules = WIDGET_MAX_EVENT_RULES;
  readonly maxChosen = MAX_CHOSEN;
  readonly draft = signal<Draft | null>(null);
  readonly editing = signal(false);
  readonly submitted = signal(false);
  readonly awaitingSave = signal(false);
  readonly confirmDelete = signal<string | null>(null);
  readonly trial = signal(500);
  readonly perkQuery = signal('');
  readonly perkRole = signal<WidgetRole>('killer');
  readonly perkLimit = signal(30);
  readonly failedImages = signal<ReadonlySet<string>>(new Set());
  private deleteTimer: ReturnType<typeof setTimeout> | undefined;

  readonly rules = computed(() => this.settings()?.rules ?? []);
  readonly listening = computed(() => !!this.settings()?.enabled && !!this.settings()?.active);
  readonly onCount = computed(() => this.rules().filter(rule => rule.enabled).length);
  readonly entriesById = computed(() => new Map(this.catalog().entries.map(e => [e.id, e])));
  readonly ideas = computed(() => IDEAS.map(idea => ({idea, rule: this.toRule({...idea, id: 'idea'})})));
  /** The plain answer to "will Bits do anything right now?" */
  readonly status = computed(() => {
    const settings = this.settings();
    if (!this.listening() || !settings?.activeSince) return {tone: 'idle', title: this.t('bits.status.off.title'), detail: this.t('bits.status.off.detail')};
    if (!this.onCount()) return {tone: 'warn', title: this.t('bits.status.none.title'), detail: this.t('bits.status.none.detail')};
    return {tone: 'live', title: this.t('bits.status.on.title', {time: this.time(settings.activeSince)}), detail: this.t(this.onCount() === 1 ? 'bits.status.on.detailOne' : 'bits.status.on.detail', {n: this.onCount()})};
  });
  readonly trialMatches = computed(() => { const bits = this.trial(); return Number.isSafeInteger(bits) && bits > 0 ? this.rules().filter(rule => bitsMatches(rule, bits)) : []; });
  readonly draftRule = computed(() => { const draft = this.draft(); return draft ? this.toRule(draft) : null; });
  readonly amountRange = computed(() => {
    const draft = this.draft(); if (!draft) return {min: 1, max: 20};
    if (draft.type === 'add-perks' || draft.type === 'remove-perks') return draft.pick === 'chosen' ? {min: 1, max: WIDGET_MAX_PERK_COPIES} : {min: 1, max: 10};
    return {min: 1, max: 20};
  });
  readonly errors = computed(() => {
    const draft = this.draft(); if (!draft) return {} as Record<string, string>;
    const out: Record<string, string> = {}, whole = (n: number) => Number.isSafeInteger(n) && n >= 1;
    if (!whole(draft.from) || draft.match === 'between' && !whole(draft.to)) out['bits'] = this.t('bits.edit.invalidBits');
    else if (draft.match === 'between' && draft.to <= draft.from) out['bits'] = this.t('bits.edit.invalidRange');
    const range = this.amountRange();
    if (this.needsAmount() && (!Number.isSafeInteger(draft.amount) || draft.amount < range.min || draft.amount > range.max)) out['amount'] = this.t('bits.edit.invalidAmount', range);
    if (this.perkAction() && draft.pick === 'chosen' && !draft.perkIds.length) out['perks'] = this.t('bits.edit.noneChosen');
    return out;
  });
  readonly perkAction = computed(() => this.draft()?.type === 'add-perks' || this.draft()?.type === 'remove-perks');
  readonly needsAmount = computed(() => { const draft = this.draft(); return !!draft && draft.type !== 'reset-wins' && !(draft.type === 'remove-perks' && draft.pick === 'chosen'); });
  readonly showRole = computed(() => { const draft = this.draft(); return !!draft && !(this.perkAction() && draft.pick === 'chosen'); });
  readonly eligiblePerks = computed(() => {
    const config = this.state().config;
    return this.catalog().entries.filter(e => e.kind === 'perk' && (config.includeUnavailable || e.available));
  });
  readonly perkMatches = computed(() => {
    const query = this.perkQuery().toLowerCase().trim();
    return this.eligiblePerks().filter(e => e.role === this.perkRole() && (!query || e.english.toLowerCase().includes(query) || e.spanish.toLowerCase().includes(query)));
  });
  readonly shownPerks = computed(() => this.perkMatches().slice(0, this.perkLimit()));
  readonly chosenPerks = computed(() => (this.draft()?.perkIds ?? []).flatMap(id => { const entry = this.entriesById().get(id); return entry ? [entry] : []; }));
  /** How many perks a random add could bring back right now, per role. */
  readonly offCounts = computed(() => {
    const config = this.state().config, off = (role: WidgetRole) => this.eligiblePerks().filter(e => e.role === role && config.excludedIds.includes(e.id)).length;
    return {killer: off('killer'), survivor: off('survivor')};
  });

  constructor() {
    // A new settings object means the server accepted the save: close the editor.
    effect(() => { this.settings(); if (untracked(this.awaitingSave)) { this.awaitingSave.set(false); untracked(() => this.closeEditor()); } });
    effect(() => { if (this.error() && untracked(this.awaitingSave)) this.awaitingSave.set(false); });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.deleteTimer));
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('widgets.' + key, params); }
  label(entry: WidgetEntry): string { return this.language.currentLanguage() === 'es' ? entry.spanish : entry.english; }
  condition(rule: WidgetEventRule): string { return bitsCondition(rule, this.t.bind(this)); }
  describe(rule: WidgetEventRule): string { return bitsAction(rule.action, this.t.bind(this), ids => perkNames(ids, this.entriesById(), e => this.label(e), this.t.bind(this))); }
  roleChip(rule: WidgetEventRule): string | null { return bitsShowsRole(rule.action) ? this.t('bits.role.' + rule.action.role) : null; }
  imageFailed(entry: WidgetEntry): void { this.failedImages.update(ids => new Set([...ids, entry.id])); }
  private time(at: number): string {
    const lang = this.language.currentLanguage(), date = new Date(at);
    return Date.now() - at < 20 * 3600_000 ? date.toLocaleTimeString(lang, {hour: 'numeric', minute: '2-digit'}) : date.toLocaleString(lang, {weekday: 'short', hour: 'numeric', minute: '2-digit'});
  }

  private commit(changes: Partial<WidgetEventSettings>): void {
    const settings = this.settings() ?? {enabled: false, active: false, allowTestEvents: false, rules: []};
    this.save.emit({enabled: settings.enabled, active: settings.active, allowTestEvents: settings.allowTestEvents, rules: settings.rules, ...changes});
  }
  /** One switch: "enabled" and "active" move together so there is no hidden half-on state. */
  toggleListening(): void { const on = !this.listening(); this.commit({enabled: on, active: on}); }
  toggleTestEvents(): void { this.commit({allowTestEvents: !this.settings()?.allowTestEvents}); }
  toggleRule(rule: WidgetEventRule): void { this.commit({rules: this.rules().map(r => r.id === rule.id ? {...r, enabled: !r.enabled} : r)}); }
  remove(rule: WidgetEventRule): void {
    clearTimeout(this.deleteTimer);
    if (this.confirmDelete() !== rule.id) { this.confirmDelete.set(rule.id); this.deleteTimer = setTimeout(() => this.confirmDelete.set(null), 4000); return; }
    this.confirmDelete.set(null); this.commit({rules: this.rules().filter(r => r.id !== rule.id)});
  }
  onTrial(event: Event): void { this.trial.set((event.target as HTMLInputElement).valueAsNumber); }

  // Editor
  openNew(idea?: Omit<Draft, 'id'>): void {
    this.open({...(idea ?? IDEAS[0]), id: crypto.randomUUID()}, false);
  }
  openEdit(rule: WidgetEventRule): void {
    const action = rule.action, match = bitsMatch(rule), perkIds = 'perkIds' in action ? action.perkIds : [];
    this.open({id: rule.id, enabled: rule.enabled, match, from: match === 'atMost' ? rule.maxBits! : rule.minBits, to: rule.maxBits ?? rule.minBits, type: action.type, role: action.role, amount: 'amount' in action ? action.amount : 1, pick: perkIds.length ? 'chosen' : 'random', perkIds: [...perkIds]}, true);
  }
  private open(draft: Draft, editing: boolean): void {
    this.draft.set(draft); this.editing.set(editing); this.submitted.set(false); this.perkQuery.set(''); this.perkLimit.set(30);
    const firstPerk = draft.perkIds.length ? this.entriesById().get(draft.perkIds[0]) : null;
    this.perkRole.set(firstPerk?.role ?? (this.state().packId.includes('-survivor-') ? 'survivor' : 'killer'));
    this.dialog()?.nativeElement.showModal();
  }
  closeEditor(): void { this.dialog()?.nativeElement.close(); this.draft.set(null); this.awaitingSave.set(false); }
  patch(changes: Partial<Draft>): void { this.draft.update(draft => draft ? {...draft, ...changes} : draft); }
  num(event: Event): number { return (event.target as HTMLInputElement).valueAsNumber; }
  chooseType(type: BitsActionType): void {
    const draft = this.draft(); if (!draft || draft.type === type) return;
    const target = this.state().config.targets[this.state().packId.includes('-survivor-') ? 'survivor' : 'killer'];
    this.patch({type, amount: type === 'set-win-target' ? Math.min(20, target + 1) : 1});
  }
  choosePick(pick: Draft['pick']): void { this.patch({pick, amount: 1}); }
  step(delta: number): void { const draft = this.draft(), range = this.amountRange(); if (draft) this.patch({amount: Math.min(range.max, Math.max(range.min, (Number.isSafeInteger(draft.amount) ? draft.amount : range.min) + delta))}); }
  togglePerk(entry: WidgetEntry): void {
    const ids = this.draft()?.perkIds ?? [];
    if (ids.includes(entry.id)) this.patch({perkIds: ids.filter(id => id !== entry.id)});
    else if (ids.length < MAX_CHOSEN) this.patch({perkIds: [...ids, entry.id]});
  }
  onPerkQuery(event: Event): void { this.perkQuery.set((event.target as HTMLInputElement).value); this.perkLimit.set(30); }
  morePerks(): void { this.perkLimit.update(n => n + 30); }
  choosePerkRole(role: WidgetRole): void { this.perkRole.set(role); this.perkLimit.set(30); }
  private toRule(draft: Draft): WidgetEventRule {
    const chosen = draft.pick === 'chosen', amount = Number.isSafeInteger(draft.amount) ? draft.amount : 1;
    let action: WidgetEventAction;
    if (draft.type === 'reset-wins') action = {type: draft.type, role: draft.role};
    else if (draft.type === 'add-perks' || draft.type === 'remove-perks') action = {type: draft.type, role: draft.role, amount: draft.type === 'remove-perks' && chosen ? 1 : amount, perkIds: chosen ? draft.perkIds : []};
    else action = {type: draft.type, role: draft.role, amount};
    return {id: draft.id, enabled: draft.enabled, event: 'channel.bits.received', ...bitsRange(draft.match, draft.from, draft.to), action};
  }
  submit(): void {
    this.submitted.set(true);
    const rule = this.draftRule(); if (!rule || Object.keys(this.errors()).length || this.disabled()) return;
    const exists = this.rules().some(r => r.id === rule.id);
    this.awaitingSave.set(true);
    this.commit({rules: exists ? this.rules().map(r => r.id === rule.id ? rule : r) : [...this.rules(), rule]});
  }
  readonly minWheel = WIDGET_MIN_WHEEL_PERKS;
}
