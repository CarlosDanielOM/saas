import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { ChannelApiService, type ChannelCommand } from '../../services/channel-api.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';

@Component({
  selector: 'app-channel-commands',
  templateUrl: './channel-commands.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SkeletonComponent]
})
export class ChannelCommandsComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly channelApi = inject(ChannelApiService);

  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly commands = signal<ChannelCommand[]>([]);
  readonly currentPage = signal(1);
  readonly totalPages = signal(1);
  readonly totalItems = signal(0);

  readonly channelID = computed(() => this.route.snapshot.paramMap.get('channelID') || '');

  readonly paginationInfo = computed(() => ({
    current: this.currentPage(),
    total: this.totalPages(),
    totalItems: this.totalItems()
  }));

  ngOnInit(): void {
    this.loadCommands(1);
  }

  loadCommands(page: number): void {
    const channelID = this.channelID();
    if (!channelID) {
      this.error.set('No channel ID provided');
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);

    this.channelApi.getChannelCommands(channelID, page, 25).subscribe({
      next: (response) => {
        this.commands.set(response.data.rows);
        this.currentPage.set(response.data.pagination.page);
        this.totalPages.set(response.data.pagination.totalPages);
        this.totalItems.set(response.data.pagination.total);
        this.isLoading.set(false);
      },
      error: (err) => {
        this.error.set('Failed to load commands');
        this.isLoading.set(false);
        console.error('Error loading commands:', err);
      }
    });
  }

  onPageChange(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.loadCommands(page);
  }

  formatDate(date: string | undefined): string {
    if (!date) return '-';
    return new Date(date).toLocaleDateString();
  }
}
