import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AdminApiService, type AdminUserRow, type AdminUsersSummary } from '../../services/admin-api.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { ToastService } from '../../shared/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/confirm-modal/confirm-modal.component';

@Component({
  selector: 'app-users-page',
  templateUrl: './users-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, SkeletonComponent, RouterLink, ConfirmModalComponent]
})
export class UsersPageComponent implements OnInit {
  private readonly adminApi = inject(AdminApiService);
  private readonly toast = inject(ToastService);

  // Cache state
  private pagesCache = new Map<number, AdminUserRow[]>();
  private loadedPages = new Set<number>();
  private readonly cacheVersion = signal(0); // Increment to trigger displayedUsers recalculation

  // Pagination state
  readonly currentPage = signal(1);
  readonly totalPages = signal(1);
  readonly totalUsers = signal(0);

  // Search state
  readonly searchInput = signal('');          // What user is typing
  readonly activeSearchQuery = signal('');    // What user pressed enter on
  readonly searchMode = signal<'cache' | 'api'>('cache');
  readonly searchResults = signal<AdminUserRow[]>([]);

  // Sort state
  readonly sortBy = signal('created_at');
  readonly sortOrder = signal<'asc' | 'desc'>('desc');

  // Loading states
  readonly isLoading = signal(false);
  readonly isSearching = signal(false);
  readonly error = signal<string | null>(null);

  // Data
  readonly summary = signal<AdminUsersSummary | null>(null);

  // Reminder modal state (for sending real production reminder emails)
  readonly showReminderModal = signal(false);
  readonly reminderTarget = signal<AdminUserRow | null>(null);
  readonly isSendingReminder = signal(false);

  // Computed: all users to display (after sorting/filtering)
  // Depends on cacheVersion to recalculate when cache is updated
  readonly displayedUsers = computed(() => {
    this.cacheVersion(); // Dependency for reactivity
    // When searching, show search results; otherwise show all cached users
    const users = this.searchInput()
      ? this.searchResults()
      : this.getAllCachedUsers();

    return this.sortUsers(users);
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

  loadPage(page: number): void {
    // Check cache first
    if (this.loadedPages.has(page)) {
      this.currentPage.set(page);
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);

    this.adminApi.getUsers({ page, limit: 100 }).subscribe({
      next: (response) => {
        this.pagesCache.set(page, response.data.rows);
        this.loadedPages.add(page);
        this.summary.set(response.data.summary);
        this.totalPages.set(response.data.pagination.totalPages);
        this.totalUsers.set(response.data.pagination.total);
        this.currentPage.set(page);
        this.isLoading.set(false);
        this.cacheVersion.update(v => v + 1); // Trigger displayedUsers recalculation
      },
      error: (err) => {
        this.error.set('Failed to load users');
        this.isLoading.set(false);
        console.error('Error loading users:', err);
      }
    });
  }

  onSearchInput(value: string): void {
    this.searchInput.set(value);

    // If there's input, filter from cache immediately
    if (value.trim()) {
      this.filterFromCache(value);
    } else {
      this.searchResults.set([]);
      this.searchMode.set('cache');
    }
  }

  onSearchSubmit(): void {
    const query = this.searchInput().trim();
    if (!query) return;

    this.activeSearchQuery.set(query);
    this.isSearching.set(true);

    // If not in cache, make API call
    const allCachedUsers = this.getAllCachedUsers();
    const found = allCachedUsers.find(u =>
      u.channel.toLowerCase().includes(query.toLowerCase()) ||
      u.email?.toLowerCase().includes(query.toLowerCase()) ||
      u.channelID.toLowerCase().includes(query.toLowerCase())
    );

    if (found) {
      // Found in cache - no need for API
      this.searchResults.set([found]);
      this.searchMode.set('cache');
      this.isSearching.set(false);
    } else {
      // Not in cache - API call
      this.adminApi.getUsers({ page: 1, limit: 100, search: query }).subscribe({
        next: (response) => {
          if (response.data.rows.length > 0) {
            // Cache this page
            this.pagesCache.set(1, response.data.rows);
            this.loadedPages.add(1);
          }
          this.searchResults.set(response.data.rows);
          this.searchMode.set('api');
          this.isSearching.set(false);
        },
        error: () => {
          this.searchResults.set([]);
          this.searchMode.set('api');
          this.isSearching.set(false);
        }
      });
    }
  }

  onClearSearch(): void {
    this.searchInput.set('');
    this.activeSearchQuery.set('');
    this.searchResults.set([]);
    this.searchMode.set('cache');
  }

  onSort(column: string): void {
    if (this.sortBy() === column) {
      this.sortOrder.update(order => order === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortBy.set(column);
      this.sortOrder.set('asc');
    }
  }

  onPageChange(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.loadPage(page);
  }

  onRefresh(): void {
    // Clear cache
    this.pagesCache.clear();
    this.loadedPages.clear();
    this.searchInput.set('');
    this.activeSearchQuery.set('');
    this.searchResults.set([]);
    this.searchMode.set('cache');

    // Reload current page
    this.loadPage(this.currentPage());
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
        this.pagesCache.delete(current);
        this.loadedPages.delete(current);
        this.loadPage(current);
      },
      error: (err) => {
        this.isSendingReminder.set(false);
        const message = err?.error?.message || 'Failed to send reminder';
        this.toast.error(message);
      }
    });
  }

