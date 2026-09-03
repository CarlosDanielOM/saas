import { NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-brand-logo',
  imports: [NgOptimizedImage],
  styleUrl: './brand-logo.component.css',
  template: `
    <span
      class="lf-brand-logo"
      [class.lf-brand-logo--dark]="isDark()"
      [class.lf-brand-logo--compact]="compact()"
    >
      @if (pulse()) {
        <span class="lf-brand-logo__live" aria-hidden="true"></span>
      }
      <img
        ngSrc="/assets/brand/mark-on-light.png"
        width="36"
        height="39"
        alt=""
        priority
        class="lf-brand-logo__mark lf-brand-logo__on-light"
      />
      <img
        ngSrc="/assets/brand/mark-on-dark.png"
        width="36"
        height="39"
        alt=""
        priority
        class="lf-brand-logo__mark lf-brand-logo__on-dark"
      />
      @if (!compact()) {
        <img
          ngSrc="/assets/brand/wordmark-on-light.png"
          width="134"
          height="40"
          alt=""
          priority
          class="lf-brand-logo__word lf-brand-logo__on-light"
        />
        <img
          ngSrc="/assets/brand/wordmark-on-dark.png"
          width="134"
          height="40"
          alt=""
          priority
          class="lf-brand-logo__word lf-brand-logo__on-dark"
        />
      }
    </span>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BrandLogoComponent {
  private readonly themeService = inject(ThemeService);

  pulse = input(true);
  compact = input(false);

  protected readonly isDark = this.themeService.isDarkMode;
}
