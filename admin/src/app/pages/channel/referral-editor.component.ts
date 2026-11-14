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
  untracked,
  viewChild,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';

import {
  ReferralsApiService,
  type ReferralCode,
  type ReferralPerson,
  type Referrals,
  type ReferredBy,
  type SetReferrer,
} from '../../services/referrals-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { AvatarComponent } from '../../shared/avatar/avatar.component';
import { ChannelPickerComponent, type PickedChannel } from '../../shared/channel-picker/channel-picker.component';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { formatNumber } from '../../shared/format';

/**
 * What the dialog edits. `inviter`: choose who invited `person` (this channel). `invited`: add someone that
 * `person` invited (the write goes to the picked person's channel with `person` as the referrer).
 */
export interface ReferralEditorRequest {
  mode: 'inviter' | 'invited';
  person: ReferralPerson;
  /** This channel's own codes (the code choice when adding someone they invited). */
  codes: ReferralCode[];
  /** Who invited `person` now (mode `inviter`), shown so the owner knows what they are changing. */
  current: ReferredBy | null;
}

export interface ReferralEditorResult {
  mode: 'inviter' | 'invited';
  message: string;
  /** The fresh referrals of the channel that was written (this channel for `inviter`, the picked person for `invited`). */
  data: Referrals;
}

/** "Their first active code": the API then uses the inviter's oldest active code. */
const FIRST_ACTIVE = '';

/**
 * Set who invited someone, by hand: pick the inviter (or the invited person) with the channel picker, pick
 * one of the inviter's codes, read the consequence, save. The picked channel's referrals are loaded once: the
 * inviter's codes (mode `inviter`), or who invited the picked person now (mode `invited`, so someone this
 * channel already invited is never re-added "by hand", which would drop their discount). A 409 (they already
 * have another inviter) shows the API's message and "Move them", which re-sends with `replace: true`.
 */
