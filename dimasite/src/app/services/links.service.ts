import { Injectable } from '@angular/core';

import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class LinksService {
  getApiUrl(): string {
    return environment.DIMA_API;
  }

  getTwitchAuthUrl(state?: string): string {
    const redirectUri = encodeURIComponent(`${this.getBaseUrl()}/login`);
    // `channel:bot` lets the bot join the streamer's chat (EventSub chat + replies with the
    // app token) without the long full-access approval. The bot only joins when they add it.
    const scope = encodeURIComponent('user:read:email channel:bot');
    const requestState = encodeURIComponent(state || 'domdimabot-login');

    return `https://id.twitch.tv/oauth2/authorize?response_type=code&force_verify=false&client_id=${environment.CLIENT_ID}&redirect_uri=${redirectUri}&scope=${scope}&state=${requestState}`;
  }

  getDiscordUrl(): string {
    return environment.DISCORD_URL;
  }

  private getBaseUrl(): string {
    return window.location.hostname === 'localhost' ? 'http://localhost:4200' : 'https://domdimabot.com';
  }
}
