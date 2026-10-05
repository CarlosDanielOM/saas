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
import {
  cardSequence,
  cardHighlight,
  eliminatedCount,
  eliminationOrder,
  landingOffset,
} from './card-highlight';
import { Roulette, RouletteDraw, slotsFor } from './roulette-api.service';

const BULBS = 24;
/** Dark or light text, whichever reads better on a prize colour. */
export function inkFor(color: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return '#ffffff';
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? '#14151a' : '#ffffff';
}

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
    () => this.draw()?.colors ?? this.roulette()?.colors ?? ['#cbbaff', '#f4c968', '#ec9baf'],
  );
  readonly winnerIndex = computed(() =>
    Math.max(
      0,
      this.slots().findIndex((s) => s.key === this.draw()?.winner.key),
    ),
  );
  readonly done = computed(() => !!this.draw() && this.progress() >= 1);
  readonly drawing = computed(() => !!this.draw() && this.progress() < 1);
  readonly state = computed(() => (this.done() ? 'done' : this.drawing() ? 'drawing' : 'idle'));
  readonly eased = computed(() => 1 - Math.pow(1 - this.progress(), 4));
  readonly position = computed(() =>
    this.draw() ? (this.slots().length * 5 + this.winnerIndex()) * this.eased() : 0,
  );
  // Render only the visible window; keys identify each individual copy and cycle.
  readonly reel = computed(() => {
    const slots = this.slots();
    if (!slots.length) return [];
    const center = Math.floor(this.position());
    return Array.from({ length: 9 }, (_, i) => {
      const index = center + i - 4;
      const at = ((index % slots.length) + slots.length) % slots.length;
      const color = this.color(at);
      return {
        slot: slots[at],
        key: `${index}:${slots[at].key}`,
        offset: (index - this.position()) * 158,
        color,
        ink: inkFor(color),
      };
    });
  });
  /** Whole turns scale with the draw length so long draws don't crawl. */
  readonly turns = computed(() => {
    const draw = this.draw();
    const seconds = draw ? (draw.endsAt - draw.startedAt) / 1000 : 4;
    return Math.min(40, Math.max(4, Math.round(3 + seconds * 0.8)));
  });
  readonly rotation = computed(() => {
    const draw = this.draw();
    if (!draw) return 0;
    const seg = 360 / Math.max(1, this.slots().length);
    const target = 360 * this.turns() - (this.winnerIndex() + 0.5 + landingOffset(draw.id)) * seg;
    return target * this.eased();
  });
  /** The pointer flicks back each time a segment edge passes under it. */
  readonly pointerTilt = computed(() => {
    const n = this.slots().length;
    if (!this.drawing() || n < 2 || n > 72) return 0;
    const seg = 360 / n;
    const within = (((this.rotation() % seg) + seg) % seg) / seg;
    return -20 * Math.max(0, 1 - within * 3);
  });
  readonly labelSize = computed(() => {
    const n = this.slots().length;
    return n <= 6 ? 17 : n <= 12 ? 14 : n <= 20 ? 12 : 10;
  });
  readonly segments = computed(() => {
    const all = this.slots();
    const max = all.length <= 6 ? 16 : all.length <= 12 ? 14 : all.length <= 20 ? 12 : 10;
    return all.map((slot, i) => {
      const a = (i * Math.PI * 2) / all.length - Math.PI / 2,
        b = ((i + 1) * Math.PI * 2) / all.length - Math.PI / 2;
      const color = this.color(i);
      return {
        slot,
        path: `M 200 200 L ${200 + 168 * Math.cos(a)} ${200 + 168 * Math.sin(a)} A 168 168 0 ${b - a > Math.PI ? 1 : 0} 1 ${200 + 168 * Math.cos(b)} ${200 + 168 * Math.sin(b)} Z`,
        angle: ((i + 0.5) * 360) / all.length - 90,
        color,
        ink: inkFor(color),
        text: slot.label.length > max ? slot.label.slice(0, max - 1) + '…' : slot.label,
      };
    });
  });
  readonly bulbs = Array.from({ length: BULBS }, (_, i) => {
    const a = (i * Math.PI * 2) / BULBS;
    return { x: 200 + 180 * Math.cos(a), y: 200 + 180 * Math.sin(a) };
  });
  readonly cardPath = computed(() => {
    const draw = this.draw();
    return draw ? cardSequence(draw.id, this.slots().length, draw.endsAt - draw.startedAt) : [];
  });
  readonly highlight = computed(() =>
    cardHighlight(this.cardPath(), this.progress(), this.winnerIndex()),
  );
  readonly knockouts = computed(() => {
    const draw = this.draw();
    return draw ? eliminationOrder(draw.id, this.slots().length, this.winnerIndex()) : [];
  });
  readonly out = computed(() => {
    const order = this.knockouts();
    return new Set(order.slice(0, eliminatedCount(order.length, this.progress())));
  });
  readonly remaining = computed(() => this.slots().length - this.out().size);
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
  ink(i: number): string {
    return inkFor(this.color(i));
  }
  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(`roulette.stage.${key}`, params);
  }
}
