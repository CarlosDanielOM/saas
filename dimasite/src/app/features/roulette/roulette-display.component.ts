import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { cardSequence, cardHighlight } from './card-highlight';
import { Roulette, RouletteDraw, slotsFor } from './roulette-api.service';

/** Both dashboard and OBS render the same server-selected, frozen draw. */
@Component({
  selector: 'app-roulette-display',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './roulette-display.component.html',
  styleUrl: './roulette-display.component.css',
})
export class RouletteDisplayComponent {
  readonly roulette = input<Roulette | null>(null);
  readonly draw = input<RouletteDraw | null>(null);
  readonly serverTime = input(0);
  readonly progress = signal(0);
  readonly language = inject(LanguageService);
  readonly slots = computed(
    () => this.draw()?.slots ?? (this.roulette() ? slotsFor(this.roulette()!) : []),
  );
  readonly design = computed(() => this.draw()?.design ?? this.roulette()?.design ?? 'wheel');
  readonly colors = computed(
    () => this.draw()?.colors ?? this.roulette()?.colors ?? ['#7c3aed', '#b45309', '#0369a1'],
  );
  readonly winnerIndex = computed(() =>
    Math.max(
      0,
      this.slots().findIndex((s) => s.key === this.draw()?.winner.key),
    ),
  );
  readonly done = computed(() => !!this.draw() && this.progress() >= 1);
  readonly position = computed(() =>
    this.draw()
      ? (this.slots().length * 5 + this.winnerIndex()) * (1 - Math.pow(1 - this.progress(), 4))
      : 0,
  );
  // Render only the visible window; keys identify each individual copy and cycle.
  readonly reel = computed(() => {
    const slots = this.slots();
    if (!slots.length) return [];
    const center = Math.floor(this.position());
    return Array.from({ length: 9 }, (_, i) => {
      const index = center + i - 4;
      const slot = slots[((index % slots.length) + slots.length) % slots.length];
      return {
        slot,
        key: `${index}:${slot.key}`,
        offset: (index - this.position()) * 158,
        color: this.color(((index % slots.length) + slots.length) % slots.length),
      };
    });
  });
  readonly rotation = computed(() =>
    this.draw()
      ? (1800 + 360 - ((this.winnerIndex() + 0.5) * 360) / Math.max(1, this.slots().length)) *
        (1 - Math.pow(1 - this.progress(), 4))
      : 0,
  );
  readonly segments = computed(() =>
    this.slots().map((slot, i, all) => {
      const a = (i * Math.PI * 2) / all.length - Math.PI / 2,
        b = ((i + 1) * Math.PI * 2) / all.length - Math.PI / 2;
      return {
        slot,
        path: `M 200 200 L ${200 + 190 * Math.cos(a)} ${200 + 190 * Math.sin(a)} A 190 190 0 ${b - a > Math.PI ? 1 : 0} 1 ${200 + 190 * Math.cos(b)} ${200 + 190 * Math.sin(b)} Z`,
        angle: ((i + 0.5) * 360) / all.length - 90,
        color: this.color(i),
      };
    }),
  );
  readonly cardPath = computed(() => {
    const draw = this.draw();
    return draw ? cardSequence(draw.id, this.slots().length, draw.endsAt - draw.startedAt) : [];
  });
  readonly highlight = computed(() =>
    cardHighlight(this.cardPath(), this.progress(), this.winnerIndex()),
  );
  constructor() {
    effect((onCleanup) => {
      const draw = this.draw();
      const now = this.serverTime();
      if (!draw) {
        this.progress.set(0);
        return;
      }
      const origin = performance.now();
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      let frame = 0;
      const tick = () => {
        const p = Math.min(
          1,
          Math.max(
            0,
            (now + performance.now() - origin - draw.startedAt) / (draw.endsAt - draw.startedAt),
          ),
        );
        this.progress.set(reduced && p < 1 ? 0 : p);
        if (p < 1) frame = requestAnimationFrame(tick);
      };
      tick();
      onCleanup(() => cancelAnimationFrame(frame));
    });
  }
  color(i: number): string {
    const colors = this.colors();
    return colors[i % colors.length];
  }
  t(key: string): string {
    return this.language.translate(`roulette.${key}`);
  }
}
