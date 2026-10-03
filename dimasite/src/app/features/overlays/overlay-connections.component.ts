import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { OverlayApi, type OverlayConnections } from './overlay-api.service';
import type { OverlayScene } from './overlay.model';

/** One-word answer to "is this overlay showing in OBS?", used by the Studio header and setup strip. */
export type ConnectionState = 'checking' | 'unknown' | 'unsaved' | 'waiting' | 'unpublished' | 'offline' | 'ready' | 'attention';

@Component({
  selector: 'app-overlay-connections',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './overlay-connections.component.css',
  template: `
    <details class="connections" [attr.aria-label]="t('connectionsTitle')">
      <summary>
        <span>{{ t('connectionDetails') }}</span>
        @if (current()?.published) { <span class="count">{{ t('connectionsCount', { count: connected() }) }}</span> }
      </summary>
      <div class="body">
        <div class="heading">
          <div><h3>{{ t('connectionsTitle') }}</h3><p>{{ t('connectionsScope') }}</p></div>
          <button type="button" [disabled]="refreshing()" (click)="refresh()">{{ t('connectionsRefresh') }}</button>
        </div>
        @if (failed()) {
          <p class="warning" role="status">{{ t('connectionsUnavailable') }}</p>
        } @else if (!data()) {
          <p role="status">{{ t('connectionsChecking') }}</p>
        } @else if (current(); as status) {
          <div class="summary" role="status">
            <strong class="status" [class.good]="healthy()" [class.warning]="!healthy()">{{ t(!status.published ? 'connectionsUnpublished' : !connected() ? 'connectionsOffline' : healthy() ? 'connectionsReady' : 'connectionsAttention') }}</strong>
            <span>{{ t('connectionsCount', { count: connected() }) }}</span>
            <span>{{ t('connectionsRevision', { revision: status.revision }) }}</span>
          </div>
          @if (!status.published) {
            <p>{{ t('connectionsPublishHelp') }}</p>
          } @else {
            @if (!connected()) { <p>{{ t('connectionsOpenHelp', { width: status.width, height: status.height }) }}</p> }
            @if (connected() > 1) { <p class="warning">{{ t('connectionsDuplicateHelp') }}</p> }
            @if (data()?.pollingFailed) { <p class="warning">{{ t('connectionsPollingError') }}</p> }
            @if (status.receives.length) {
              <div class="receives"><span>{{ t('connectionsListening') }}</span>@for (kind of status.receives; track kind) { <span class="kind">{{ t(kind + 'Name') }}</span> }</div>
            } @else { <p>{{ t('connectionsStaticOnly') }}</p> }
            <ol class="sources">
              @for (source of status.sources; track $index) {
                <li>
                  <div class="source-heading"><strong>{{ t('connectionsSource', { number: $index + 1 }) }}</strong><span class="status" [class.good]="source.status === 'ready'" [class.warning]="source.status !== 'ready'">{{ t('connectionStatus_' + source.status) }}</span></div>
                  <p>{{ t('connectionsSourceRevision', { revision: source.revision ?? '—' }) }} · {{ t('connectionsLastReport', { time: time(source.lastReportAt) }) }}</p>
                  @if (source.status === 'reconnecting') { <p>{{ t('connectionsReconnectHelp') }}</p> }
                  @if (source.status === 'loading' || source.status === 'unresponsive') { <p>{{ t('connectionsRefreshHelp') }}</p> }
                  @if (source.status === 'updating') { <p>{{ t('connectionsUpdateHelp') }}</p> }
                  @if (source.activationFailed) { <p class="warning">{{ t('connectionsActivationError') }}</p> }
                  @if (source.stateFailed) { <p class="warning">{{ t('connectionsStateError') }}</p> }
                  @if (source.issue) { <p class="warning">{{ t('connectionIssue_' + source.issue) }} <span>{{ time(source.issueAt) }}</span></p> }
                </li>
              }
            </ol>
          }
          <p class="checked">{{ t('connectionsChecked', { time: time(data()?.checkedAt) }) }}</p>
        } @else {
          <p>{{ t(scene().publicId ? 'connectionsWaiting' : 'connectionsSaveHelp') }}</p>
        }
      </div>
    </details>
  `
})
export class OverlayConnectionsComponent {
  readonly channel = input.required<string>();
  readonly scene = input.required<OverlayScene>();
  readonly stateChange = output<{ state: ConnectionState; connected: number }>();
  private readonly api = inject(OverlayApi);
  private readonly language = inject(LanguageService);
  readonly data = signal<OverlayConnections | null>(null);
  readonly failed = signal(false);
  readonly refreshing = signal(false);
  private readonly refreshTick = signal(0);
  readonly current = computed(() => this.data()?.scenes.find(s => s.id === this.scene().id));
  readonly connected = computed(() => this.current()?.sources.filter(s => s.connected).length ?? 0);
  readonly healthy = computed(() => this.connected() > 0 && !this.data()?.pollingFailed && !!this.current()?.sources.filter(s => s.connected).every(s => s.status === 'ready' && !s.issue && !s.activationFailed && !s.stateFailed));
  readonly state = computed<ConnectionState>(() => {
    const status = this.current();
    if (this.failed()) return 'unknown';
    if (!this.data()) return 'checking';
    if (!status) return this.scene().publicId ? 'waiting' : 'unsaved';
    if (!status.published) return 'unpublished';
    if (!this.connected()) return 'offline';
    return this.healthy() ? 'ready' : 'attention';
  });
  constructor() {
    effect(() => this.stateChange.emit({ state: this.state(), connected: this.connected() }));
    effect(onCleanup => {
      const channel = this.channel(); this.refreshTick();
      if (!channel) return;
      let valid = true, timer: ReturnType<typeof setTimeout> | undefined;
      this.refreshing.set(true);
      void this.api.connections(channel).then(data => {
        if (!data || !Array.isArray(data.scenes)) throw new Error('Invalid connection status');
        if (valid) { this.data.set(data); this.failed.set(false); }
      }).catch(() => { if (valid) this.failed.set(true); }).finally(() => {
        if (valid) { this.refreshing.set(false); timer = setTimeout(() => this.refresh(), 5000); }
      });
      onCleanup(() => { valid = false; clearTimeout(timer); });
    });
  }
  refresh(): void { this.refreshTick.update(v => v + 1); }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate(`overlayStudio.${key}`, params); }
  time(value?: number | null): string { return value ? new Date(value).toLocaleTimeString(this.language.currentLanguage()) : '—'; }
}
