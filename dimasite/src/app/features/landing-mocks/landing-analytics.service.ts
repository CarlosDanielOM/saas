import { Injectable, inject } from '@angular/core';

import {
  SiteAnalyticsService,
  type LiveChannelBoardEntry
} from '../../services/site-analytics.service';

export type { LiveChannelBoardEntry };

/**
 * Thin alias for design mocks — same live production stream as the real landing.
 * Prefer SiteAnalyticsService in production features.
 */
@Injectable({ providedIn: 'root' })
export class LandingAnalyticsService {
  private readonly siteAnalytics = inject(SiteAnalyticsService);

  readonly siteStats = this.siteAnalytics.siteStats;
  readonly liveChannels = this.siteAnalytics.liveChannels;
  readonly connectionStatus = this.siteAnalytics.connectionStatus;

  constructor() {
    this.siteAnalytics.start();
  }
}
