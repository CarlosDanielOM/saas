import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';
import { DuelArenaComponent } from '../../widgets/duel/duel-arena.component';
import { DuelSide, simulateBattle, ultimateBattle } from '../../widgets/duel/duel-battle';

type Phase = 'ready' | 'entrance' | 'countdown' | 'fight' | 'knockout' | 'winner';

@Component({
  selector: 'app-duel-mock',
  imports: [RouterLink, ReactiveFormsModule, DuelArenaComponent],
  templateUrl: './duel-mock.component.html',
  styleUrl: './duel-mock.component.css',
  host: { '[class.overlay-only]': 'overlayOnly' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DuelMockComponent {
  readonly language = inject(LanguageService);
  readonly theme = inject(ThemeService);
  readonly overlayOnly = inject(ActivatedRoute).snapshot.queryParamMap.get('overlay') === '1';
  readonly sides: DuelSide[] = ['left', 'right'];
  readonly form = new FormGroup({
    left: new FormControl('Dima', { nonNullable: true }),
    right: new FormControl('ChatChampion', { nonNullable: true }),
    winner: new FormControl('random', { nonNullable: true }),
    streamer: new FormControl(false, { nonNullable: true })
  });
  readonly names = signal({ left: 'Dima', right: 'ChatChampion' });
  readonly battle = signal(simulateBattle());
  readonly duration = computed(() => this.battle().duration);
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
    if (time < (this.battle().turns.at(-1)?.hitAt ?? 0)) return 'fight';
    if (time < this.duration()) return 'knockout';
    return 'winner';
  });
  readonly active = computed(() => this.started() && this.elapsed() < this.duration());
  readonly countdown = computed(() => Math.max(1, 3 - Math.floor((this.elapsed() - 1300) / 700)));
  readonly winnerName = computed(() => this.names()[this.battle().winner]);
  readonly progress = computed(() => this.elapsed() / this.duration() * 100);

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

  play(ultimate = false): void {
    this.stopTimer();
    const values = this.form.getRawValue();
    this.names.set({ left: values.left.trim().slice(0, 24) || 'Dima', right: values.right.trim().slice(0, 24) || 'ChatChampion' });
    const enraged = values.streamer ? 'right' : null;
    this.battle.set(ultimate ? ultimateBattle(enraged) : simulateBattle(Math.random, enraged));
    this.elapsed.set(0);
    this.started.set(true);
    this.paused.set(false);
    this.lastTick = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const delta = now - this.lastTick;
      this.lastTick = now;
      if (!this.paused()) this.elapsed.update(time => Math.min(this.duration(), time + Math.min(delta, 100)));
      if (this.elapsed() >= this.duration()) this.stopTimer();
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
