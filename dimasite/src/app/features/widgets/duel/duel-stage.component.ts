import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';
import { DuelQuality, DuelRecord } from './duel-api.service';
import { DuelArenaComponent } from './duel-arena.component';
import { DuelBattle, legacyBattle } from './duel-battle';
import { DuelClaudeArenaComponent } from './quality-medium/duel-claude-arena.component';
import { DuelAstraArenaComponent } from './quality-high/duel-astra-arena.component';
import { DuelClaude3dArenaComponent } from './quality-extreme/duel-claude-3d-arena.component';

/**
 * The arena for a quality level: low is the original vector arena, medium the HD vector
 * remaster, high the cinematic vector edition and extreme the 3D arena. The 3D code (and
 * three.js) loads only when extreme is chosen; without WebGL it falls back to high.
 */
@Component({
  selector: 'app-duel-stage',
  imports: [DuelArenaComponent, DuelClaudeArenaComponent, DuelAstraArenaComponent, DuelClaude3dArenaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: ':host{display:block;width:100%}.stage-loading{width:100%;aspect-ratio:16/9}',
  template: `
    @switch (effective()) {
      @case ('medium') { <app-duel-claude-arena [names]="names()" [battle]="battle()" [elapsed]="elapsed()" [started]="started()" [paused]="paused()" [transparent]="transparent()" [locale]="locale()" [record]="record()" /> }
      @case ('high') { <app-duel-astra-arena [names]="names()" [battle]="battle()" [elapsed]="elapsed()" [started]="started()" [paused]="paused()" [transparent]="transparent()" [locale]="locale()" [record]="record()" /> }
      @case ('extreme') {
        @defer (on immediate) {
          <app-duel-claude-3d-arena [names]="names()" [battle]="battle()" [elapsed]="elapsed()" [started]="started()" [paused]="paused()" [transparent]="transparent()" [locale]="locale()" [record]="record()" (failed)="webglFailed.set(true)" />
        } @placeholder { <div class="stage-loading" aria-hidden="true"></div> }
        @error { <app-duel-astra-arena [names]="names()" [battle]="battle()" [elapsed]="elapsed()" [started]="started()" [paused]="paused()" [transparent]="transparent()" [locale]="locale()" [record]="record()" /> }
      }
      @default { <app-duel-arena [names]="names()" [battle]="battle()" [elapsed]="elapsed()" [started]="started()" [paused]="paused()" [transparent]="transparent()" [locale]="locale()" [record]="record()" /> }
    }`,
})
export class DuelStageComponent {
  readonly quality = input<DuelQuality>('low');
  readonly names = input({ left: 'Dima', right: 'ChatChampion' });
  readonly battle = input<DuelBattle>(legacyBattle('left'));
  readonly elapsed = input(0);
  readonly started = input(false);
  readonly paused = input(false);
  readonly transparent = input(false);
  readonly locale = input<'en' | 'es'>('en');
  readonly record = input<DuelRecord | null>(null);
  /** A browser source without WebGL (hardware acceleration off) shows the high arena instead. */
  readonly webglFailed = signal(false);
  readonly effective = computed<DuelQuality>(() => this.quality() === 'extreme' && this.webglFailed() ? 'high' : this.quality());
  constructor() { effect(() => { if (this.quality() !== 'extreme') this.webglFailed.set(false); }); }
}
