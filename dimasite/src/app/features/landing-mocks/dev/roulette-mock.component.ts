import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LanguageService } from '../../../services/language.service';

type Design = 'studio' | 'stage' | 'compact';
type Pointer = 'top' | 'right' | 'bottom' | 'left';
interface Entry { id: number; name: string; weight: number; color: string }
interface Slice extends Entry { start: number; size: number; center: number; chance: number }

/** Soft Live First pastels for dashboard-friendly Studio. */
const STUDIO_COLORS = ['#855cf0', '#f47d68', '#f3b849', '#43b9a9', '#4b8fe9', '#e577ac', '#79b95e', '#a483dd'];
/** Neon stream/OBS Stage palette — vivid under dark lighting. */
const STAGE_COLORS = ['#ff5c8a', '#ffb020', '#5ce1e6', '#b388ff', '#7CFF6B', '#ff7a59', '#4da3ff', '#f0e56b'];
/** Compact ops greens and ink accents for dense editing. */
const COMPACT_COLORS = ['#277a59', '#c45c26', '#2f6fed', '#8a5a2b', '#0f766e', '#b45309', '#1d4ed8', '#365314'];
const PALETTES: Record<Design, string[]> = {
  studio: STUDIO_COLORS,
  stage: STAGE_COLORS,
  compact: COMPACT_COLORS
};
const POINTER_ANGLE: Record<Pointer, number> = { top: 0, right: 90, bottom: 180, left: 270 };

@Component({
  selector: 'app-roulette-mock',
  imports: [RouterLink],
  templateUrl: './roulette-mock.component.html',
  styleUrl: './roulette-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RouletteMockComponent {
  private readonly language = inject(LanguageService);
  private nextId = 5;
  private spinTimer: ReturnType<typeof setTimeout> | null = null;

  readonly designs: Design[] = ['studio', 'stage', 'compact'];
  readonly pointers: Pointer[] = ['left', 'top', 'right', 'bottom'];
  readonly design = signal<Design>('studio');
  readonly pointer = signal<Pointer>('top');
  readonly entries = signal<Entry[]>([
    { id: 1, name: 'Pizza night', weight: 3, color: STUDIO_COLORS[0] },
    { id: 2, name: 'Game break', weight: 2, color: STUDIO_COLORS[1] },
    { id: 3, name: 'Chat picks', weight: 2, color: STUDIO_COLORS[2] },
    { id: 4, name: 'Mystery prize', weight: 1, color: STUDIO_COLORS[3] }
  ]);
  readonly draftName = signal('');
  readonly sessionName = signal('Friday stream picks');
  readonly duration = signal(5);
  readonly rotation = signal(0);
  readonly spinning = signal(false);
  readonly winner = signal<Entry | null>(null);
  readonly history = signal<string[]>([]);
  readonly error = signal('');
  readonly transition = signal('none');

  readonly totalWeight = computed(() => this.entries().reduce((sum, entry) => sum + entry.weight, 0));
  readonly slices = computed<Slice[]>(() => {
    const total = this.totalWeight();
    let cursor = 0;
    return this.entries().map((entry) => {
      const size = (entry.weight / total) * 360;
      const slice = { ...entry, start: cursor, size, center: cursor + size / 2, chance: entry.weight / total * 100 };
      cursor += size;
      return slice;
    });
  });
  readonly gradient = computed(() => {
    const slices = this.slices();
    return slices.length
      ? `conic-gradient(${slices.map((slice) => `${slice.color} ${slice.start}deg ${slice.start + slice.size}deg`).join(', ')})`
      : 'conic-gradient(#ddd 0deg 360deg)';
  });
  readonly canSpin = computed(() => this.entries().length >= 2 && !this.spinning());

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(`rouletteMock.${key}`, params);
  }

  setDesign(value: Design): void {
    this.design.set(value);
    const palette = PALETTES[value];
    this.entries.update((entries) =>
      entries.map((entry, index) => ({ ...entry, color: palette[index % palette.length] }))
    );
  }
  setPointer(value: Pointer): void { if (!this.spinning()) this.pointer.set(value); }
  setDraft(event: Event): void { this.draftName.set((event.target as HTMLInputElement).value); }
  setSessionName(event: Event): void { this.sessionName.set((event.target as HTMLInputElement).value); }
  setDuration(event: Event): void { this.duration.set(Number((event.target as HTMLInputElement).value)); }
  setName(id: number, event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.entries.update((entries) => entries.map((entry) => entry.id === id ? { ...entry, name } : entry));
    this.winner.set(null);
  }
  setWeight(id: number, event: Event): void {
    const weight = Math.max(1, Math.min(10, Math.round(Number((event.target as HTMLInputElement).value) || 1)));
    this.entries.update((entries) => entries.map((entry) => entry.id === id ? { ...entry, weight } : entry));
    this.winner.set(null);
  }
  add(): void {
    const name = this.draftName().trim();
    if (!name) { this.error.set(this.t('nameRequired')); return; }
    if (this.entries().length >= 12) { this.error.set(this.t('itemLimit')); return; }
    const palette = PALETTES[this.design()];
    this.entries.update((entries) => [...entries, { id: this.nextId++, name: name.slice(0, 40), weight: 1, color: palette[entries.length % palette.length] }]);
    this.draftName.set('');
    this.error.set('');
    this.winner.set(null);
  }
  remove(id: number): void {
    this.entries.update((entries) => entries.filter((entry) => entry.id !== id));
    this.winner.set(null);
    this.error.set('');
  }
  reset(): void {
    const palette = PALETTES[this.design()];
    this.entries.set([
      { id: this.nextId++, name: 'Pizza night', weight: 3, color: palette[0] },
      { id: this.nextId++, name: 'Game break', weight: 2, color: palette[1] },
      { id: this.nextId++, name: 'Chat picks', weight: 2, color: palette[2] },
      { id: this.nextId++, name: 'Mystery prize', weight: 1, color: palette[3] }
    ]);
    this.history.set([]);
    this.winner.set(null);
    this.error.set('');
  }
  spin(): void {
    if (!this.canSpin()) { this.error.set(this.t('needTwo')); return; }
    if (this.entries().some((entry) => !entry.name.trim())) { this.error.set(this.t('nameRequired')); return; }
    this.error.set('');
    this.winner.set(null);
    const pick = Math.random() * this.totalWeight();
    let tally = 0;
    const chosen = this.slices().find((slice) => { tally += slice.weight; return pick < tally; })!;
    const desired = POINTER_ANGLE[this.pointer()] - chosen.center;
    const current = ((this.rotation() % 360) + 360) % 360;
    const travel = ((desired - current) % 360 + 360) % 360;
    const seconds = this.duration();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.spinning.set(true);
    this.transition.set(reduced ? 'none' : `transform ${seconds}s cubic-bezier(.12,.72,.12,1)`);
    // A frame lets the browser commit the transition before the target angle changes.
    requestAnimationFrame(() => {
      this.rotation.update((angle) => angle + (reduced ? 0 : 360 * 5) + travel);
    });
    this.spinTimer = setTimeout(() => {
      this.spinning.set(false);
      this.winner.set(chosen);
      this.history.update((history) => [chosen.name, ...history].slice(0, 5));
      this.spinTimer = null;
    }, reduced ? 50 : seconds * 1000 + 80);
  }
  chance(weight: number): string { return `${Math.round(weight / this.totalWeight() * 100)}%`; }
  labelPosition(angle: number): string { return `rotate(${angle}deg)`; }
}
