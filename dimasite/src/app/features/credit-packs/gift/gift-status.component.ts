import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { BillingService, type GiftStatusData } from '../../../services/billing.service';
import { LanguageService } from '../../../services/language.service';
import { LinksService } from '../../../services/links.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { GIFT_POLL_DELAYS_MS, PENDING_GIFT_STORAGE_KEY, readApiError } from './gift.util';

type ViewState =
  | 'checking'
  | 'awaiting'
  | 'delivering'
  | 'delivered'
  | 'support'
  | 'missing'
  | 'forbidden'
  | 'error';

type StepState = 'done' | 'current' | 'todo' | 'problem';

/**
 * Gift receipt shown after Polar redirects back with `?gift=return`. A redirect
 * only means checkout closed, so this polls the gift (bounded) and reports what
 * the server says: never "delivered" until the server does. The API has no chat
 * announcement state, so the thank-you is only ever described as upcoming.
 */
@Component({
  selector: 'app-gift-status',
  imports: [LfIconComponent],
  templateUrl: './gift-status.component.html',
  styleUrl: './gift-status.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GiftStatusComponent {
  private readonly billingService = inject(BillingService);
  private readonly languageService = inject(LanguageService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly discordUrl = inject(LinksService).getDiscordUrl();

  readonly visible = signal(false);
  readonly giftId = signal<string | null>(null);
  readonly gift = signal<GiftStatusData | null>(null);
  readonly view = signal<ViewState>('checking');
  /** Polling ran out before a final answer; the buyer can check again. */
  readonly stalled = signal(false);
  readonly polling = signal(false);
  readonly copied = signal(false);

  readonly recipientName = computed(() => {
    const recipient = this.gift()?.recipient;
    return recipient ? recipient.displayName || recipient.login : '';
  });
  /** Short, readable form of the gift reference; the copy button copies all of it. */
  readonly shortRef = computed(() => {
    const id = this.giftId() ?? '';
    return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}`.toUpperCase() : id;
  });
  readonly credits = computed(() =>
    new Intl.NumberFormat(this.locale()).format(this.gift()?.credits ?? 0)
  );
  readonly tone = computed(() => {
    switch (this.view()) {
      case 'delivered':
        return 'ok';
      case 'support':
      case 'missing':
      case 'forbidden':
      case 'error':
        return 'warn';
      default:
        return 'pending';
    }
  });
  readonly steps = computed<{ key: string; state: StepState }[]>(() => {
    const view = this.view();
    const paid: StepState = this.gift()?.paidAt ? 'done' : 'current';
    const deliver: StepState =
      view === 'delivered' ? 'done'
        : view === 'support' ? 'problem'
          : view === 'delivering' ? 'current' : 'todo';
    return [
      { key: 'paid', state: paid },
      { key: 'delivering', state: deliver },
      { key: 'delivered', state: view === 'delivered' ? 'done' : 'todo' }
    ];
  });
  readonly showSteps = computed(() =>
    ['checking', 'awaiting', 'delivering', 'delivered', 'support'].includes(this.view())
  );

  private timer: ReturnType<typeof setTimeout> | null = null;
  private run = 0;

  constructor() {
    const params = this.route.snapshot.queryParamMap;
    if (params.get('gift') !== 'return') return;

    let id = params.get('gift_id')?.trim() || null;
    if (!id) {
      try {
        id = sessionStorage.getItem(PENDING_GIFT_STORAGE_KEY);
      } catch {
        id = null;
      }
    }
    this.visible.set(true);
    this.giftId.set(id);
    if (!id) {
      this.view.set('missing');
    } else {
      this.startPolling();
    }
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  checkAgain(): void {
    this.startPolling();
  }

  async copyReference(): Promise<void> {
    const id = this.giftId();
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2500);
    } catch {
      this.copied.set(false);
    }
  }

  /** Closes the receipt and opens the gift form again. */
  sendAnother(): void {
    this.dismiss('gift');
  }

  dismiss(fragment?: string): void {
    this.stop();
    this.visible.set(false);
    try {
      sessionStorage.removeItem(PENDING_GIFT_STORAGE_KEY);
    } catch {
      // Nothing to clean up.
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { gift: null, gift_id: null, checkout_id: null },
      queryParamsHandling: 'merge',
      fragment,
      replaceUrl: true
    });
  }

  private startPolling(): void {
    this.stop();
    this.stalled.set(false);
    const run = ++this.run;
    this.polling.set(true);
    this.schedule(run, 0);
  }

  private schedule(run: number, attempt: number): void {
    if (attempt >= GIFT_POLL_DELAYS_MS.length) {
      this.polling.set(false);
      this.stalled.set(true);
      return;
    }
    this.timer = setTimeout(() => void this.poll(run, attempt), GIFT_POLL_DELAYS_MS[attempt]);
  }

  private async poll(run: number, attempt: number): Promise<void> {
    const id = this.giftId();
    if (!id || run !== this.run) return;
    try {
      const response = await firstValueFrom(this.billingService.getGift(id));
      if (run !== this.run) return;
      if (response.error || !response.data) {
        throw { status: response.status ?? null, error: response };
      }
      this.gift.set(response.data);
      this.view.set(this.viewFor(response.data));
      if (response.data.status === 'delivered' || response.data.status === 'needs_support') {
        this.finish();
        return;
      }
    } catch (error) {
      if (run !== this.run) return;
      const { status } = readApiError(error);
      if (status === 403 || status === 404) {
        this.view.set('forbidden');
        this.finish();
        return;
      }
      // Transient: keep the last known state, and only say so if we never got one.
      if (!this.gift()) this.view.set('error');
    }
    this.schedule(run, attempt + 1);
  }

  private viewFor(gift: GiftStatusData): ViewState {
    switch (gift.status) {
      case 'delivered':
        return 'delivered';
      case 'needs_support':
        return 'support';
      case 'payment_received':
      case 'delivering':
        return 'delivering';
      default:
        return 'awaiting';
    }
  }

  private finish(): void {
    this.polling.set(false);
    this.stalled.set(false);
    try {
      sessionStorage.removeItem(PENDING_GIFT_STORAGE_KEY);
    } catch {
      // Nothing to clean up.
    }
  }

  private stop(): void {
    this.run++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private locale(): string {
    return this.languageService.currentLanguage() === 'es' ? 'es-ES' : 'en-US';
  }
}
