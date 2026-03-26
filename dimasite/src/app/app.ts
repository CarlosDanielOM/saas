import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { AnalyticsService } from './services/analytics.service';
import { ThemeService } from './services/theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App {
  private readonly analyticsService = inject(AnalyticsService);
  private readonly themeService = inject(ThemeService);

  constructor() {
    this.analyticsService.initialize();
    void this.themeService;
  }
}
