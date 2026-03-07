import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';

interface ChannelOption {
  channelID: string;
  channelName: string;
  kind: 'owner' | 'admin';
}

@Component({
  selector: 'app-admin-hub-page',
  templateUrl: './admin-hub-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminHubPageComponent {
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly router = inject(Router);

  readonly errorMessage = signal<string | null>(null);
  readonly switchingChannelID = signal<string | null>(null);

  readonly channels = computed<ChannelOption[]>(() => {
    const current = this.sessionAuth.session();
    if (!current) {
      return [];
    }

    const ownerChannelID = current.appUser.twitch_user_id;
    const ownerChannelName = current.twitchUser.display_name || current.twitchUser.login || ownerChannelID;

    const merged = new Map<string, ChannelOption>();
    merged.set(ownerChannelID, {
      channelID: ownerChannelID,
      channelName: ownerChannelName,
      kind: 'owner'
    });

    for (const adminChannel of current.appUser.administrating) {
      if (!adminChannel.channelID) {
        continue;
      }

      merged.set(adminChannel.channelID, {
        channelID: adminChannel.channelID,
        channelName: adminChannel.channelName || adminChannel.channelID,
        kind: adminChannel.channelID === ownerChannelID ? 'owner' : 'admin'
      });
    }

    return Array.from(merged.values());
  });

  t(key: string): string {
    return this.languageService.translate(key);
  }

  async openChannel(channel: ChannelOption): Promise<void> {
    if (this.switchingChannelID()) {
      return;
    }

    this.errorMessage.set(null);
    this.switchingChannelID.set(channel.channelID);

    try {
      const allowed = await firstValueFrom(
        this.sessionAuth.checkPermission(channel.channelID, 'dashboard:view')
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
