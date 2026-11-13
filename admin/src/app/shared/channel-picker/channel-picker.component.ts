import { ChangeDetectionStrategy, Component, OnDestroy, inject, input, output, signal } from '@angular/core';
import { Subject, Subscription, catchError, debounceTime, distinctUntilChanged, of, switchMap } from 'rxjs';

import { AdminApiService, AdminUserRow } from '../../services/admin-api.service';
import { AvatarComponent } from '../avatar/avatar.component';
import { IconComponent } from '../icon/icon.component';

export interface PickedChannel {
  channelID: string;
  channel: string;
}

/**
 * "Which streamer?": type part of a channel name, pick one. Used wherever a list can be narrowed to one
 * channel. The page keeps the picked channel (usually in the URL) and shows it as a removable chip.
 */
@Component({
  selector: 'app-channel-picker',
  template: `
    <div class="lf-field picker">
      <label class="lf-label" [attr.for]="fieldId">{{ label() }}</label>
      <div class="lf-search">
        <app-icon name="search" />
        <input
          class="lf-input"
          type="search"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          [id]="fieldId"
          [placeholder]="placeholder()"
          [value]="term()"
          (input)="onInput($any($event.target).value)"
          [attr.aria-controls]="fieldId + '-results'"
        />
      </div>
      <ul class="lf-rows picker__results" [id]="fieldId + '-results'" [attr.aria-busy]="searching()">
        @for (row of results(); track row.channelID) {
          <li>
            <button type="button" class="lf-row picker__row" (click)="choose(row)">
              <app-avatar [name]="row.channel" [live]="row.isLive" [fetch]="false" />
              <span class="lf-row__main"><span class="lf-row__title">{{ row.channel }}</span></span>
              @if (row.isLive) {
                <span class="lf-chip lf-chip--live">Live</span>
              }
            </button>
          </li>
        }
      </ul>
      @if (term().length >= 2 && !searching() && !results().length) {
        <p class="lf-hint" role="status">{{ failed() ? "Couldn't search right now. Try again." : 'No streamer matches that.' }}</p>
      }
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .picker__results { margin-top: 0.4rem; }
      .picker__row { width: 100%; padding-inline: 0.5rem; border: 0; border-top: 1px solid var(--line); background: none; color: inherit; text-align: left; cursor: pointer; }
      li:first-child > .picker__row { border-top: 0; }
      .picker__row:hover, .picker__row:focus-visible { background: var(--tile-2); }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AvatarComponent],
})
export class ChannelPickerComponent implements OnDestroy {
  private static next = 0;
  private readonly api = inject(AdminApiService);
  readonly label = input('Streamer');
  readonly placeholder = input('Type a channel name');
  readonly picked = output<PickedChannel>();

  readonly fieldId = `channel-picker-${ChannelPickerComponent.next++}`;
  readonly term = signal('');
  readonly results = signal<AdminUserRow[]>([]);
  readonly searching = signal(false);
  readonly failed = signal(false);
  private readonly terms = new Subject<string>();
  private readonly subscription: Subscription;

  constructor() {
    this.subscription = this.terms
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((term) => {
          if (term.length < 2) return of(null);
          this.searching.set(true);
          this.failed.set(false);
          return this.api.getUsers({ search: term, limit: 6, sortBy: 'channel', sortOrder: 'asc' }).pipe(catchError(() => { this.failed.set(true); return of(null); }));
        }),
      )
      .subscribe((response) => {
        this.results.set(response?.data.rows ?? []);
        this.searching.set(false);
      });
  }

  onInput(value: string): void {
    const term = value.trim().toLowerCase().replace(/^@/, '');
    this.term.set(term);
    if (term.length < 2) this.results.set([]);
    this.terms.next(term);
  }

  choose(row: AdminUserRow): void {
    this.picked.emit({ channelID: row.channelID, channel: row.channel });
    this.term.set('');
    this.results.set([]);
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }
}
