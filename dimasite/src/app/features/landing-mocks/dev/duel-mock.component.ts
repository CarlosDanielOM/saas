import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';
import { DuelFighterComponent } from './duel-fighter.component';

type Side = 'left' | 'right';
type Phase = 'ready' | 'entrance' | 'countdown' | 'fight' | 'knockout' | 'winner';
interface Hit { at: number; attacker: Side; damage: number }
const END = 11400;

@Component({
  selector: 'app-duel-mock',
  imports: [RouterLink, ReactiveFormsModule, DuelFighterComponent],
  templateUrl: './duel-mock.component.html',
  styleUrl: './duel-mock.component.css',
  host: { '[class.overlay-only]': 'overlayOnly' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DuelMockComponent {
  readonly language = inject(LanguageService);
  readonly theme = inject(ThemeService);
  readonly overlayOnly = inject(ActivatedRoute).snapshot.queryParamMap.get('overlay') === '1';
  readonly sides: Side[] = ['left', 'right'];
  readonly form = new FormGroup({
    left: new FormControl('Dima', { nonNullable: true }),
    right: new FormControl('ChatChampion', { nonNullable: true }),
    winner: new FormControl<'random' | Side>('random', { nonNullable: true })
  });
  readonly names = signal({ left: 'Dima', right: 'ChatChampion' });
  readonly chosenWinner = signal<Side>('left');
  readonly elapsed = signal(0);
  readonly started = signal(false);
  readonly paused = signal(false);
  readonly transparent = signal(this.overlayOnly);
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTick = 0;

  readonly phase = computed<Phase>(() => {
    const time = this.elapsed();
    if (!this.started()) return 'ready';
    if (time < 1300) return 'entrance';
    if (time < 3400) return 'countdown';
    if (time < 9500) return 'fight';
    if (time < END) return 'knockout';
    return 'winner';
  });
  readonly active = computed(() => this.started() && this.elapsed() < END);
  readonly countdown = computed(() => Math.max(1, 3 - Math.floor((this.elapsed() - 1300) / 700)));
  readonly hits = computed<Hit[]>(() => {
    const winner = this.chosenWinner();
    const loser: Side = winner === 'left' ? 'right' : 'left';
    return [
      { at: 3600, attacker: winner, damage: 18 },
      { at: 4650, attacker: loser, damage: 22 },
      { at: 5700, attacker: winner, damage: 24 },
      { at: 6750, attacker: loser, damage: 19 },
      { at: 7800, attacker: winner, damage: 26 },
      { at: 9050, attacker: winner, damage: 32 }
    ];
  });
  readonly currentHit = computed(() => this.hits().find(hit => this.elapsed() >= hit.at && this.elapsed() < hit.at + 700));
  readonly impact = computed(() => {
    const hit = this.currentHit();
    return hit && this.elapsed() >= hit.at + 280 && this.elapsed() < hit.at + 620 ? hit : null;
  });
  readonly health = computed(() => {
    const health = { left: 100, right: 100 };
    if (this.started()) for (const hit of this.hits()) {
      if (this.elapsed() >= hit.at + 280) health[hit.attacker === 'left' ? 'right' : 'left'] -= hit.damage;
    }
    return health;
  });
  readonly winnerName = computed(() => this.names()[this.chosenWinner()]);
  readonly progress = computed(() => this.elapsed() / END * 100);

  constructor() {
    const destroyRef = inject(DestroyRef);
    const document = inject(DOCUMENT);
    destroyRef.onDestroy(() => this.stopTimer());
    afterNextRender(() => {
      if (!this.overlayOnly) return;
      const background = document.body.style.background;
      document.body.style.background = 'transparent';
      destroyRef.onDestroy(() => { document.body.style.background = background; });
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(`duelMock.${key}`, params);
  }

  action(side: Side): string {
    if (!this.started()) return 'idle';
    if (this.health()[side] === 0) return 'defeated';
    if (this.phase() === 'winner' && side === this.chosenWinner()) return 'victory';
    const hit = this.currentHit();
    if (!hit) return 'idle';
    if (hit.attacker === side) return 'attack';
    return this.elapsed() >= hit.at + 280 ? 'hit' : 'idle';
  }

  play(): void {
    this.stopTimer();
    const values = this.form.getRawValue();
    this.names.set({ left: values.left.trim().slice(0, 24) || 'Dima', right: values.right.trim().slice(0, 24) || 'ChatChampion' });
    this.chosenWinner.set(values.winner === 'random' ? (Math.random() < .5 ? 'left' : 'right') : values.winner);
    this.elapsed.set(0);
    this.started.set(true);
    this.paused.set(false);
    this.lastTick = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const delta = now - this.lastTick;
      this.lastTick = now;
      if (!this.paused()) this.elapsed.update(time => Math.min(END, time + Math.min(delta, 100)));
      if (this.elapsed() >= END) this.stopTimer();
    }, 40);
  }

  reset(): void {
    this.stopTimer();
    this.elapsed.set(0);
    this.started.set(false);
    this.paused.set(false);
  }

  togglePause(): void { this.paused.update(value => !value); }
  toggleTransparent(): void { this.transparent.update(value => !value); }
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
