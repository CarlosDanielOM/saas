import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  AlertCircle,
  ArrowRight,
  LayoutDashboard,
  LucideAngularModule,
  Search,
  Shield,
  Users,
  X,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';

interface ChannelOption {
  channelID: string;
  channelName: string;
}

@Component({
  selector: 'app-admin-hub-page',
  imports: [LucideAngularModule, RouterLink],
  styleUrl: './admin-hub-page.component.css',
  templateUrl: './admin-hub-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminHubPageComponent {
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly router = inject(Router);

  readonly shieldIcon = Shield;
  readonly searchIcon = Search;
  readonly clearIcon = X;
  readonly arrowIcon = ArrowRight;
  readonly dashboardIcon = LayoutDashboard;
  readonly usersIcon = Users;
  readonly alertIcon = AlertCircle;

  readonly errorMessage = signal<string | null>(null);
  readonly switchingChannelID = signal<string | null>(null);
  readonly searchQuery = signal('');

  readonly channels = computed<ChannelOption[]>(() => {
    const current = this.sessionAuth.session();
    if (!current) {
      return [];
    }

    const ownerChannelID = current.appUser.twitch_user_id;
    const merged = new Map<string, ChannelOption>();

    for (const adminChannel of current.appUser.administrating) {
      const channelID = adminChannel.channelID?.trim();
      if (!channelID || channelID === ownerChannelID) {
        continue;
      }

      merged.set(channelID, {
        channelID,
        channelName: adminChannel.channelName || channelID,
      });
    }

    return Array.from(merged.values()).sort((left, right) =>
      left.channelName.localeCompare(right.channelName, undefined, { sensitivity: 'base' }),
    );
  });

  readonly filteredChannels = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) {
      return this.channels();
    }

    return this.channels().filter((channel) => channel.channelName.toLowerCase().includes(query));
  });

  readonly ownerDashboardLink = computed(() => {
    const current = this.sessionAuth.session();
    if (!current) {
      return null;
    }

    const streamer = this.sessionAuth.toRouteStreamer(
      current.appUser.twitch_user_id,
      current.twitchUser.login,
    );

    return streamer ? ['/', streamer, 'dashboard'] : null;
  });

  readonly channelCountLabel = computed(() => {
    const count = this.channels().length;
    const key = count === 1 ? 'adminHub.panel.channelCountOne' : 'adminHub.panel.channelCountMany';
    return this.t(key).replace('{count}', String(count));
  });

  t(key: string): string {
    return this.languageService.translate(key);
  }

  channelInitial(channelName: string): string {
    const trimmed = channelName.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);
  }

  clearSearch(): void {
    this.searchQuery.set('');
  }

  async openChannel(channel: ChannelOption): Promise<void> {
    if (this.switchingChannelID()) {
      return;
    }

    this.errorMessage.set(null);
    this.switchingChannelID.set(channel.channelID);

    try {
      const allowed = await firstValueFrom(
        this.sessionAuth.checkPermission(channel.channelID, 'dashboard:view'),
      );

      if (!allowed) {
        this.errorMessage.set(this.t('adminHub.errors.noAccess'));
        return;
      }

      const streamer = this.sessionAuth.toRouteStreamer(channel.channelID, channel.channelName);
      await this.router.navigate(['/', streamer, 'dashboard']);
    } catch {
      this.errorMessage.set(this.t('adminHub.errors.failed'));
    } finally {
      this.switchingChannelID.set(null);
    }
  }
}