@Component({
  selector: 'app-referral-editor',
  templateUrl: './referral-editor.component.html',
  styleUrls: ['./channel-page.component.css', './referral-editor.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, ChannelPickerComponent, IconComponent, SkeletonComponent],
})
export class ReferralEditorComponent {
  private readonly api = inject(ReferralsApiService);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private pickedSub?: Subscription;
  private saveSub?: Subscription;

  readonly request = input<ReferralEditorRequest | null>(null);
  readonly done = output<ReferralEditorResult>();
  readonly closed = output<void>();

  readonly picked = signal<PickedChannel | null>(null);
  readonly choice = signal(FIRST_ACTIVE);
  /** The picked channel's referrals: their codes (mode `inviter`) or who invited them now (mode `invited`). */
  readonly pickedData = signal<Referrals | null>(null);
  readonly pickedLoading = signal(false);
  readonly pickedError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  /** The API's 409 message: they already have another inviter. */
  readonly conflict = signal<string | null>(null);
  readonly submitAttempted = signal(false);

  readonly mode = computed(() => this.request()?.mode ?? 'inviter');
  readonly personName = computed(() => this.request()?.person.login || 'this channel');

  readonly title = computed(() => {
    const request = this.request();
    if (!request) return '';
    if (request.mode === 'invited') return `Add someone ${this.personName()} invited`;
    return request.current ? `Change who invited ${this.personName()}` : `Add who invited ${this.personName()}`;
  });

  /** The two people in the sentence: who counts as invited, and by whom. */
  readonly inviterName = computed(() => (this.mode() === 'inviter' ? this.picked()?.channel ?? null : this.personName()));
  readonly invitedName = computed(() => (this.mode() === 'inviter' ? this.personName() : this.picked()?.channel ?? null));

  /** The inviter's codes in API order (oldest first); null until the picked channel has loaded. */
  private readonly sourceCodes = computed<ReferralCode[] | null>(() => {
    const data = this.pickedData();
    if (!this.picked() || !data) return null;
    return this.mode() === 'invited' ? this.request()?.codes ?? [] : data.codes;
  });
  /** Active codes first, then the ones turned off. */
  readonly codes = computed(() => {
    const codes = this.sourceCodes() ?? [];
    return [...codes.filter((code) => code.active), ...codes.filter((code) => !code.active)];
  });
  /** What "Their first active code" resolves to (the API picks the oldest active one). */
  readonly firstActive = computed(() => this.sourceCodes()?.find((code) => code.active) ?? null);

  readonly selfPick = computed(() => {
    const picked = this.picked();
    return !!picked && picked.channelID === this.request()?.person.channelID;
  });
  /** Mode `invited`: who invited the picked person now (null = nobody). */
  readonly pickedInviter = computed(() => (this.mode() === 'invited' ? this.pickedData()?.referredBy ?? null : null));
  /** Mode `invited`: the picked person already counts as invited by this channel. */
  readonly alreadyListed = computed(() => {
    const by = this.pickedInviter();
    return !!by && !!by.channelID && by.channelID === this.request()?.person.channelID;
  });

  /** Whether the inviter will earn rewards from this referral, and why not. */
  private readonly rewards = computed<{ earns: boolean; reason: string }>(() => {
    const choice = this.choice();
    if (choice === FIRST_ACTIVE) {
      return this.firstActive() ? { earns: true, reason: '' } : { earns: false, reason: 'they have no active code' };
    }
    const code = this.codes().find((item) => item.code === choice);
    return code?.active ? { earns: true, reason: '' } : { earns: false, reason: `code ${choice} is off` };
  });

  readonly consequence = computed(() => {
    const inviter = this.inviterName();
    const invited = this.invitedName();
    if (!inviter || !invited || this.selfPick() || this.alreadyListed() || this.sourceCodes() === null) return null;
    const rewards = this.rewards();
    const reward = rewards.earns
      ? `${inviter} earns rewards when ${invited} pays.`
      : `${inviter} earns nothing when ${invited} pays: ${rewards.reason}.`;
    return { text: `${invited} counts as invited by ${inviter}. They won't get the 10% discount. ${reward}`, earns: rewards.earns };
  });

  readonly canSave = computed(
    () => !!this.picked() && !this.selfPick() && !this.alreadyListed() && this.sourceCodes() !== null && !this.saving(),
  );

  readonly formatNumber = formatNumber;

  constructor() {
    effect(() => {
      const request = this.request();
      untracked(() => this.sync(request));
    });
    inject(DestroyRef).onDestroy(() => {
      this.pickedSub?.unsubscribe();
      this.saveSub?.unsubscribe();
    });
  }

  private sync(request: ReferralEditorRequest | null): void {
    const dialog = this.dialog().nativeElement;
    if (!request) {
      if (dialog.open) dialog.close();
      return;
    }
    this.pickedSub?.unsubscribe();
    this.saveSub?.unsubscribe();
    this.picked.set(null);
    this.choice.set(FIRST_ACTIVE);
    this.pickedData.set(null);
    this.pickedLoading.set(false);
    this.pickedError.set(null);
    this.saving.set(false);
    this.error.set(null);
    this.conflict.set(null);
    this.submitAttempted.set(false);
    if (!dialog.open) dialog.showModal();
    afterNextRender(() => dialog.querySelector<HTMLInputElement>('input[type="search"]')?.focus(), { injector: this.injector });
  }

  pick(channel: PickedChannel): void {
    this.picked.set(channel);
    this.choice.set(FIRST_ACTIVE);
    this.conflict.set(null);
    this.error.set(null);
    if (channel.channelID !== this.request()?.person.channelID) this.loadPicked();
  }

  repick(): void {
    this.pickedSub?.unsubscribe();
    this.picked.set(null);
    this.pickedData.set(null);
    this.pickedLoading.set(false);
    this.pickedError.set(null);
    this.conflict.set(null);
    this.error.set(null);
    afterNextRender(() => this.dialog().nativeElement.querySelector<HTMLInputElement>('input[type="search"]')?.focus(), {
      injector: this.injector,
    });
  }

  loadPicked(): void {
    const picked = this.picked();
    if (!picked) return;
    this.pickedSub?.unsubscribe();
    this.pickedLoading.set(true);
    this.pickedError.set(null);
    this.pickedData.set(null);
    this.pickedSub = this.api.get(picked.channelID).subscribe({
      next: (response) => {
        if (response.error || !response.data) this.pickedError.set(response.message || this.loadFailed(picked.channel));
        else this.pickedData.set(response.data);
        this.pickedLoading.set(false);
      },
      error: (err) => {
        this.pickedError.set(apiErrorMessage(err, this.loadFailed(picked.channel)));
        this.pickedLoading.set(false);
      },
    });
  }

  private loadFailed(name: string): string {
    return this.mode() === 'inviter' ? `Couldn't load ${name}'s codes` : `Couldn't check who invited ${name}`;
  }

  choose(code: string): void {
    this.choice.set(code);
    this.conflict.set(null);
  }

  save(replace: boolean): void {
    this.submitAttempted.set(true);
    const request = this.request();
    const picked = this.picked();
    if (!request || !picked || !this.canSave()) return;
    const choice = this.choice();
    const target = request.mode === 'inviter' ? request.person.channelID : picked.channelID;
    const body: SetReferrer = { referrer: request.mode === 'inviter' ? picked.channelID : request.person.channelID };
    if (choice !== FIRST_ACTIVE) body.code = choice;
    if (replace) body.replace = true;
    // Who the page showed as the inviter: when it changed meanwhile, the API writes nothing (409).
    body.expectedReferrer = request.mode === 'inviter' ? request.current?.userId ?? null : this.pickedData()?.referredBy?.userId ?? null;

    this.saving.set(true);
    this.error.set(null);
    this.saveSub?.unsubscribe();
    this.saveSub = this.api.setReferrer(target, body).subscribe({
      next: (response) => {
        this.saving.set(false);
        if (response.error || !response.data) {
          this.error.set(response.message || "Couldn't save. Try again.");
          return;
        }
        this.done.emit({ mode: request.mode, message: response.message, data: response.data });
      },
      error: (err: unknown) => {
        this.saving.set(false);
        if (err instanceof HttpErrorResponse && err.status === 409 && !replace) {
          this.conflict.set(apiErrorMessage(err, `${request.mode === 'inviter' ? request.person.login : picked.channel} already has another inviter.`));
          return;
        }
        this.error.set(apiErrorMessage(err, "Couldn't save. Try again."));
      },
    });
  }

  cancel(): void {
    if (!this.saving()) this.dialog().nativeElement.close();
  }

  onCancel(event: Event): void {
    if (this.saving()) event.preventDefault();
  }

  onClose(): void {
    // Chrome closes a modal on a repeated Escape even when `cancel` is prevented: keep it open until the save answers.
    if (this.saving()) {
      this.dialog().nativeElement.showModal();
      return;
    }
    this.pickedSub?.unsubscribe();
    this.closed.emit();
  }

  backdrop(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.cancel();
  }
}
