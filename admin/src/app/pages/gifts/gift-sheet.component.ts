import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { apiErrorMessage } from '../../services/api-util';
import { GiftsApiService, type GiftRow } from '../../services/gifts-api.service';
import { ConfirmModalComponent } from '../../shared/confirm-modal/confirm-modal.component';
import { dateTime, formatNumber } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { ToastService } from '../../shared/toast/toast.service';
import { giftAnswer, giftChips, giftPack, giftPrice, giftState, giftSteps, untilTime } from './gifts-format';

type RefKey = keyof GiftRow['refs'];

/** Polar references in the order the purchase made them, with the words the Polar dashboard uses. */
const REFS: ReadonlyArray<{ key: RefKey; label: string; copy: string }> = [
  { key: 'checkoutId', label: 'Checkout', copy: 'Copy checkout id' },
  { key: 'paidOrderId', label: 'Order (the payment)', copy: 'Copy order id' },
  { key: 'deliveryCheckoutId', label: 'Delivery checkout', copy: 'Copy delivery checkout id' },
  { key: 'deliveryOrderId', label: 'Delivery order (free)', copy: 'Copy delivery order id' },
  { key: 'grantId', label: 'Credit grant', copy: 'Copy grant id' },
];

/**
 * One gifted credit purchase in a bottom sheet (`?gift=`): where it is in plain words, each stage with its time,
 * the facts and Polar references, and "Try again now" for a paid gift that hasn't arrived.
 */
