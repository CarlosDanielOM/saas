import { HttpClient } from '@angular/common/http';
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
  output,
  signal,
  viewChild
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  BillingService,
  type GiftPackOffer,
  type GiftRecipient
} from '../../../services/billing.service';
import { LanguageService } from '../../../services/language.service';
import { LinksService } from '../../../services/links.service';
import { SessionAuthService } from '../../../services/session-auth.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import {
  PENDING_GIFT_STORAGE_KEY,
  createGiftRequestId,
  normalizeChannelLogin,
  readApiError
} from './gift.util';

type LookupState = 'idle' | 'searching' | 'found' | 'invalid' | 'self' | 'not_found' | 'error';

/** One pack as the buyer sees it: exact amounts plus value maths derived from the catalog. */
export interface GiftPackView {
  offer: GiftPackOffer;
  /** Credits per one major currency unit (per $1). */
  perUnit: number;
  /** Extra credits per unit vs. the lowest-rate pack in the same currency; 0 when none. */
  morePercent: number;
  /** Relative size among the packs on sale, for the icon scale only. */
  scale: 'sm' | 'md' | 'lg';
}

/** The checkout came back for something other than what the buyer confirmed. */
class GiftMismatchError extends Error {}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * "Gift someone" side of the credit store: the signed-in buyer picks a verified
 * channel and a permanent pack, reviews an exact confirmation, then pays on
 * Polar's hosted page. Delivery is reported by GiftStatusComponent after the
 * redirect back.
 */
@Component({
  selector: 'app-credit-gift',
  imports: [LfIconComponent],
  templateUrl: './credit-gift.component.html',
  styleUrl: './credit-gift.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onEscape()',
    '(document:keydown)': 'trapFocus($event)'
  }
})
export class CreditGiftComponent {
  private readonly billingService = inject(BillingService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  /** Channel to suggest (e.g. the channel an admin is viewing). A draft only: never auto-submitted. */
  readonly suggestedLogin = input('');
  /** The buyer typed their own channel and wants the "For me" store instead. */
  readonly buyForSelf = output<void>();

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
  /** Twitch profile image for the confirmed recipient; letter avatar until (or unless) it loads. */
  readonly avatarUrl = signal<string | null>(null);
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
  readonly recipientName = computed(
    () => this.recipient()?.displayName || this.recipient()?.login || ''
  );
  readonly recipientInitial = computed(
    () => (this.recipientName() || '?').charAt(0).toUpperCase()
  );
  /** The prefilled suggestion is still untouched and unconfirmed. */
  readonly showSuggestionHint = computed(() => {
    const suggestion = this.suggestedLogin().trim().toLowerCase();
    return Boolean(suggestion) && !this.recipient() && this.lookupState() === 'idle'
      && this.loginDraft().trim().toLowerCase() === suggestion;
  });

  readonly packs = computed<GiftPackView[]>(() => {
    const offers = this.offers() ?? [];
    const minRate = new Map<string, number>();
    for (const offer of offers) {
      const rate = offer.credits / offer.priceAmount;
      const currency = offer.priceCurrency.toLowerCase();
      minRate.set(currency, Math.min(minRate.get(currency) ?? rate, rate));
    }
    const bySize = [...offers].sort((a, b) => a.credits - b.credits);
    return offers.map((offer) => {
      const rate = offer.credits / offer.priceAmount;
      const lowest = minRate.get(offer.priceCurrency.toLowerCase()) ?? rate;
      const rank = bySize.indexOf(offer);
      return {
        offer,
        perUnit: Math.round(rate * 100),
        morePercent: offers.length > 1 ? Math.max(0, Math.floor((rate / lowest - 1) * 100)) : 0,
        scale: offers.length < 2 ? 'md' : rank === 0 ? 'sm' : rank === offers.length - 1 ? 'lg' : 'md'
      };
    });
  });

  /** One plain sentence answering "who gets what" for the summary card. */
  readonly summaryLine = computed(() => {
    const offer = this.selectedOffer();
    const name = this.recipientName();
    if (offer && name) {
      return this.t('creditGift.summary.ready', { name, credits: this.formatCreditsExact(offer.credits) });
    }
    if (name) return this.t('creditGift.summary.needPack', { name });
    if (offer) return this.t('creditGift.summary.needWho', { credits: this.formatCreditsExact(offer.credits) });
    return this.t('creditGift.summary.needBoth');
  });

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

    this.destroyRef.onDestroy(() => this.unlockScroll());
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  /** Brings the gift form into view and puts the cursor in the channel field (or the form when it's done). */
  reveal(): void {
    const section = this.section()?.nativeElement;
    if (!section) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    (this.loginInput()?.nativeElement ?? section).focus({ preventScroll: true });
  }

  onLoginInput(value: string): void {
    this.loginDraft.set(value);
    // Editing abandons any lookup still in flight: its answer is for a name that's no longer typed.
    if (this.lookupState() === 'searching') this.lookupSeq++;
    this.lookupState.set('idle');
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
      this.avatarUrl.set(safeImageUrl(response.data.avatarUrl));
      this.recipient.set(response.data);
      this.loginDraft.set(response.data.login);
      this.lookupState.set('found');
      if (!this.avatarUrl()) void this.loadAvatar(response.data.login, seq);
    } catch (error) {
      if (seq !== this.lookupSeq) return;
      this.lookupState.set(readApiError(error).status === 404 ? 'not_found' : 'error');
    }
  }

