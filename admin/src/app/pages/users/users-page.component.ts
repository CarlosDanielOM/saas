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
import { RouterLink } from '@angular/router';

import {
  AdminApiService,
  type AdminUserRow,
  type AdminUsersSummary,
} from '../../services/admin-api.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { ToastService } from '../../shared/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/confirm-modal/confirm-modal.component';

@Component({
  selector: 'app-users-page',
  templateUrl: './users-page.component.html',
  styleUrl: './users-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, FormsModule, SkeletonComponent, RouterLink, ConfirmModalComponent],
})
export class UsersPageComponent implements OnInit, OnDestroy {
  private readonly adminApi = inject(AdminApiService);
  private readonly toast = inject(ToastService);

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

  // Stats
  readonly stats = computed(() => {
    const s = this.summary();
    if (!s) return null;
    return [
      { label: 'Total Users', value: s.totalChannels, icon: 'users' },
      { label: 'Live Now', value: s.liveChannels, icon: 'live' },
      { label: 'Active Bots', value: s.activeBots, icon: 'active' },
      { label: 'Live Viewers', value: s.liveViewers, icon: 'viewers' },
    ];
  });

  ngOnInit(): void {
    this.loadPage(1);
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
          this.error.set('Could not load users. Your search and sort are kept — try again.');
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
    if (!row.reminder_sent_at) return '-';
    return this.formatDate(row.reminder_sent_at as any);
  }

  formatNumber(value: number): string {
    if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
    return value.toLocaleString();
  }

  formatDate(date: Date | undefined): string {
    if (!date) return '-';
    return new Date(date).toLocaleDateString();
  }
}