@Component({
  selector: 'app-gift-sheet',
  templateUrl: './gift-sheet.component.html',
  styleUrl: './gift-sheet.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent, ConfirmModalComponent],
})
export class GiftSheetComponent implements OnDestroy {
  private readonly api = inject(GiftsApiService);
  private readonly toast = inject(ToastService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private request?: Subscription;
  private retryRequest?: Subscription;
  private copiedTimer?: ReturnType<typeof setTimeout>;
  /** The gift the sheet last opened, so switching gifts clears the previous one's messages. */
  private shown: string | null = null;

  /** The gift to show (from `?gift=`); null keeps the sheet closed. */
  readonly giftId = input<string | null>(null);
  /** The list row when it is on screen; the sheet only asks the API when it isn't. */
  readonly preview = input<GiftRow | null>(null);
  /** The list is still loading: wait for it before asking for the gift on its own. */
  readonly listLoading = input(false);
  readonly closed = output<void>();
  /** A fresher copy of a gift (after a retry or a reload), for the list. */
  readonly changed = output<GiftRow>();

  private readonly loaded = signal<ReadonlyMap<string, GiftRow>>(new Map());
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly confirming = signal(false);
  readonly retrying = signal(false);
  /** The result of the last "Try again now", shown in the sheet (toasts sit behind the open sheet). */
  readonly result = signal<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  readonly copied = signal<string | null>(null);
  readonly now = signal(Date.now());

  readonly gift = computed(() => {
    const id = this.giftId();
    if (!id) return null;
    // The list row stays current (the page takes every fresher copy this sheet loads), so it wins.
    const preview = this.preview();
    return preview?.id === id ? preview : (this.loaded().get(id) ?? null);
  });
  readonly state = computed(() => {
    const gift = this.gift();
    return gift ? giftState(gift) : null;
  });
  readonly answer = computed(() => {
    const gift = this.gift();
    return gift ? giftAnswer(gift, this.now()) : null;
  });
  readonly steps = computed(() => {
    const gift = this.gift();
    return gift ? giftSteps(gift) : [];
  });
  /** The row's chips above the answer, except where the answer's first words already say the same. */
  readonly chips = computed(() => {
    const state = this.state();
    return state && !['expired', 'unpaid_flag', 'awaiting'].includes(state) ? giftChips(state) : [];
  });
  readonly refs = computed(() => {
    const gift = this.gift();
    return gift ? REFS.filter((ref) => gift.refs[ref.key]).map((ref) => ({ ...ref, value: gift.refs[ref.key]! })) : [];
  });
  /** Only a paid gift that hasn't arrived can be pushed, and not while the bot holds it. */
  readonly canRetry = computed(() => {
    const gift = this.gift();
    return Boolean(gift && gift.paid && !gift.deliveredAt && !gift.processing && gift.status !== 'expired');
  });
  /** Failed tries belong to the delivery while it isn't delivered, and to the announcement after. */
  readonly tries = computed(() => {
    const gift = this.gift();
    const state = this.state();
    if (!gift || !state) return null;
    if (state === 'expired' || state === 'announced') return null;
    if (gift.deliveredAt) return gift.announcementAttempts > 0 ? { label: 'Failed chat announcement tries', value: gift.announcementAttempts } : null;
    return { label: 'Failed attempts at this step', value: gift.attempts };
  });

  constructor() {
    effect(() => {
      const id = this.giftId();
      const waiting = this.listLoading();
      const hasPreview = this.preview()?.id === id;
      untracked(() => {
        const dialog = this.dialog().nativeElement;
        if (!id) {
          this.shown = null;
          this.request?.unsubscribe();
          this.loading.set(false);
          this.confirming.set(false);
          if (dialog.open) dialog.close();
          return;
        }
        this.now.set(Date.now());
        if (id !== this.shown) {
          this.shown = id;
          this.request?.unsubscribe();
          this.loading.set(false);
          this.result.set(null);
          this.error.set(null);
          this.confirming.set(false);
        }
        if (!dialog.open) {
          dialog.showModal();
          dialog.querySelector('.lf-dialog__body')?.scrollTo(0, 0);
        }
        if (!hasPreview && !waiting && !this.loaded().has(id) && !this.loading() && !this.error()) this.load(id);
      });
    });
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
    this.retryRequest?.unsubscribe();
    clearTimeout(this.copiedTimer);
  }

  /** Asks the API for the gift (deep links, Reload, and after a refused retry). */
  load(id = this.giftId()): void {
    if (!id) return;
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.request = this.api.get(id).subscribe({
      next: ({ data }) => {
        this.keep(data);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.error.set(
          error instanceof HttpErrorResponse && error.status === 404
            ? 'This gift doesn\'t exist, or the link is wrong.'
            : "The gift didn't load. Nothing was changed.",
        );
      },
    });
  }

  private keep(gift: GiftRow): void {
    const loaded = new Map(this.loaded());
    loaded.set(gift.id, gift);
    this.loaded.set(loaded);
    this.now.set(Date.now());
    this.changed.emit(gift);
  }

  askRetry(): void {
    this.result.set(null);
    this.confirming.set(true);
  }

  retry(): void {
    const gift = this.gift();
    if (!gift || this.retrying()) return;
    this.retrying.set(true);
    this.retryRequest = this.api.retry(gift.id).subscribe({
      next: ({ data, message }) => {
        this.retrying.set(false);
        this.confirming.set(false);
        this.keep(data);
        const text = message || 'The bot will try this gift again within a few seconds';
        this.result.set({ tone: 'ok', text });
        this.toast.success(text);
      },
      error: (error: unknown) => {
        this.retrying.set(false);
        this.confirming.set(false);
        const text = apiErrorMessage(error, "Couldn't ask the bot to try again. Nothing was changed.");
        this.result.set({ tone: 'danger', text });
        this.toast.error(text);
        // The gift changed under us (paid, delivered or being worked on): show how it is now.
        if (error instanceof HttpErrorResponse && error.status === 409) this.load(gift.id);
      },
    });
  }

  async copy(key: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.copied.set(key);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(null), 2000);
    } catch {
      this.toast.error('Could not copy. Select the id and copy it by hand.');
    }
  }

  close(): void {
    this.dialog().nativeElement.close();
  }

  /** Esc, the close buttons and a tap on the backdrop all end here. */
  onClose(): void {
    if (this.giftId()) this.closed.emit();
  }

  backdrop(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.close();
  }

  readonly dateTime = dateTime;
  readonly formatNumber = formatNumber;
  readonly pack = giftPack;
  readonly price = giftPrice;
  readonly until = (value: string | null) => untilTime(value, this.now());
}
