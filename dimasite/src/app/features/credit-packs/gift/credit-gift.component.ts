import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import {
  BillingService,
  type GiftPackOffer,
  type GiftRecipient
} from '../../../services/billing.service';
import { LanguageService } from '../../../services/language.service';
import { SessionAuthService } from '../../../services/session-auth.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import {
  PENDING_GIFT_STORAGE_KEY,
  createGiftRequestId,
  normalizeChannelLogin,
  readApiError
} from './gift.util';

type LookupState = 'idle' | 'searching' | 'found' | 'invalid' | 'self' | 'not_found' | 'error';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * "Gift credits" on the credit store: the signed-in buyer pays for a permanent
 * pack that lands on another DomDimaBot channel. Checkout is Polar's hosted page;
 * delivery is reported by GiftStatusComponent after the redirect back.
 */
@Component({
  selector: 'app-credit-gift',
  imports: [LfIconComponent],
  templateUrl: './credit-gift.component.html',
  styleUrl: './credit-gift.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onEscape()'
  }
})
export class CreditGiftComponent {
  private readonly billingService = inject(BillingService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  /** Channel to suggest (e.g. the channel an admin is viewing). Never auto-submitted. */
  readonly suggestedLogin = input('');

  private readonly section = viewChild<ElementRef<HTMLElement>>('section');
  private readonly loginInput = viewChild<ElementRef<HTMLInputElement>>('loginInput');
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly dialogTitle = viewChild<ElementRef<HTMLElement>>('dialogTitle');
  private readonly reviewButton = viewChild<ElementRef<HTMLButtonElement>>('reviewButton');

  readonly offers = signal<GiftPackOffer[] | null>(null);
  readonly offersLoading = signal(true);
  readonly offersError = signal(false);

  readonly loginDraft = signal('');
  readonly lookupState = signal<LookupState>('idle');
  readonly recipient = signal<GiftRecipient | null>(null);
  readonly avatarFailed = signal(false);
  readonly selectedOfferId = signal<string | null>(null);

  readonly dialogOpen = signal(false);
  readonly acknowledged = signal(false);
  readonly submitting = signal(false);
  readonly submitError = signal<string | null>(null);

  readonly buyerLogin = computed(
    () => (this.sessionAuth.session()?.twitchUser.login ?? '').trim().toLowerCase()
  );
  readonly buyerName = computed(
    () => this.sessionAuth.session()?.twitchUser.display_name || this.buyerLogin()
  );
  private readonly buyerId = computed(
    () => this.sessionAuth.session()?.appUser.twitch_user_id ?? ''
  );

  readonly selectedOffer = computed(
    () => this.offers()?.find((offer) => offer.id === this.selectedOfferId()) ?? null
  );
  readonly canReview = computed(
    () => Boolean(this.recipient() && this.selectedOffer() && this.buyerLogin())
  );
  readonly recipientInitial = computed(
    () => (this.recipient()?.displayName || this.recipient()?.login || '?').charAt(0).toUpperCase()
  );

  /** One idempotency key per (pack, recipient) intent; retries reuse it. */
  private requestId: { key: string; id: string } | null = null;
  private lookupSeq = 0;
  private returnFocus: HTMLElement | null = null;
  private suggestionApplied = false;

  constructor() {
    void this.loadOffers();

    effect(() => {
      const suggestion = this.suggestedLogin().trim().toLowerCase();
      if (this.suggestionApplied || !suggestion || suggestion === this.buyerLogin()) return;
      this.suggestionApplied = true;
      this.loginDraft.set(suggestion);
    });

    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((fragment) => {
      if (fragment === 'gift') {
        afterNextRender(() => this.reveal(), { injector: this.injector });
      }
    });

    this.destroyRef.onDestroy(() => this.unlockScroll());
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  /** Scrolls the gift section into view and puts the cursor in the channel field. */
  reveal(): void {
    const section = this.section()?.nativeElement;
    if (!section) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    (this.loginInput()?.nativeElement ?? section).focus({ preventScroll: true });
  }

  onLoginInput(value: string): void {
    this.loginDraft.set(value);
    if (this.lookupState() !== 'searching' && this.lookupState() !== 'found') {
      this.lookupState.set('idle');
    }
  }

  async lookup(event?: Event): Promise<void> {
    event?.preventDefault();
    const login = normalizeChannelLogin(this.loginDraft());
    if (!login) {
      this.lookupState.set('invalid');
      return;
    }
    if (login === this.buyerLogin()) {
      this.lookupState.set('self');
      return;
    }

    const seq = ++this.lookupSeq;
    this.lookupState.set('searching');
    try {
      const response = await firstValueFrom(this.billingService.findGiftRecipient(login));
      if (seq !== this.lookupSeq) return;
      if (response.error || !response.data?.id) {
        this.lookupState.set(response.status === 404 ? 'not_found' : 'error');
        return;
      }
      if (response.data.id === this.buyerId() || response.data.login.toLowerCase() === this.buyerLogin()) {
        this.lookupState.set('self');
        return;
      }
      this.avatarFailed.set(false);
      this.recipient.set(response.data);
      this.loginDraft.set(response.data.login);
      this.lookupState.set('found');
    } catch (error) {
      if (seq !== this.lookupSeq) return;
      this.lookupState.set(readApiError(error).status === 404 ? 'not_found' : 'error');
    }
  }

  changeRecipient(): void {
    this.lookupSeq++;
    this.recipient.set(null);
    this.lookupState.set('idle');
    afterNextRender(() => this.loginInput()?.nativeElement.select(), { injector: this.injector });
  }

  selectOffer(id: string): void {
    this.selectedOfferId.set(id);
  }

  openReview(): void {
    if (!this.canReview()) return;
    this.returnFocus = this.reviewButton()?.nativeElement ?? null;
    this.acknowledged.set(false);
    this.submitError.set(null);
    this.dialogOpen.set(true);
    this.lockScroll();
    afterNextRender(() => this.dialogTitle()?.nativeElement.focus(), { injector: this.injector });
  }

  closeReview(): void {
    if (!this.dialogOpen() || this.submitting()) return;
    this.dialogOpen.set(false);
    this.unlockScroll();
    const target = this.returnFocus;
    afterNextRender(() => target?.focus(), { injector: this.injector });
  }

  onEscape(): void {
    this.closeReview();
  }

  /** Keeps Tab inside the open dialog. */
  trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) return;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async confirmCheckout(): Promise<void> {
    const offer = this.selectedOffer();
    const recipient = this.recipient();
    if (!offer || !recipient || !this.acknowledged() || this.submitting()) return;

    this.submitting.set(true);
    this.submitError.set(null);
    try {
      const pageUrl = `${window.location.origin}${window.location.pathname}`;
      const response = await firstValueFrom(
        this.billingService.createGiftPackCheckout({
          productId: offer.id,
          recipientId: recipient.id,
          acknowledgeNoRefunds: true,
          requestId: this.requestIdFor(offer.id, recipient.id),
          successUrl: `${pageUrl}?gift=return`,
          returnUrl: pageUrl
        })
      );
      const data = response.data;
      if (response.error || !data?.checkoutUrl) {
        throw new Error(response.message || this.t('creditGift.errors.checkout'));
      }
      // Never send the buyer to pay for something other than what they just confirmed.
      if (data.recipient?.id !== recipient.id || data.offer?.id !== offer.id
        || data.offer.priceAmount !== offer.priceAmount
        || data.offer.priceCurrency !== offer.priceCurrency
        || data.offer.credits !== offer.credits || data.offer.rollover !== true) {
        throw new Error(this.t('creditGift.errors.mismatch'));
      }
      try {
        sessionStorage.setItem(PENDING_GIFT_STORAGE_KEY, data.giftId);
      } catch {
        // The return URL carries gift_id; storage is only a fallback.
      }
      window.location.assign(data.checkoutUrl);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : readApiError(error).message ?? this.t('creditGift.errors.checkout');
      this.submitError.set(message);
      this.submitting.set(false);
    }
  }

  retryOffers(): void {
    void this.loadOffers();
  }

  offerName(offer: GiftPackOffer): string {
    return /sample/i.test(offer.name) ? this.t('creditGift.sizes.sample') : offer.name;
  }

  formatCreditsExact(value: number): string {
    return new Intl.NumberFormat(this.locale()).format(value);
  }

  formatPrice(offer: GiftPackOffer): string {
    return new Intl.NumberFormat(this.locale(), {
      style: 'currency',
      currency: offer.priceCurrency.toUpperCase(),
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(offer.priceAmount / 100);
  }

  /** Unambiguous price for the confirmation: "$1.00 USD" / "1,00 $ USD". */
  formatExactPrice(offer: GiftPackOffer): string {
    const currency = offer.priceCurrency.toUpperCase();
    const amount = new Intl.NumberFormat(this.locale(), {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(offer.priceAmount / 100);
    return `${amount} ${currency}`;
  }

  private requestIdFor(productId: string, recipientId: string): string {
    const key = `${productId}:${recipientId}`;
    if (this.requestId?.key !== key) {
      this.requestId = { key, id: createGiftRequestId() };
    }
    return this.requestId.id;
  }

  private async loadOffers(): Promise<void> {
    this.offersLoading.set(true);
    this.offersError.set(false);
    try {
      const response = await firstValueFrom(this.billingService.getGiftPacks());
      if (response.error || !response.data) throw new Error('gift catalog unavailable');
      const offers = response.data.offers.filter((offer) => offer.credits > 0 && offer.priceAmount > 0);
      this.offers.set(offers);
      if (!offers.some((offer) => offer.id === this.selectedOfferId())) {
        // A lone pack is the only choice, so there is nothing to pre-select against.
        this.selectedOfferId.set(offers.length === 1 ? offers[0].id : null);
      }
    } catch {
      this.offers.set(null);
      this.offersError.set(true);
    } finally {
      this.offersLoading.set(false);
    }
  }

  private lockScroll(): void {
    document.body.style.overflow = 'hidden';
  }

  private unlockScroll(): void {
    document.body.style.removeProperty('overflow');
  }

  private locale(): string {
    return this.languageService.currentLanguage() === 'es' ? 'es-ES' : 'en-US';
  }
}
