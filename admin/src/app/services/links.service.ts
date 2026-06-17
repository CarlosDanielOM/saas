import { Injectable } from '@angular/core';

import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class LinksService {
  getApiUrl(): string {
    return environment.DIMA_API;
  }

  /**
   * Build Twitch OAuth URL for admin login.
   * State format: admin-{returnUrl} - tells dimasite login page to redirect back to admin
   */
  getTwitchAuthUrl(state?: string): string {
    const redirectUri = encodeURIComponent(`${this.getBaseUrl()}/login`);
    const scope = encodeURIComponent('user:read:email');
    // State format: admin-https://admin.domdimabot.com
    const returnTo = this.getBaseUrl();
    const requestState = encodeURIComponent(state || `admin-${returnTo}`);

    return `https://id.twitch.tv/oauth2/authorize?response_type=code&force_verify=false&client_id=${environment.CLIENT_ID}&redirect_uri=${redirectUri}&scope=${scope}&state=${requestState}`;
  }

  private getBaseUrl(): string {
    return window.location.hostname === 'localhost' ? 'http://localhost:4200' : 'https://admin.domdimabot.com';
  }
}