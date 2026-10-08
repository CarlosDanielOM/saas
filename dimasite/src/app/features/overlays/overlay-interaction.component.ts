import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import type { InteractionState } from './overlay-interaction.model';

@Component({
  selector: 'app-overlay-interaction', changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './overlay-interaction.component.css',
  template: `
    @if (state(); as data) { @if (showing()) {
      <section class="panel" [class.compact]="design() === 'compact'" [class.prediction]="data.kind === 'prediction'" [class.ended]="ended()" [class.many]="data.choices.length > 5" [attr.data-phase]="data.phase" [attr.aria-label]="data.title">
        <header><div class="eyebrow"><span class="dot" aria-hidden="true"></span>{{ t(data.kind + 'Name') }}<span class="phase">{{ label() }}</span></div><h2>{{ data.title }}</h2></header>
        <div class="choices">
          @for (choice of data.choices; track choice.id; let index = $index) {
            <div class="choice" [class.winner]="winners().includes(choice.id)" [class.pink]="choice.color === 'pink'" [style.--choice-color]="color(index)">
              <div class="choice-heading"><span class="choice-title">{{ choice.title }}</span><strong>{{ percentage(choice.id) }}%</strong></div>
              <div class="track" aria-hidden="true"><div class="fill" [style.width.%]="percentage(choice.id)"></div></div>
              <div class="choice-details"><span>{{ number(data.kind === 'poll' ? choice.votes : choice.points) }} {{ t(data.kind === 'poll' ? 'interactionVotes' : 'interactionPoints') }}</span>@if (data.kind === 'prediction') { <span>{{ number(choice.users) }} {{ t('interactionParticipants') }}</span> }@if (winners().includes(choice.id)) { <strong>{{ t(winners().length > 1 ? 'interactionTied' : 'interactionWinner') }}</strong> }</div>
            </div>
          }
        </div>
        <footer><span>{{ t(data.kind === 'poll' ? 'interactionVoteOnTwitch' : 'interactionPredictOnTwitch') }}</span><strong>{{ ended() || data.phase === 'locked' ? label() : remaining() }}</strong></footer>
      </section>
    } }
  `
})
export class OverlayInteractionComponent {
  readonly state = input<InteractionState | null>(null);
  readonly design = input<'card' | 'compact'>('card');
  readonly preview = input(false);
  readonly clockOffset = input(0);
  private readonly language = inject(LanguageService);
  private readonly now = signal(Date.now());
  readonly ended = computed(() => !!this.state() && !['active', 'locked'].includes(this.state()!.phase));
  readonly showing = computed(() => !!this.state() && (this.preview() || !this.ended() || !!this.state()!.endedAt && this.now() + this.clockOffset() < Date.parse(this.state()!.endedAt!) + 15_000));
  readonly winners = computed(() => {
    const data = this.state(); if (!data) return [];
    if (data.kind === 'prediction') return data.phase === 'resolved' && data.winnerId ? [data.winnerId] : [];
    if (data.phase !== 'completed') return [];
    const max = Math.max(...data.choices.map(choice => choice.votes));
    return max > 0 ? data.choices.filter(choice => choice.votes === max).map(choice => choice.id) : [];
  });
  readonly label = computed(() => {
    const data = this.state(); if (!data) return '';
    return this.t(data.phase === 'active' ? 'interactionOpen' : data.phase === 'locked' ? 'interactionLocked'
      : data.phase === 'canceled' || data.phase === 'terminated' ? 'interactionCanceled' : 'interactionResults');
  });
  readonly remaining = computed(() => {
    const deadline = this.state()?.deadline; if (!deadline) return '';
    const seconds = Math.max(0, Math.ceil((Date.parse(deadline) - this.now() - this.clockOffset()) / 1000));
    return seconds === 0 ? this.t('interactionClosing') : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  });
  constructor() { const timer = setInterval(() => this.now.set(Date.now()), 250); inject(DestroyRef).onDestroy(() => clearInterval(timer)); }
  t(key: string): string { return this.language.translate('overlayStudio.' + key); }
  number(value: number): string { return new Intl.NumberFormat(this.language.currentLanguage()).format(value); }
  percentage(id: string): number {
    const data = this.state(); if (!data) return 0;
    const total = data.choices.reduce((sum, c) => sum + (data.kind === 'poll' ? c.votes : c.points), 0);
    const choice = data.choices.find(c => c.id === id);
    return total && choice ? Math.round((data.kind === 'poll' ? choice.votes : choice.points) / total * 100) : 0;
  }
  color(index: number): string { return ['#b69bff', '#6edac3', '#f2c97c', '#ed98b7', '#91bafc'][index % 5]; }
}
