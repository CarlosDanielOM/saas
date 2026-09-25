import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LanguageService } from '../../../services/language.service';
import {
  DrawConfigurationError,
  drawTotals,
  expandSlots,
  parseBulkEntries,
  randomTicket,
  selectSlot,
} from './roulette-draw';

type Concept = 'orbit' | 'ticket' | 'spotlight' | 'grid';
interface Entry {
  id: number;
  name: string;
  weight: number;
  multiplier: number;
}
interface PrizeResult {
  id: number;
  key: string;
  index: number;
  copy: number;
  name: string;
  weight: number;
  multiplier: number;
}
const PALETTES: Record<Concept, string[]> = {
  grid: ['#cbbaff', '#f4c968', '#ec9baf', '#a5d5c2', '#b0c9ee', '#e9b896'],
  orbit: ['#cbbaff', '#e6ddff', '#ae93f5', '#d6caf1', '#f0eaff', '#bca7ec'],
  ticket: ['#f4ad85', '#ffe0aa', '#ccb5ef', '#a6d9cd', '#f0bdd1', '#dbe29e'],
  spotlight: ['#c0a5ff', '#f4c968', '#ec9baf', '#a5d5c2', '#b0c9ee', '#e9b896'],
};

@Component({
  selector: 'app-roulette-astra',
  imports: [RouterLink],
  templateUrl: './roulette-astra.component.html',
  styleUrls: [
    './roulette-astra.component.css',
    './roulette-card-grid.css',
    './roulette-entries.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RouletteAstraComponent {
  readonly language = inject(LanguageService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private nextId = 7;
  readonly concepts: Concept[] = ['orbit', 'ticket', 'spotlight', 'grid'];
  readonly concept = signal<Concept>('orbit');
  readonly entries = signal<Entry[]>(
    Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: '', weight: 1, multiplier: 1 })),
  );
  readonly draft = signal('');
  readonly bulkDraft = signal('');
  readonly replaceOnImport = signal(false);
  readonly importNotice = signal('');
  readonly search = signal('');
  readonly editorPage = signal(0);
  readonly boardPage = signal(0);
  readonly boardPageSize = 12;
  readonly editorPageSize = 10;
  readonly pointer = signal(0);
  readonly duration = signal(4);
  readonly angle = signal(0);
  readonly spinning = signal(false);
  readonly reducedMotion = signal(false);
  readonly result = signal<PrizeResult | null>(null);
  readonly history = signal<string[]>([]);
  readonly rounds = signal(0);
  readonly highlighted = signal<string | null>(null);
  readonly progress = signal(0);
  readonly remaining = computed(() => Math.ceil(this.duration() * (1 - this.progress())));
  readonly error = signal('');
  private readonly percentageFormat = computed(
    () => new Intl.NumberFormat(this.language.currentLanguage(), { maximumFractionDigits: 2 }),
  );
  readonly totals = computed(() => drawTotals(this.entries()));
  readonly total = computed(() => this.totals().weight);
  readonly slotCount = computed(() => this.totals().slots);
  readonly itemRows = computed(() =>
    this.entries().map((entry, index) => ({
      ...entry,
      index,
      name: this.entryName(entry),
      color: PALETTES[this.concept()][index % 6],
      chance: this.chance(entry.weight * entry.multiplier),
    })),
  );
  readonly slices = computed(() => {
    let start = 0;
    const rows = new Map(this.itemRows().map((row) => [row.id, row]));
    return expandSlots(this.entries()).map((slot) => {
      const row = rows.get(slot.id)!;
      const sweep = (slot.weight / this.total()) * 360;
      const slice = {
        ...row,
        ...slot,
        start,
        sweep,
        middle: start + sweep / 2,
        chance: this.chance(slot.weight),
      };
      start += sweep;
      return slice;
    });
  });
  readonly labeledSlices = computed(() => this.slices().filter((slice) => slice.sweep >= 24));
  readonly separatorSlices = computed(() => (this.slotCount() <= 72 ? this.slices() : []));
  readonly denseWheel = computed(() => this.labeledSlices().length < this.slotCount());
  readonly visibleSlices = computed(() =>
    this.slices().slice(
      this.boardPage() * this.boardPageSize,
      (this.boardPage() + 1) * this.boardPageSize,
    ),
  );
  readonly boardPages = computed(() =>
    Math.max(1, Math.ceil(this.slotCount() / this.boardPageSize)),
  );
  readonly filteredEntries = computed(() => {
    const query = this.search().trim().toLocaleLowerCase();
    return this.itemRows().filter((entry) => entry.name.toLocaleLowerCase().includes(query));
  });
  readonly editorPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredEntries().length / this.editorPageSize)),
  );
  readonly visibleEntries = computed(() =>
    this.filteredEntries().slice(
      this.editorPage() * this.editorPageSize,
      (this.editorPage() + 1) * this.editorPageSize,
    ),
  );
  readonly gradient = computed(() =>
    this.slices().length
      ? `conic-gradient(${this.slices()
          .map((s) => `${s.color} ${s.start}deg ${s.start + s.sweep}deg`)
          .join(',')})`
      : 'var(--line)',
  );
  readonly ready = computed(() => this.slotCount() >= 2 && !this.spinning());

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const requested = params.get('design');
      if (this.concepts.includes(requested as Concept)) this.concept.set(requested as Concept);
    });
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.timer);
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    });
  }
  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(`rouletteAstra.${key}`, params);
  }
  common(key: string): string {
    return this.language.translate(`rouletteMock.${key}`);
  }
  entryName(entry: Entry): string {
    return entry.name || this.t(`prize${(entry.id - 1) % 6}`);
  }
  chance(weight: number): string {
    const percent = this.total() ? (weight / this.total()) * 100 : 0;
    if (percent > 0 && percent < 0.01) return '<' + this.percentageFormat().format(0.01);
    return this.percentageFormat().format(percent);
  }
  setDraft(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }
  setBulkDraft(event: Event): void {
    this.bulkDraft.set((event.target as HTMLTextAreaElement).value);
  }
  setReplace(event: Event): void {
    this.replaceOnImport.set((event.target as HTMLInputElement).checked);
  }
  setSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    this.editorPage.set(0);
  }
  changePage(which: 'board' | 'editor', delta: number): void {
    if (this.spinning()) return;
    const page = which === 'board' ? this.boardPage : this.editorPage;
    const pages = which === 'board' ? this.boardPages() : this.editorPages();
    page.set(Math.max(0, Math.min(pages - 1, page() + delta)));
  }
  private report(error: unknown): void {
    this.error.set(
      this.t('invalid.' + (error instanceof DrawConfigurationError ? error.code : 'number')),
    );
  }
  private updateEntries(entries: Entry[]): boolean {
    if (this.spinning()) return false;
    try {
      drawTotals(entries);
    } catch (error) {
      this.report(error);
      return false;
    }
    this.entries.set(entries);
    this.boardPage.set(Math.min(this.boardPage(), this.boardPages() - 1));
    this.editorPage.set(Math.min(this.editorPage(), this.editorPages() - 1));
    this.result.set(null);
    this.highlighted.set(null);
    this.progress.set(0);
    this.error.set('');
    this.importNotice.set('');
    return true;
  }
  setNumber(id: number, field: 'weight' | 'multiplier', event: Event): void {
    if (this.spinning()) return;
    const input = event.target as HTMLInputElement;
    const previous = this.entries().find((entry) => entry.id === id)!;
    const value = Number(input.value);
    if (
      !this.updateEntries(
        this.entries().map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry)),
      )
    ) {
      input.value = String(previous[field]);
    }
  }
  add(): void {
    if (this.spinning()) return;
    const name = this.draft().trim();
    if (!name) {
      this.error.set(this.common('nameRequired'));
      return;
    }
    if (
      this.updateEntries([
        ...this.entries(),
        { id: this.nextId, name: name.slice(0, 120), weight: 1, multiplier: 1 },
      ])
    ) {
      this.nextId++;
      this.draft.set('');
    }
  }
  importEntries(): void {
    if (this.spinning()) return;
    try {
      const parsed = parseBulkEntries(this.bulkDraft());
      if (!parsed.length) {
        this.error.set(this.common('nameRequired'));
        return;
      }
      const added = parsed.map((entry, index) => ({ ...entry, id: this.nextId + index }));
      const next = this.replaceOnImport() ? added : [...this.entries(), ...added];
      if (this.updateEntries(next)) {
        this.nextId += added.length;
        this.search.set('');
        this.editorPage.set(0);
        this.boardPage.set(0);
        this.importNotice.set(this.t('imported', { count: added.length }));
        this.bulkDraft.set('');
      }
    } catch (error) {
      this.report(error);
    }
  }
  remove(id: number): void {
    this.updateEntries(this.entries().filter((entry) => entry.id !== id));
  }
  setDuration(event: Event): void {
    if (!this.spinning()) this.duration.set(Number((event.target as HTMLInputElement).value));
  }
  private reveal(selected: PrizeResult): void {
    this.result.set(selected);
    this.highlighted.set(selected.key);
    this.progress.set(1);
    this.rounds.update((round) => round + 1);
    this.history.update((history) => [selected.name, ...history].slice(0, 4));
    this.spinning.set(false);
    this.boardPage.set(Math.floor(selected.index / this.boardPageSize));
    if (this.concept() === 'grid') {
      this.frame = requestAnimationFrame(() => {
        this.document
          .getElementById('prize-' + selected.key)
          ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        this.frame = undefined;
      });
    }
  }
  private animateCards(selected: PrizeResult, keys: string[]): void {
    const start = performance.now();
    const length = this.duration() * 1000;
    let nextHop = 0;
    let lastProgress = -1;
    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed >= length) {
        this.reveal(selected);
        return;
      }
      const fraction = elapsed / length;
      if (elapsed - lastProgress >= 100) {
        this.progress.set(fraction);
        lastProgress = elapsed;
      }
      if (elapsed >= nextHop && !this.reducedMotion()) {
        const candidates = keys.filter((key) => key !== this.highlighted());
        this.highlighted.set(
          candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : keys[0],
        );
        nextHop = elapsed + 140 + 520 * Math.pow(fraction, 3);
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }
  spin(): void {
    if (!this.ready()) return;
    const slots = this.slices();
    const chosen = selectSlot(slots, randomTicket(this.total()));
    const selected = slots[chosen.index];
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.reducedMotion.set(reduce);
    this.spinning.set(true);
    this.result.set(null);
    this.error.set('');
    this.highlighted.set(null);
    this.progress.set(0);
    if (this.concept() === 'grid') {
      this.animateCards(
        selected,
        this.visibleSlices().map((slot) => slot.key),
      );
      return;
    }
    const remainder = ((this.angle() % 360) + 360) % 360;
    const target = (((this.pointer() - selected.middle - remainder) % 360) + 360) % 360;
    this.frame = requestAnimationFrame(() => {
      this.angle.update((angle) => angle + (reduce ? 0 : 1800) + target);
      this.timer = setTimeout(
        () => this.reveal(selected),
        reduce ? 0 : this.duration() * 1000 + 100,
      );
    });
  }
}
