import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { WidgetRole } from './widgets-api.service';

type IconState = 'empty' | 'earned' | 'fresh' | 'flare' | 'lost';
const MAX_ICONS = 10;

/**
 * Win streak icons: killer wins are skulls forged in fire, survivor wins are hatches that open.
 * Only changes seen while mounted animate, so an OBS source that loads mid-challenge stays calm.
 */
@Component({
  selector: 'app-widget-streak',
  templateUrl: './widget-streak.component.html',
  styleUrl: './widget-streak.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.killer]': "role() === 'killer'", '[class.survivor]': "role() === 'survivor'", '[class.complete]': 'wins() >= target()', '[class.finale]': 'finale()', '[attr.data-wins]': 'wins()' },
})
export class WidgetStreakComponent {
  readonly role = input.required<WidgetRole>();
  readonly wins = input.required<number>();
  readonly target = input.required<number>();
  /** Increment to replay the next win animation locally without recording a win. */
  readonly celebrate = input(0);
  readonly label = input('');
  private readonly fresh = signal<number | null>(null);
  private readonly lost = signal<number | null>(null);
  private readonly demo = signal<number | null>(null);
  readonly finale = signal(false);
  private readonly generation = signal(0);
  private previous: number | null = null;
  private lastCelebrate = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  readonly icons = computed(() => {
    const count = Math.min(MAX_ICONS, this.target()), demo = this.demo(), shown = demo === null ? this.wins() : demo + 1;
    const fresh = demo ?? this.fresh(), lost = this.lost(), finale = this.finale(), gen = this.generation();
    return Array.from({length: count}, (_, i) => {
      const state: IconState = i < shown ? (i === fresh ? 'fresh' : finale ? 'flare' : 'earned') : i === lost ? 'lost' : 'empty';
      return { i, state, key: `${i}-${state === 'earned' || state === 'empty' ? 0 : gen}` };
    });
  });
  readonly sparks = [0, 1, 2, 3, 4, 5, 6];

  constructor() {
    effect(() => {
      const wins = this.wins(), target = this.target();
      untracked(() => {
        const previous = this.previous;
        this.previous = wins;
        if (previous === null || previous === wins) return;
        this.demo.set(null);
        if (wins > previous) {
          this.fresh.set(Math.min(wins, MAX_ICONS) - 1); this.lost.set(null);
          if (wins >= target) this.playFinale();
        } else { this.lost.set(wins); this.fresh.set(null); this.finale.set(false); }
        this.generation.update(n => n + 1);
      });
    });
    effect(() => {
      const tick = this.celebrate();
      untracked(() => {
        if (tick === this.lastCelebrate) return;
        this.lastCelebrate = tick;
        if (!tick) return;
        const wins = Math.min(this.wins(), MAX_ICONS), target = Math.min(this.target(), MAX_ICONS);
        this.lost.set(null);
        if (wins < target) {
          // Show what the next win looks like, then put the real count back.
          this.demo.set(wins); this.generation.update(n => n + 1);
          if (wins + 1 >= target) this.playFinale();
          this.later(2800, () => { if (this.demo() === wins) { this.demo.set(null); this.lost.set(wins); this.finale.set(false); this.generation.update(n => n + 1); } });
        } else { this.fresh.set(wins - 1); this.generation.update(n => n + 1); this.playFinale(); }
      });
    });
    inject(DestroyRef).onDestroy(() => this.timers.forEach(clearTimeout));
  }

  private playFinale(): void {
    this.finale.set(true);
    this.later(3400, () => this.finale.set(false));
  }
  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => { this.timers = this.timers.filter(t => t !== timer); run(); }, ms);
    this.timers.push(timer);
  }
}
