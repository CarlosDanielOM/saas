import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import {
  ReferralsApiService,
  type ReferralSource,
  type Referrals,
  type ReferredPerson,
} from '../../services/referrals-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { AvatarComponent } from '../../shared/avatar/avatar.component';
import { ConfirmModalComponent } from '../../shared/confirm-modal/confirm-modal.component';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { ToastService } from '../../shared/toast/toast.service';
import { creditsToUSD, formatCredits, formatNumber, formatUSD, plural } from '../../shared/format';
import { ChannelWorkspaceService } from './channel-workspace.service';
import { ReferralEditorComponent, type ReferralEditorRequest, type ReferralEditorResult } from './referral-editor.component';

/** What a referral-row reader needs: who, where to open them, and two facts in plain words. */
interface InviterView {
  /** The inviter's login, or null when their account was deleted. */
  login: string | null;
  /** Their name inside a sentence. */
  name: string;
  link: string[] | null;
  code: string | null;
  how: string;
  discount: { ok: boolean; text: string };
  rewards: { ok: boolean; text: string };
}

type Removal = { kind: 'inviter' } | { kind: 'invited'; row: ReferredPerson };

const DELETED = 'a deleted account';

/** "4,500 credits ($0.045)": credits always with their dollar value (100,000 credits = 1 USD). */
export function creditsWithValue(credits: number): string {
  return `${formatCredits(credits)} (${formatUSD(creditsToUSD(credits))})`;
}

