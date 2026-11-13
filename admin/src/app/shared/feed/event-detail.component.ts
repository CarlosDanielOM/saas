import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { apiErrorMessage } from '../../services/api-util';
import { EventDetail, FeedApiService } from '../../services/feed-api.service';
import { clockTime, dateTime, formatDuration, plural, relativeTime } from '../format';
import { IconComponent } from '../icon/icon.component';
import { SkeletonComponent } from '../skeleton/skeleton.component';
import { reasonText, twitchEventLabel } from './feed-format';

type Delivery = EventDetail['deliveries'][number];
type Tone = 'ok' | 'muted' | 'warn' | 'danger' | 'accent';

/** Plain names for the parts of the bot that handle journaled events. Unknown ids are shown as they are. */
const CONSUMER: Record<string, string> = {
  'chat-announcements-v1': 'Chat alert',
  'stream-timeline-v1': 'Stream timeline',
  'channel-goals-v1': 'Goals',
  'widget-actions-v1': 'Overlay widgets',
  'overlay-interactions-v1': 'Overlay interactions',
  'follow-defense-v1': 'Follow protection',
  'stream-analytics-v1': 'Stream stats',
  'stream-operations-v1': 'Stream start/end tasks',
  'raid-history-v1': 'Raid history',
  'account-health-notifications-v1': 'Account health notices',
  'goal-custom-contributions-v1': 'Custom goals',
};
const consumerName = (id: string): string => CONSUMER[id] ?? (id.startsWith('polar-') ? 'Billing' : id);

/** "It is on cooldown" from "it is on cooldown". */
const sentence = (text: string | null): string | null => (text ? text[0].toUpperCase() + text.slice(1) : null);

const STATUS: Record<Delivery['status'], { label: string; tone: Tone }> = {
  succeeded: { label: 'Done', tone: 'ok' },
  skipped: { label: 'Skipped', tone: 'muted' },
  pending: { label: 'Waiting', tone: 'warn' },
  processing: { label: 'Running', tone: 'accent' },
  retry: { label: 'Still retrying', tone: 'warn' },
  dead: { label: 'Gave up', tone: 'danger' },
};
const STEP: Record<string, { label: string; tone: Tone; icon: string }> = {
  completed: { label: 'Done', tone: 'ok', icon: 'check' },
  skipped: { label: 'Skipped', tone: 'muted', icon: 'more' },
  failed: { label: 'Failed', tone: 'danger', icon: 'x' },
};

/**
 * One Twitch event and what each part of the bot did with it, as a bottom sheet (centred from 640px).
 * The page owns the `?event=` param: this asks to close through `closed` and gives focus back on the way out.
 */
@Component({
  selector: 'app-event-detail',
  templateUrl: './event-detail.component.html',
  styleUrl: './event-detail.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RouterLink, SkeletonComponent],
})
export class EventDetailComponent implements AfterViewInit, OnDestroy {
  private readonly api = inject(FeedApiService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly returnFocus = document.activeElement as HTMLElement | null;
  private request?: Subscription;
  private copyTimer?: ReturnType<typeof setTimeout>;

  readonly eventKey = input.required<string>();
  readonly closed = output<void>();

  readonly detail = signal<EventDetail | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly copied = signal(false);

  readonly title = computed(() => {
    const event = this.detail();
    return event ? twitchEventLabel(event.twitchType ?? event.type) : 'Twitch event';
  });
  readonly when = computed(() => {
    const event = this.detail();
    if (!event) return null;
    const late = Date.parse(event.journaledAt) - Date.parse(event.occurredAt);
    return {
      at: dateTime(event.occurredAt),
      ago: relativeTime(event.occurredAt),
      // Twitch can deliver late; only worth saying when it was more than a few seconds.
      late: Number.isFinite(late) && late > 5000 ? formatDuration(late) : null,
    };
  });
  readonly deliveries = computed(() =>
    (this.detail()?.deliveries ?? []).map((delivery) => ({
      ...delivery,
      name: consumerName(delivery.consumer),
      status: STATUS[delivery.status] ?? { label: delivery.status, tone: 'muted' as Tone },
      why: sentence(reasonText(delivery.reason)),
      meta: [
        delivery.attempts > 1 ? plural(delivery.attempts, 'attempt') : null,
        delivery.durationMs !== null ? formatDuration(delivery.durationMs) : null,
        delivery.completedAt ? clockTime(delivery.completedAt) : null,
      ].filter(Boolean).join(' · '),
    })),
  );
  /** The sheet's answer line: how the bot handled it, in one sentence. */
  readonly verdict = computed(() => {
    const list = this.detail()?.deliveries ?? [];
    if (!list.length) return { tone: 'muted' as Tone, icon: 'info', text: 'No part of the bot handles this kind of event.' };
    const count = (status: Delivery['status'][]) => list.filter((item) => status.includes(item.status)).length;
    const dead = count(['dead']);
    const waiting = count(['pending', 'processing', 'retry']);
    const skipped = count(['skipped']);
    const done = count(['succeeded']);
    const parts = [
      done ? `${done} done` : null,
      skipped ? `${skipped} skipped` : null,
      waiting ? `${waiting} still running` : null,
      dead ? `${dead} gave up` : null,
    ].filter(Boolean);
    return {
      tone: (dead ? 'danger' : waiting ? 'warn' : 'ok') as Tone,
      icon: dead || waiting ? 'alert' : 'ok',
      text: `${plural(list.length, 'part')} of the bot handled it: ${parts.join(', ')}.`,
    };
  });
  readonly steps = computed(() =>
    (this.detail()?.steps ?? []).map((step) => ({
      ...step,
      name: step.step.replace(/[_-]+/g, ' ').replace(/^./, (first) => first.toUpperCase()),
      state: STEP[step.status] ?? { label: step.status, tone: 'muted' as Tone, icon: 'info' },
      why: sentence(reasonText(step.reason)),
    })),
  );
  readonly payload = computed(() => {
    const event = this.detail();
    return event ? JSON.stringify(event.payload ?? {}, null, 2) : '';
  });
  readonly actorQuery = computed(() => {
    const actor = this.detail()?.actor;
    if (actor?.id) return { actor: actor.id };
    if (actor?.login) return { actorLogin: actor.login };
    return null;
  });

  constructor() {
    // Back/forward can swap one event for another while the sheet stays open.
    effect(() => {
      this.eventKey();
      untracked(() => this.load());
    });
  }

  ngAfterViewInit(): void {
    this.dialog().nativeElement.showModal();
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
    clearTimeout(this.copyTimer);
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
  }

  load(): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.request = this.api.event(this.eventKey()).subscribe({
      next: ({ data }) => {
        this.detail.set(data);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.error.set(
          error instanceof HttpErrorResponse && error.status === 404
            ? 'This event is not in the record. Twitch events are kept for a limited time.'
            : apiErrorMessage(error, "The event didn't load."),
        );
      },
    });
  }

  close(): void {
    const dialog = this.dialog().nativeElement;
    if (dialog.open) dialog.close();
    this.closed.emit();
  }

  onBackdrop(event: MouseEvent): void {
    const dialog = this.dialog().nativeElement;
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.close();
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.payload());
      this.copied.set(true);
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.copied.set(false), 2500);
    } catch {
      this.copied.set(false);
    }
  }
}
