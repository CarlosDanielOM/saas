import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { OverlayApi } from './overlay-api.service';
import { LanguageService } from '../../services/language.service';
import type { OverlayAction, OverlayScope, QueueStatus } from './overlay-queue.model';

@Component({
  selector: 'app-overlay-queue', changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './overlay-queue.component.css',
  template: `
    <section class="live-controls" aria-labelledby="overlay-live-controls-title">
      <div class="heading">
        <div><h2 id="overlay-live-controls-title">{{ t('liveControls') }}</h2><p class="lead">{{ t('liveControlsLead') }}</p></div>
        @if (data()) { <span class="state" [class.paused]="paused() || mixed()" aria-live="polite">{{ t(paused() ? 'queuePaused' : mixed() ? 'queueMixed' : 'queueRunning') }}</span> }
      </div>
      @if (data(); as status) {
        @if (status.needsRefresh) { <p class="warning">{{ t('controlsRefresh', { count: status.needsRefresh }) }}</p> }
        @if (!status.connected) { <p>{{ t('controlsOffline') }}</p> }
        <div class="actions">
          <button type="button" [disabled]="busy() || failed()" (click)="control('pause')">{{ t('controlPause') }}</button>
          <button type="button" [disabled]="busy() || failed()" (click)="control('resume')">{{ t('controlResume') }}</button>
          <button type="button" [disabled]="busy() || failed() || !playing().length" (click)="control('skip')">{{ t('controlSkip') }}</button>
          <button type="button" [disabled]="busy() || failed() || !queued().length" (click)="control('clear')">{{ t('controlClear') }}</button>
        </div>
        <div class="counts"><span>{{ t('queuePlaying', { count: playing().length }) }}</span><span>{{ t('queueWaiting', { count: queued().length }) }}</span></div>
        @if (visibleEvents().length) {
          <ul>
            @for (event of visibleEvents().slice(0, 8); track event.id) {
              <li><span>{{ t(event.kind + 'Name') }}</span><span class="platform">{{ t('platform_' + event.platform) }}</span><span>{{ t(event.status === 'playing' ? 'playingLabel' : 'waitingLabel') }}</span></li>
            }
          </ul>
        }
        @if (visibleEvents().length > 8) { <p>{{ t('queueMore', { count: visibleEvents().length - 8 }) }}</p> }
      }
      @if (failed()) { <p class="warning" role="alert">{{ t('controlsLoadError') }} <button type="button" (click)="refresh()">{{ t('controlsRetry') }}</button></p> }
      @if (message()) { <p role="status">{{ message() }}</p> }
      <details class="options">
        <summary>{{ t('liveOptions') }}</summary>
        <p>{{ t('liveControlsHelp') }}</p>
        <label>{{ t('controlPlatform') }}
          <select [value]="scope()" (change)="chooseScope($event)">
            @for (platform of scopes; track platform) { <option [value]="platform" [selected]="platform === scope()">{{ t('platform_' + platform) }}</option> }
          </select>
        </label>
        <p class="behavior">{{ t('controlBehavior') }}</p>
        @if (data() && scope() !== 'other') { <p class="ast"><span>{{ t('controlAst') }}</span> <code>{{ astExample() }}</code></p> }
      </details>
    </section>
  `})
export class OverlayQueueComponent {
  readonly channel = input.required<string>();
  private readonly api = inject(OverlayApi);
  private readonly language = inject(LanguageService);
  readonly scopes: OverlayScope[] = ['all', 'twitch', 'kick', 'other'];
  readonly scope = signal<OverlayScope>('all');
  readonly data = signal<QueueStatus | null>(null);
  readonly busy = signal(false);
  readonly failed = signal(false);
  readonly message = signal('');
  private readonly tick = signal(0);
  private generation = 0;
  readonly visibleEvents = computed(() => (this.data()?.events ?? []).filter(event => this.scope() === 'all' || event.platform === this.scope()));
  readonly playing = computed(() => this.visibleEvents().filter(event => event.status === 'playing'));
  readonly queued = computed(() => this.visibleEvents().filter(event => event.status === 'queued'));
  readonly pauseStates = computed(() => {
    const state = this.data()?.state;
    return (this.scope() === 'all' ? ['twitch', 'kick', 'other'] as const : [this.scope() as 'twitch' | 'kick' | 'other']).map(platform => state?.platforms[platform] ?? state?.all ?? false);
  });
  readonly paused = computed(() => this.pauseStates().every(Boolean));
  readonly mixed = computed(() => this.pauseStates().some(Boolean) && !this.paused());
  readonly astExample = computed(() => '$(overlay.skip' + (this.scope() === 'all' ? '' : this.scope() === 'other' ? '' : '.' + this.scope()) + ')');
  constructor() {
    effect(onCleanup => {
      const channel = this.channel(); this.tick(); const busy = this.busy(); const generation = ++this.generation;
      if (!channel || busy) return;
      let valid = true, timer: ReturnType<typeof setTimeout>;
      void this.api.queue(channel).then(status => {
        if (!status?.state || !Array.isArray(status.events)) throw new Error('Invalid queue status');
        if (valid && generation === this.generation) { this.data.set(status); this.failed.set(false); }
      }).catch(() => { if (valid) this.failed.set(true); }).finally(() => { if (valid) timer = setTimeout(() => this.refresh(), 2500); });
      onCleanup(() => { valid = false; clearTimeout(timer); });
    });
  }
  chooseScope(event: Event): void { this.scope.set((event.target as HTMLSelectElement).value as OverlayScope); this.message.set(''); }
  refresh(): void { this.tick.update(value => value + 1); }
  async control(action: OverlayAction): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.message.set(''); ++this.generation;
    try { this.data.set(await this.api.control(this.channel(), action, this.scope())); this.failed.set(false); this.message.set(this.t('controlSent')); }
    catch { this.message.set(this.t('controlFailed')); }
    finally { this.busy.set(false); }
  }
  t(key: string, values?: Record<string, string | number>): string { return this.language.translate('overlayStudio.' + key, values); }
}