/** "Nov 14" (with the year when it isn't this year). */
function day(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/**
 * Channel workspace → Referrals: who invited this person, who they invited, and their codes. The owner can
 * set, move or remove an inviter by hand (always marked "added by you": no 10% first-subscription discount,
 * the inviter still earns rewards while the code is one of their active codes) and add or remove people this
 * person invited. Rewards already paid never move.
 */
@Component({
  selector: 'app-channel-referrals',
  templateUrl: './channel-referrals.component.html',
  styleUrls: ['./channel-page.component.css', './channel-referrals.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AvatarComponent, ConfirmModalComponent, IconComponent, SkeletonComponent, ReferralEditorComponent],
})
export class ChannelReferralsComponent {
  private readonly api = inject(ReferralsApiService);
  private readonly toast = inject(ToastService);
  readonly ws = inject(ChannelWorkspaceService);
  private request?: Subscription;
  private moreRequest?: Subscription;
  private removeRequest?: Subscription;

  readonly channelID = this.ws.channelID;
  readonly data = signal<Referrals | null>(null);
  /** Every loaded page of the people they invited. */
  readonly rows = signal<ReferredPerson[]>([]);
  readonly next = signal<string | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly moreLoading = signal(false);
  readonly moreError = signal<string | null>(null);

  readonly editor = signal<ReferralEditorRequest | null>(null);
  readonly removing = signal<Removal | null>(null);
  readonly removeBusy = signal(false);
  readonly removeError = signal<string | null>(null);

  readonly formatNumber = formatNumber;
  readonly creditsWithValue = creditsWithValue;
  readonly day = day;

  readonly login = computed(() => this.data()?.person.login || this.ws.name() || 'this channel');

  /** The page's answer in one line. */
  readonly answer = computed(() => {
    const data = this.data();
    if (!data) return '';
    const by = data.referredBy;
    const parts = [by ? `Invited by ${by.login ?? DELETED}${by.code ? ` (code ${by.code})` : ''}` : 'Nobody invited them'];
    if (data.referredTotal > 0) {
      parts.push(`invited ${plural(data.referredTotal, 'person', 'people')}`);
      parts.push(data.creditsEarnedTotal > 0 ? `earned ${creditsWithValue(data.creditsEarnedTotal)}` : 'earned nothing yet');
    } else {
      parts.push("they haven't invited anyone");
    }
    return parts.join(' · ');
  });

  readonly inviter = computed<InviterView | null>(() => {
    const by = this.data()?.referredBy;
    if (!by) return null;
    const name = by.login ?? DELETED;
    const how =
      by.source === 'code' ? 'Signed up with their link' : by.source === 'manual' ? (by.setAt ? `Added by you on ${day(by.setAt)}` : 'Added by you') : 'Old record';
    const discount = by.discount
      ? { ok: true, text: 'Gets the 10% discount on a first subscription (if they never subscribed before)' }
      : { ok: false, text: by.source === 'manual' ? 'No 10% discount (added by you)' : 'No 10% discount (no code on record)' };
    let rewards: InviterView['rewards'];
    if (!by.login) rewards = { ok: false, text: "Nobody earns rewards from them: the inviter's account was deleted" };
    else if (by.rewardsReferrer) rewards = { ok: true, text: `${name} earns referral rewards from them` };
    else if (!by.code) rewards = { ok: false, text: `${name} earns nothing from them: no code on this referral` };
    else rewards = { ok: false, text: `${name} earns nothing from them: code ${by.code} isn't active` };
    return { login: by.login, name, link: by.channelID ? ['/channels', by.channelID, 'referrals'] : null, code: by.code, how, discount, rewards };
  });

  readonly activeCodes = computed(() => this.data()?.codes.filter((code) => code.active).length ?? 0);

  readonly removeTitle = computed(() => {
    const removal = this.removing();
    if (!removal) return '';
    return removal.kind === 'inviter' ? 'Remove who invited them?' : `Remove ${removal.row.login} from ${this.login()}'s invites?`;
  });
  readonly removeMessage = computed(() => {
    const removal = this.removing();
    if (!removal) return '';
    const inviter = removal.kind === 'inviter' ? this.inviter()?.name ?? DELETED : this.login();
    const invited = removal.kind === 'inviter' ? this.login() : removal.row.login;
    return `Remove ${inviter} as the person who invited ${invited}? Rewards already paid stay; future payments won't reward ${inviter}.`;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.request?.unsubscribe();
      this.moreRequest?.unsubscribe();
      this.removeRequest?.unsubscribe();
    });
    this.load();
  }

  /** Loads the first page; `quiet` keeps what's on screen while it refreshes (after a change). */
  load(quiet = false): void {
    const channelID = this.channelID();
    if (!channelID) return;
    this.request?.unsubscribe();
    this.moreRequest?.unsubscribe();
    this.moreLoading.set(false);
    this.moreError.set(null);
    if (!quiet) {
      this.loading.set(true);
      this.error.set(null);
    }
    this.request = this.api.get(channelID).subscribe({
      next: (response) => {
        if (response.error || !response.data) {
          if (!quiet) this.error.set(response.message || "Couldn't load referrals");
        } else {
          this.show(response.data);
        }
        this.loading.set(false);
      },
      error: (err) => {
        if (quiet) this.toast.error(apiErrorMessage(err, "Couldn't refresh referrals"));
        else this.error.set(apiErrorMessage(err, "Couldn't load referrals"));
        this.loading.set(false);
      },
    });
  }

  private show(data: Referrals): void {
    this.data.set(data);
    this.rows.set(data.referred);
    this.next.set(data.next);
  }

  loadMore(): void {
    const cursor = this.next();
    if (!cursor || this.moreLoading()) return;
    this.moreLoading.set(true);
    this.moreError.set(null);
    this.moreRequest = this.api.get(this.channelID(), cursor).subscribe({
      next: (response) => {
        this.moreLoading.set(false);
        if (response.error || !response.data) {
          this.moreError.set(response.message || "Couldn't load more");
          return;
        }
        const seen = new Set(this.rows().map((row) => row.userId));
        this.rows.update((rows) => [...rows, ...response.data.referred.filter((row) => !seen.has(row.userId))]);
        this.next.set(response.data.next);
      },
      error: (err) => {
        this.moreLoading.set(false);
        this.moreError.set(apiErrorMessage(err, "Couldn't load more"));
      },
    });
  }

  how(source: ReferralSource): string {
    return source === 'code' ? 'used their link' : source === 'manual' ? 'added by you' : 'old record';
  }

  planLabel(plan: string): string {
    return plan === 'pro' ? 'Pro' : plan === 'premium' ? 'Premium' : 'Free';
  }

  openInviter(): void {
    const data = this.data();
    if (!data) return;
    this.editor.set({ mode: 'inviter', person: data.person, codes: data.codes, current: data.referredBy });
  }

  openInvited(): void {
    const data = this.data();
    if (!data) return;
    this.editor.set({ mode: 'invited', person: data.person, codes: data.codes, current: null });
  }

  saved(result: ReferralEditorResult): void {
    this.editor.set(null);
    this.toast.success(result.message || 'Saved');
    // An inviter change answers with this channel's fresh referrals; adding someone they invited answers with
    // that person's, so this channel's list is asked again.
    if (result.mode === 'inviter') this.show(result.data);
    else this.load(true);
  }

  askRemoveInviter(): void {
    this.removeError.set(null);
    this.removing.set({ kind: 'inviter' });
  }

  askRemoveInvited(row: ReferredPerson): void {
    this.removeError.set(null);
    this.removing.set({ kind: 'invited', row });
  }

  cancelRemove(): void {
    if (this.removeBusy()) return;
    this.removing.set(null);
  }

  confirmRemove(): void {
    const removal = this.removing();
    if (!removal || this.removeBusy()) return;
    const target = removal.kind === 'inviter' ? this.channelID() : removal.row.channelID;
    if (!target) return;
    const inviter = removal.kind === 'inviter' ? this.inviter()?.name ?? DELETED : this.login();
    const invited = removal.kind === 'inviter' ? this.login() : removal.row.login;
    this.removeBusy.set(true);
    this.removeError.set(null);
    // Who the page showed as the inviter: the API removes nothing if that changed meanwhile (409).
    const expectedReferrer = removal.kind === 'inviter' ? this.data()?.referredBy?.userId ?? null : this.data()?.person.userId ?? null;
    this.removeRequest = this.api.setReferrer(target, { referrer: null, expectedReferrer }).subscribe({
      next: (response) => {
        this.removeBusy.set(false);
        if (response.error || !response.data) {
          this.removeError.set(response.message || "Couldn't remove it. Try again.");
          return;
        }
        this.removing.set(null);
        this.toast.success(`${inviter.charAt(0).toUpperCase()}${inviter.slice(1)} no longer counts as the person who invited ${invited}`);
        if (removal.kind === 'inviter') this.show(response.data);
        else this.load(true);
      },
      error: (err) => {
        this.removeBusy.set(false);
        this.removeError.set(apiErrorMessage(err, "Couldn't remove it. Try again."));
      },
    });
  }
}
