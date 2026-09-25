import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LanguageService } from '../../../services/language.service';

type Concept = 'orbit' | 'ticket' | 'spotlight';
interface Entry {
  id: number;
  name: string;
  weight: number;
}
const PALETTES: Record<Concept, string[]> = {
  orbit: ['#cbbaff', '#e6ddff', '#ae93f5', '#d6caf1', '#f0eaff', '#bca7ec'],
  ticket: ['#f4ad85', '#ffe0aa', '#ccb5ef', '#a6d9cd', '#f0bdd1', '#dbe29e'],
  spotlight: ['#c0a5ff', '#f4c968', '#ec9baf', '#a5d5c2', '#b0c9ee', '#e9b896'],
};

@Component({
  selector: 'app-roulette-astra',
  imports: [RouterLink],
  templateUrl: './roulette-astra.component.html',
  styleUrl: './roulette-astra.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RouletteAstraComponent {
  readonly language = inject(LanguageService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private nextId = 7;
  readonly concepts: Concept[] = ['orbit', 'ticket', 'spotlight'];
  readonly concept = signal<Concept>('orbit');
  readonly entries = signal<Entry[]>(
    Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: '', weight: 1 })),
  );
  readonly draft = signal('');
  readonly pointer = signal(0);
  readonly duration = signal(4);
  readonly angle = signal(0);
  readonly spinning = signal(false);
  readonly reducedMotion = signal(false);
  readonly result = signal<{ name: string; id: number } | null>(null);
  readonly history = signal<string[]>([]);
  readonly rounds = signal(0);
  readonly error = signal('');
  readonly total = computed(() => this.entries().reduce((sum, entry) => sum + entry.weight, 0));
  readonly slices = computed(() => {
    let start = 0;
    return this.entries().map((entry, i) => {
      const sweep = (entry.weight / this.total()) * 360;
      const slice = {
        ...entry,
        name: this.entryName(entry),
        start,
        sweep,
        middle: start + sweep / 2,
        color: PALETTES[this.concept()][i % 6],
        chance: Math.round(sweep / 3.6),
      };
      start += sweep;
      return slice;
    });
  });
  readonly gradient = computed(() =>
    this.slices().length
      ? `conic-gradient(${this.slices()
          .map((s) => `${s.color} ${s.start}deg ${s.start + s.sweep}deg`)
          .join(',')})`
      : 'var(--line)',
  );
  readonly ready = computed(() => this.entries().length >= 2 && !this.spinning());

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
  t(key: string): string {
    return this.language.translate(`rouletteAstra.${key}`);
  }
  common(key: string): string {
    return this.language.translate(`rouletteMock.${key}`);
  }
  entryName(entry: Entry): string {
    return entry.name || this.t(`prize${(entry.id - 1) % 6}`);
  }
  setDraft(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }
  setWeight(id: number, event: Event): void {
    if (this.spinning()) return;
    const input = event.target as HTMLInputElement;
    const weight = Math.min(10, Math.max(1, Math.round(Number(input.value) || 1)));
    input.value = String(weight);
    this.entries.update((entries) =>
      entries.map((entry) => (entry.id === id ? { ...entry, weight } : entry)),
    );
    this.result.set(null);
  }
  add(): void {
    if (this.spinning()) return;
    if (!this.draft().trim()) {
      this.error.set(this.common('nameRequired'));
      return;
    }
    if (this.entries().length >= 12) {
      this.error.set(this.common('itemLimit'));
      return;
    }
    this.entries.update((entries) => [
      ...entries,
      { id: this.nextId++, name: this.draft().trim().slice(0, 40), weight: 1 },
    ]);
    this.draft.set('');
    this.error.set('');
    this.result.set(null);
  }
  remove(id: number): void {
    if (this.spinning()) return;
    this.entries.update((entries) => entries.filter((entry) => entry.id !== id));
    this.result.set(null);
  }
  setDuration(event: Event): void {
    if (!this.spinning()) this.duration.set(Number((event.target as HTMLInputElement).value));
  }
  spin(): void {
    if (!this.ready()) return;
    const value = Math.random() * this.total();
    let sum = 0;
    const selected = this.slices().find((entry) => {
      sum += entry.weight;
      return value < sum;
    })!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.reducedMotion.set(reduce);
    this.spinning.set(true);
    this.result.set(null);
    this.error.set('');
    const remainder = ((this.angle() % 360) + 360) % 360;
    const target = (((this.pointer() - selected.middle - remainder) % 360) + 360) % 360;
    this.frame = requestAnimationFrame(() => {
      this.angle.update((angle) => angle + (reduce ? 0 : 1800) + target);
      this.timer = setTimeout(
        () => {
          this.result.set({ name: selected.name, id: selected.id });
          this.rounds.update((round) => round + 1);
          this.history.update((history) => [selected.name, ...history].slice(0, 4));
          this.spinning.set(false);
        },
        reduce ? 0 : this.duration() * 1000 + 100,
      );
    });
  }
}
