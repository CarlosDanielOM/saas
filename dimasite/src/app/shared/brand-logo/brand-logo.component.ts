import { NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-brand-logo',
  imports: [NgOptimizedImage],
  styleUrl: './brand-logo.component.css',
  template: `
    <span class="lf-brand-logo" [class.lf-brand-logo--compact]="compact()">
      @if (pulse()) {
        <span class="lf-brand-logo__live" aria-hidden="true"></span>
      }
      <img
        ngSrc="/assets/brand/mark-on-light.png"
        width="28"
        height="30"
        alt=""
        priority
        class="lf-brand-logo__mark lf-brand-logo__on-light"
      />
      <img
        ngSrc="/assets/brand/mark-on-dark.png"
        width="28"
        height="30"
        alt=""
        priority
        class="lf-brand-logo__mark lf-brand-logo__on-dark"
      />
      @if (!compact()) {
        <img
          ngSrc="/assets/brand/wordmark-on-light.png"
          width="94"
          height="28"
          alt=""
          priority
          class="lf-brand-logo__word lf-brand-logo__on-light"
        />
        <img
          ngSrc="/assets/brand/wordmark-on-dark.png"
          width="94"
          height="28"
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
  pulse = input(true);
  compact = input(false);
}
