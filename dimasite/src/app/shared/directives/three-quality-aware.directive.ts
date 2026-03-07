import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { ThreeQualityService } from '../../core/services/three-quality.service';

@Directive({
  selector: '[threeQualityAware]'
})
export class ThreeQualityAwareDirective {
  readonly threeQualityAware = input(true);
  readonly maxParticles = input<number | undefined>(undefined);
  readonly enableShadows = input<boolean | undefined>(undefined);
  readonly enableAntialias = input<boolean | undefined>(undefined);
  readonly enablePostProcessing = input<boolean | undefined>(undefined);

  private readonly qualityService = inject(ThreeQualityService);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    effect(() => {
      if (!this.threeQualityAware()) {
        return;
      }

      const profile = this.qualityService.getQualityProfile();
      const element = this.elementRef.nativeElement;

      element.dataset['quality'] = profile.level;
      element.dataset['maxParticles'] = String(this.maxParticles() ?? profile.maxParticles);
      element.dataset['antialias'] = String(this.enableAntialias() ?? this.qualityService.getRendererAntialias());
      element.dataset['pixelRatio'] = String(this.qualityService.getPixelRatio());
      element.dataset['shadows'] = String(this.enableShadows() ?? profile.shadows !== false);
      element.dataset['postProcessing'] = String(this.enablePostProcessing() ?? profile.postProcessing);
    });
  }
}
