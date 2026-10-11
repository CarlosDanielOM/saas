import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';
import { DuelArenaComponent } from '../../widgets/duel/duel-arena.component';
import { DuelCharacter, DuelSide, otherSide, simulateBattle, ultimateBattle } from '../../widgets/duel/duel-battle';
import { DuelGptArenaComponent } from './duel-gpt/duel-gpt-arena.component';
import { sampleBattle, SvgPreviewMove } from './duel-svg-gpt/duel-svg-showcase';
import { DuelSvgArenaComponent } from './duel-svg-gpt/duel-svg-arena.component';
import { DuelClaudeArenaComponent } from './duel-svg-claude/duel-claude-arena.component';
import { DuelAstraArenaComponent } from './duel-svg-astra/duel-astra-arena.component';

import { DuelAstra3dArenaComponent } from './duel-3d-astra/duel-astra-3d-arena.component';
import { DuelClaude3dArenaComponent } from './duel-3d-claude/duel-claude-3d-arena.component';

type Phase = 'ready' | 'entrance' | 'countdown' | 'fight' | 'knockout' | 'winner';

@Component({
  selector: 'app-duel-mock',
  imports: [RouterLink, ReactiveFormsModule, DuelArenaComponent, DuelGptArenaComponent, DuelAstra3dArenaComponent, DuelClaude3dArenaComponent, DuelSvgArenaComponent, DuelClaudeArenaComponent, DuelAstraArenaComponent],
  templateUrl: './duel-mock.component.html',
  styleUrl: './duel-mock.component.css',
  host: { '[class.overlay-only]': 'overlayOnly' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DuelMockComponent {
  readonly language = inject(LanguageService);
  readonly theme = inject(ThemeService);
  readonly overlayOnly = inject(ActivatedRoute).snapshot.queryParamMap.get('overlay') === '1';
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap;
  readonly renderMode = signal<'svg' | '3d'>(this.query.get('renderer') === '3d' ? '3d' : 'svg');
  readonly threeEntry = signal<'gpt' | 'claude' | 'astra'>(this.query.get('entry') === 'astra' ? 'astra' : this.query.get('entry') === 'claude' ? 'claude' : 'gpt');
  readonly svgEntry = signal<'original' | 'gpt' | 'claude' | 'astra'>(this.query.get('renderer') !== '3d' && ['gpt','claude','astra'].includes(this.query.get('entry') ?? '') ? this.query.get('entry') as 'gpt' | 'claude' | 'astra' : 'original');
  readonly sampleClass = signal<DuelCharacter>('knight');
  readonly previewMoves: SvgPreviewMove[] = ['normal','heavy','special','heal','defend','break'];
  readonly characters: DuelCharacter[] = ['knight', 'mage', 'ronin'];
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
    this.startTimer();
  }

  /** Fixed local choreography lets each class show its ultimate without waiting for RNG. */
  showcase(character: DuelCharacter): void {
    this.stopTimer();
    const values = this.form.getRawValue();
    this.names.set({ left: values.left.trim().slice(0, 24) || 'Dima', right: values.right.trim().slice(0, 24) || 'ChatChampion' });
    this.battle.set({ fighters: {left: character, right: character === 'knight' ? 'ronin' : 'knight'}, winner: 'left', duration: 11000, maxHp: 100, enraged: values.streamer ? 'right' : null,
      turns: [
        {at:3700,hitAt:3980,attacker:'left',move:'normal',damage:12,bonus:false},
        {at:4500,hitAt:4950,attacker:'right',move:'heavy',damage:22,bonus:false},
        {at:5550,hitAt:5830,attacker:'left',move:'normal',damage:14,bonus:false},
        {at:6350,hitAt:9150,attacker:'left',move:'ultimate',damage:74,bonus:false},
      ] });
    this.elapsed.set(5750);
    this.started.set(true);
    this.paused.set(false);
    this.startTimer();
  }

  seek(event: Event): void {
    this.elapsed.set(Number((event.target as HTMLInputElement).value));
    this.lastTick = performance.now();
    if (!this.timer && this.started() && this.elapsed() < this.duration()) this.startTimer();
  }

  /** Mock-only fixture exposes attack contact, a blocked hit, healing, and a guard break. */
  showcaseCombat(): void {
    this.stopTimer();
    const values = this.form.getRawValue();
    this.names.set({left:values.left.trim().slice(0,24)||'Dima',right:values.right.trim().slice(0,24)||'ChatChampion'});
    this.battle.set({fighters:{left:'ronin',right:'mage'},winner:'left',maxHp:100,healCharges:5,duration:14000,enraged:values.streamer?'right':null,turns:[
      {at:3700,hitAt:3980,attacker:'left',move:'normal',damage:12,bonus:false},
      {at:4500,hitAt:4950,attacker:'right',move:'heavy',damage:22,bonus:false,crit:true},
      {at:5550,hitAt:5830,attacker:'left',move:'normal',damage:0,defended:true,comboHeal:8,bonus:false},
      {at:7050,hitAt:7950,attacker:'right',move:'heal',damage:0,heal:4,bonus:false},
      {at:8550,hitAt:9400,attacker:'left',move:'special',damage:35,defended:true,bonus:false},
      {at:10150,hitAt:10600,attacker:'right',move:'heavy',damage:25,bonus:false},
      {at:11200,hitAt:12050,attacker:'left',move:'special',damage:65,bonus:false},
    ]});
    this.elapsed.set(3400);this.started.set(true);this.paused.set(false);this.startTimer();
  }

  previewMove(move: SvgPreviewMove): void {
    this.stopTimer();
    const values = this.form.getRawValue();
    this.names.set({left:values.left.trim().slice(0,24)||'Dima',right:values.right.trim().slice(0,24)||'ChatChampion'});
    this.battle.set(sampleBattle(this.sampleClass(),move,values.streamer?'right':null));
    this.elapsed.set(5250); this.started.set(true); this.paused.set(false); this.startTimer();
  }

  mirrorBattle(): void {
    const battle = this.battle();
    this.battle.set({...battle,fighters:{left:battle.fighters.right,right:battle.fighters.left},winner:otherSide(battle.winner),turns:battle.turns.map(turn=>({...turn,attacker:otherSide(turn.attacker)}))});
  }

  private startTimer(): void {
    this.lastTick = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const delta = now - this.lastTick;
      this.lastTick = now;
      if (!this.paused()) this.elapsed.update(time => Math.min(this.duration(), time + Math.min(delta, 100)));
      if (this.elapsed() >= this.duration()) this.stopTimer();
    }, Math.ceil(1000 / (this.renderMode() === 'svg' ? (this.svgEntry() === 'astra' ? 60 : 30) : this.threeEntry() === 'astra' ? 60 : 30)));
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
