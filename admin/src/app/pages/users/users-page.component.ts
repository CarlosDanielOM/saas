import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { IconComponent } from '../../shared/icon/icon.component';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import {
  AdminApiService,
  type AdminUserRow,
  type AdminUsersSummary,
} from '../../services/admin-api.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { ToastService } from '../../shared/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/confirm-modal/confirm-modal.component';
import { AvatarComponent } from '../../shared/avatar/avatar.component';

const SORTS = [
  'created_at',
  'channel',
  'plan_tier',
  'actived',
  'isLive',
  'liveViewers',
  'commandsCount',
  'has_permissions',
];

@Component({
  selector: 'app-users-page',
  templateUrl: './users-page.component.html',
  styleUrl: './users-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IconComponent,
    FormsModule,
    SkeletonComponent,
    RouterLink,
    ConfirmModalComponent,
    AvatarComponent,
  ],
})
export class UsersPageComponent implements OnInit, OnDestroy {
  private readonly adminApi = inject(AdminApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly currentPage = signal(1);
  readonly totalPages = signal(1);
  readonly totalUsers = signal(0);
  readonly searchInput = signal('');
  readonly sortBy = signal('created_at');
  readonly sortOrder = signal<'asc' | 'desc'>('desc');
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly summary = signal<AdminUsersSummary | null>(null);
  readonly displayedUsers = signal<AdminUserRow[]>([]);
  readonly showReminderModal = signal(false);
  readonly reminderTarget = signal<AdminUserRow | null>(null);
  readonly isSendingReminder = signal(false);
  private request?: Subscription;
  private requestId = 0;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private requestedPage = 1;

  readonly orderOptions = computed(() => {
    if (['channel', 'plan_tier'].includes(this.sortBy())) return { asc: 'A to Z', desc: 'Z to A' };
    if (this.sortBy() === 'created_at') return { asc: 'Oldest first', desc: 'Newest first' };
    if (this.sortBy() === 'isLive') return { asc: 'Offline first', desc: 'Live first' };
    if (this.sortBy() === 'actived') return { asc: 'Inactive first', desc: 'Active first' };
    if (this.sortBy() === 'has_permissions')
      return { asc: 'Needs attention first', desc: 'Up to date first' };
    return { asc: 'Lowest first', desc: 'Highest first' };
  });

  /** Header chips double as shortcuts: each one sorts the matching users to the top. */
  readonly quickSorts = computed(() => {
    const s = this.summary();
    if (!s) return [];
    return [
      { key: 'live', label: `${this.formatNumber(s.liveChannels)} live`, sortBy: 'isLive', order: 'desc' as const, tone: s.liveChannels ? 'live' : '' },
      { key: 'bots', label: `${this.formatNumber(s.inactiveBots ?? 0)} bots off`, sortBy: 'actived', order: 'asc' as const, tone: s.inactiveBots ? 'warn' : '' },
      { key: 'perms', label: `${this.formatNumber(s.permissionsNeedUpdate ?? 0)} need Twitch access`, sortBy: 'has_permissions', order: 'asc' as const, tone: s.permissionsNeedUpdate ? 'warn' : '' },
    ];
  });
  readonly sortLabel = computed(() => {
    const labels: Record<string, string> = {
      created_at: 'joined date',
      channel: 'name',
      plan_tier: 'plan',
      actived: 'bot status',
      isLive: 'live now',
      liveViewers: 'viewers',
      commandsCount: 'commands',
      has_permissions: 'Twitch access',
    };
    return `${labels[this.sortBy()] ?? this.sortBy()} · ${this.orderOptions()[this.sortOrder()].toLowerCase()}`;
  });

  ngOnInit(): void {
    // Links from the overview (and coming back from a channel) restore search and order.
    const query = this.route.snapshot.queryParamMap;
    const sort = query.get('sort');
    if (sort && SORTS.includes(sort)) {
      this.sortBy.set(sort);
      this.sortOrder.set(
        query.get('order') === 'asc' || query.get('order') === 'desc'
          ? (query.get('order') as 'asc' | 'desc')
          : ['channel', 'plan_tier'].includes(sort)
            ? 'asc'
            : 'desc',
      );
    }
    this.searchInput.set(query.get('q') ?? '');
    const page = Number(query.get('page'));
    this.loadPage(Number.isInteger(page) && page > 1 ? page : 1);
  }

  applyQuickSort(sortBy: string, order: 'asc' | 'desc'): void {
    this.sortBy.set(sortBy);
    this.sortOrder.set(order);
    this.loadPage(1);
  }

  isQuickSort(sortBy: string, order: 'asc' | 'desc'): boolean {
    return this.sortBy() === sortBy && this.sortOrder() === order;
  }

  private syncUrl(page: number): void {
    const q = this.searchInput().trim();
    void this.router.navigate([], {
      relativeTo: this.route,
      replaceUrl: true,
      queryParams: {
        q: q || null,
        sort: this.sortBy() === 'created_at' ? null : this.sortBy(),
        order: this.sortBy() === 'created_at' && this.sortOrder() === 'desc' ? null : this.sortOrder(),
        page: page > 1 ? page : null,
      },
    });
  }

  async copyId(user: AdminUserRow): Promise<void> {
    try {
      await navigator.clipboard.writeText(user.channelID);
      this.toast.success(`Copied ${user.channel}'s channel ID`);
    } catch {
      this.toast.error('Could not copy — select the ID and copy it manually');
    }
  }

  ngOnDestroy(): void {
    this.cancelPending();
  }

  private cancelPending(): void {
    clearTimeout(this.searchTimer);
    this.requestId++;
    this.request?.unsubscribe();
  }

  loadPage(page: number): void {
    this.cancelPending();
    const requestId = this.requestId;
    this.requestedPage = page;
    this.isLoading.set(true);
    this.error.set(null);
    this.displayedUsers.set([]);
    this.syncUrl(page);
    // The API ranks the entire filtered directory before taking this 100-user page.
    this.request = this.adminApi
      .getUsers({
        page,
        limit: 100,
        search: this.searchInput().trim() || undefined,
        sortBy: this.sortBy(),
        sortOrder: this.sortOrder(),
      })
      .subscribe({
        next: (response) => {
          if (requestId !== this.requestId) return;
          this.displayedUsers.set(response.data.rows);
          this.summary.set(response.data.summary);
          this.totalPages.set(response.data.pagination.totalPages);
          this.totalUsers.set(response.data.pagination.total);
          this.currentPage.set(response.data.pagination.page);
          this.isLoading.set(false);
        },
        error: () => {
          if (requestId !== this.requestId) return;
          this.error.set("Couldn't load users. Your search and sort are kept — try again.");
          this.isLoading.set(false);
        },
      });
  }

  onSearchInput(value: string): void {
    this.cancelPending();
    this.searchInput.set(value);
    this.isLoading.set(true);
    this.error.set(null);
    this.displayedUsers.set([]);
    this.searchTimer = setTimeout(() => this.loadPage(1), 300);
  }

  onSearchSubmit(): void {
    this.loadPage(1);
  }

  onClearSearch(): void {
    this.searchInput.set('');
    this.loadPage(1);
  }

  onSort(column: string): void {
    this.sortBy.set(column);
    this.sortOrder.set(['channel', 'plan_tier'].includes(column) ? 'asc' : 'desc');
    this.loadPage(1);
  }

  onSortOrder(order: 'asc' | 'desc'): void {
    this.sortOrder.set(order);
    this.loadPage(1);
  }

  onPageChange(page: number): void {
    if (page < 1 || page > this.totalPages() || this.isLoading()) return;
    this.loadPage(page);
  }

  onRefresh(): void {
    this.loadPage(this.currentPage());
  }
  onRetry(): void {
    this.loadPage(this.requestedPage);
  }

  // Reminder actions (real production activation reminder email)
  openSendReminder(user: AdminUserRow): void {
    this.reminderTarget.set(user);
    this.showReminderModal.set(true);
  }

  closeReminderModal(): void {
    if (this.isSendingReminder()) return;
    this.showReminderModal.set(false);
    this.reminderTarget.set(null);
  }

  confirmSendReminder(): void {
    const target = this.reminderTarget();
    if (!target) return;

    this.isSendingReminder.set(true);

    this.adminApi.sendReminder(target.channelID).subscribe({
      next: (res) => {
        this.isSendingReminder.set(false);
        this.showReminderModal.set(false);
        this.reminderTarget.set(null);

        const msg = res?.data?.message || `Reminder sent to ${target.channel}`;
        this.toast.success(msg);

        // Refresh current page so reminder_sent_at updates in the table
        const current = this.currentPage();
        this.loadPage(current);
      },
      error: (err) => {
        this.isSendingReminder.set(false);
        const message = err?.error?.message || 'Failed to send reminder';
        this.toast.error(message);
      },
    });
  }

  getReminderLabel(row: AdminUserRow): string {
    if (!row.reminder_sent_at) return 'Never';
    return this.formatDate(row.reminder_sent_at as Date);
  }

  planLabel(plan: string): string {
    return plan === 'pro' ? 'Pro' : plan === 'premium' ? 'Premium' : 'Free';
  }

  accessLabel(row: AdminUserRow): string {
    if (!row.has_permissions) return 'No Twitch access';
    return row.up_to_date_permissions ? 'Twitch access OK' : 'Reconnect Twitch';
  }

  formatNumber(value: number): string {
    if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
    return value.toLocaleString();
  }

  formatDate(date: Date | string | undefined): string {
    if (!date) return '—';
    return new Date(date).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
}
