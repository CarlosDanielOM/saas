import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { OverlayApi } from './overlay-api.service';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import type { InteractionKind, InteractionReadinessSnapshot } from './overlay-interaction.model';

@Component({
  selector: 'app-overlay-interaction-setup', changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './overlay-interaction-setup.component.css',
  template: `
    <section class="setup" [attr.aria-label]="t('interactionSetup')">
      <div class="heading"><div><h2>{{ t('interactionSetup') }}</h2><p>{{ t('interactionSetupHint') }}</p></div><button type="button" [disabled]="checking() || !!activating()" (click)="refresh()">{{ t('connectionsRefresh') }}</button></div>
      @if (error() || actionError()) { <p class="warning" role="alert">{{ t('interactionSetupError') }}</p> }
      <div class="kinds">
        @for (kind of kinds; track kind) {
          <div class="kind">
            <div><strong>{{ t(kind + 'Name') }}</strong><span class="status" [class.ready]="status(kind) === 'ready'" role="status">{{ t('interactionStatus_' + status(kind)) }}</span></div>
            <p>{{ t(status(kind) === 'ready' ? 'interactionReadyHint' : status(kind) === 'permission' ? 'interactionPermissionHint' : 'interactionActivateHint') }}</p>
            @if (status(kind) === 'permission') {
              <a [href]="reconnectUrl()">{{ t('interactionReconnect') }}</a>
            } @else {
              <button type="button" [disabled]="checking() || !!activating() || status(kind) === 'ready' || status(kind) === 'pending'" (click)="activate(kind)">{{ t(activating() === kind ? 'interactionActivating' : 'interactionActivate') }}</button>
            }
          </div>
        }
      </div>
    </section>
  `
})
export class OverlayInteractionSetupComponent {
  readonly channel = input.required<string>();
  readonly streamer = input.required<string>();
  readonly kinds = ['poll', 'prediction'] as const;
  private readonly api = inject(OverlayApi);
  private readonly language = inject(LanguageService);
  private readonly links = inject(LinksService);
  readonly data = signal<InteractionReadinessSnapshot | null>(null);
  readonly checking = signal(false);
  readonly activating = signal<InteractionKind | null>(null);
  readonly error = signal(false);
  readonly actionError = signal(false);
  private readonly tick = signal(0);
  readonly reconnectUrl = computed(() => `${this.links.getApiUrl()}/auth/authorize?${new URLSearchParams({ state: this.streamer(), action: 'reauthenticate' })}`);
  constructor() {
    effect(onCleanup => {
      const channel = this.channel(); this.tick(); if (!channel) return;
      let valid = true, timer: ReturnType<typeof setTimeout> | undefined;
      this.checking.set(true);
      void this.api.twitchEvents(channel).then(data => { if (valid) { this.data.set(data); this.error.set(false); } })
        .catch(() => { if (valid) this.error.set(true); })
        .finally(() => {
          if (valid) {
            this.checking.set(false);
            // Only poll during Twitch's callback challenge; no background repair.
            if (this.data()?.poll?.state === 'pending' || this.data()?.prediction?.state === 'pending') timer = setTimeout(() => this.refresh(), 5000);
          }
        });
      onCleanup(() => { valid = false; clearTimeout(timer); });
    });
  }
  t(key: string): string { return this.language.translate('overlayStudio.' + key); }
  status(kind: InteractionKind): string { return this.error() ? 'error' : this.data()?.[kind]?.state ?? 'checking'; }
  refresh(): void { this.tick.update(n => n + 1); }
  async activate(kind: InteractionKind): Promise<void> {
    if (this.activating()) return;
    this.activating.set(kind); this.actionError.set(false);
    try { this.data.set(await this.api.activateTwitchEvents(this.channel(), kind)); }
    catch { this.actionError.set(true); }
    finally { this.activating.set(null); this.refresh(); }
  }
}