  changeRecipient(): void {
    this.lookupSeq++;
    this.recipient.set(null);
    this.avatarUrl.set(null);
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
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || !this.dialogOpen()) return;
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) return;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!items.length) {
      event.preventDefault();
      this.dialogTitle()?.nativeElement.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !items.some((item) => item === active))) {
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
        throw { status: response.status ?? null, error: response };
      }
      // Never send the buyer to pay for something other than what they just confirmed.
      if (data.recipient?.id !== recipient.id || data.offer?.id !== offer.id
        || data.offer.priceAmount !== offer.priceAmount
        || data.offer.priceCurrency !== offer.priceCurrency
        || data.offer.credits !== offer.credits || data.offer.rollover !== true) {
        throw new GiftMismatchError();
      }
      try {
        sessionStorage.setItem(PENDING_GIFT_STORAGE_KEY, data.giftId);
      } catch {
        // The return URL carries gift_id; storage is only a fallback.
      }
      window.location.assign(data.checkoutUrl);
    } catch (error) {
      this.submitError.set(this.checkoutErrorMessage(error));
      this.submitting.set(false);
    }
  }

  retryOffers(): void {
    void this.loadOffers();
  }

  retryLookup(): void {
    void this.lookup();
  }

  formatCreditsExact(value: number): string {
    return new Intl.NumberFormat(this.locale()).format(value);
  }

  formatPrice(offer: GiftPackOffer): string {
    return this.formatMoney(offer.priceAmount, offer.priceCurrency);
  }

  /** "50,000 credits per $1", derived from the pack's real price. */
  rateLabel(pack: GiftPackView): string {
    return this.t('creditGift.pack.rate', {
      credits: this.formatCreditsExact(pack.perUnit),
      unit: this.formatMoney(100, pack.offer.priceCurrency)
    });
  }

  moreLabel(pack: GiftPackView): string {
    return this.t('creditGift.pack.more', {
      percent: pack.morePercent,
      unit: this.formatMoney(100, pack.offer.priceCurrency)
    });
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

  /** Plain-language, localized reason; never raw server or provider text. */
  private checkoutErrorMessage(error: unknown): string {
    if (error instanceof GiftMismatchError) return this.t('creditGift.errors.mismatch');
    switch (readApiError(error).status) {
      case 404:
        return this.t('creditGift.errors.recipientGone');
      case 409:
        return this.t('creditGift.errors.account');
      case 400:
        return this.t('creditGift.errors.rejected');
      default:
        return this.t('creditGift.errors.checkout');
    }
  }

  private async loadAvatar(login: string, seq: number): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ error?: boolean; data?: { profile_image_url?: string } }>(
          `${this.links.getApiUrl()}/users?username=${encodeURIComponent(login)}`
        )
      );
      const url = safeImageUrl(response.data?.profile_image_url);
      if (seq === this.lookupSeq && url && this.recipient()?.login === login) {
        this.avatarUrl.set(url);
      }
    } catch {
      // The letter avatar stays; the photo is a nicety.
    }
  }

  private formatMoney(amount: number, currency: string): string {
    return new Intl.NumberFormat(this.locale(), {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(amount / 100);
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
      const offers = response.data.offers
        .filter((offer) => offer.credits > 0 && offer.priceAmount > 0)
        .sort((a, b) => a.priceAmount - b.priceAmount || a.credits - b.credits);
      this.offers.set(offers);
      if (!offers.some((offer) => offer.id === this.selectedOfferId())) {
        // Every paid pack requires an explicit choice, including a one-pack catalog.
        this.selectedOfferId.set(null);
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

/** Only https image URLs are used as avatars. */
function safeImageUrl(value: string | null | undefined): string | null {
  const url = value?.trim();
  return url && /^https:\/\//i.test(url) ? url : null;
}