  getReminderLabel(row: AdminUserRow): string {
    if (!row.reminder_sent_at) return '-';
    return this.formatDate(row.reminder_sent_at as any);
  }

  canSendReminder(row: AdminUserRow): boolean {
    // Always allow sending; modal will show a warning when user is already active
    return true;
  }

  getSortIcon(column: string): string {
    if (this.sortBy() !== column) return '↕';
    return this.sortOrder() === 'asc' ? '↑' : '↓';
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

  private getCurrentPageUsers(): AdminUserRow[] {
    return this.pagesCache.get(this.currentPage()) || [];
  }

  private getAllCachedUsers(): AdminUserRow[] {
    const all: AdminUserRow[] = [];
    this.pagesCache.forEach(users => all.push(...users));
    return all;
  }

  private filterFromCache(query: string): void {
    const allUsers = this.getAllCachedUsers();
    const lowerQuery = query.toLowerCase();

    const filtered = allUsers.filter(u =>
      u.channel.toLowerCase().includes(lowerQuery) ||
      u.email?.toLowerCase().includes(lowerQuery) ||
      u.channelID.toLowerCase().includes(lowerQuery)
    );

    this.searchResults.set(filtered);
    this.searchMode.set('cache');
  }

  private sortUsers(users: AdminUserRow[]): AdminUserRow[] {
    const column = this.sortBy();
    const order = this.sortOrder();

    return [...users].sort((a, b) => {
      let aVal: string | number = 0;
      let bVal: string | number = 0;

      switch (column) {
        case 'channel':
          aVal = a.channel.toLowerCase();
          bVal = b.channel.toLowerCase();
          break;
        case 'email':
          aVal = (a.email || '').toLowerCase();
          bVal = (b.email || '').toLowerCase();
          break;
        case 'plan_tier':
          aVal = a.plan_tier;
          bVal = b.plan_tier;
          break;
        case 'actived':
          aVal = a.actived ? 1 : 0;
          bVal = b.actived ? 1 : 0;
          break;
        case 'isLive':
          aVal = a.isLive ? 1 : 0;
          bVal = b.isLive ? 1 : 0;
          break;
        case 'liveViewers':
          aVal = a.liveViewers;
          bVal = b.liveViewers;
          break;
        case 'commandsCount':
          aVal = a.commandsCount;
          bVal = b.commandsCount;
          break;
        case 'has_permissions':
          aVal = (a.has_permissions && a.up_to_date_permissions) ? 1 : 0;
          bVal = (b.has_permissions && b.up_to_date_permissions) ? 1 : 0;
          break;
        case 'created_at':
          aVal = a.created_at ? new Date(a.created_at).getTime() : 0;
          bVal = b.created_at ? new Date(b.created_at).getTime() : 0;
          break;
        default:
          return 0;
      }

      if (aVal === bVal) return 0;

      const comparison = aVal < bVal ? -1 : 1;
      return order === 'asc' ? comparison : -comparison;
    });
  }
}