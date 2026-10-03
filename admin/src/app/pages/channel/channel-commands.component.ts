import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { ChannelApiService, type ChannelCommand } from '../../services/channel-api.service';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { IconComponent } from '../../shared/icon/icon.component';

@Component({
  selector: 'app-channel-commands',
  templateUrl: './channel-commands.component.html',
  styleUrl: './channel-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SkeletonComponent, IconComponent],
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
  readonly channelName = signal<string | null>(null);
  readonly filter = signal('');

  readonly channelID = computed(() => this.route.snapshot.paramMap.get('channelID') || '');
  readonly offCount = computed(() => this.commands().filter((cmd) => !cmd.enabled).length);
  readonly visibleCommands = computed(() => {
    const term = this.filter().trim().toLowerCase();
    if (!term) return this.commands();
    return this.commands().filter((cmd) =>
      `${cmd.cmd} ${cmd.name} ${cmd.message ?? ''} ${cmd.func}`.toLowerCase().includes(term),
    );
  });

  ngOnInit(): void {
    this.loadCommands(1);
    this.channelApi.getChannel(this.channelID()).subscribe({
      next: (user) => this.channelName.set(user?.channel ?? null),
      error: () => this.channelName.set(null),
    });
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

    this.channelApi.getChannelCommands(channelID, page, 100).subscribe({
      next: (response) => {
        this.commands.set(response.data.rows);
        this.currentPage.set(response.data.pagination.page);
        this.totalPages.set(response.data.pagination.totalPages);
        this.totalItems.set(response.data.pagination.total);
        this.isLoading.set(false);
      },
      error: (err) => {
        this.error.set("Couldn't load commands");
        this.isLoading.set(false);
        console.error('Error loading commands:', err);
      },
    });
  }

  onPageChange(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.filter.set('');
    this.loadCommands(page);
  }

  cooldownLabel(seconds: number): string {
    if (!seconds) return 'No cooldown';
    if (seconds < 60) return `${seconds}s cooldown`;
    const minutes = Math.round(seconds / 6) / 10;
    return `${minutes}m cooldown`;
  }
}
