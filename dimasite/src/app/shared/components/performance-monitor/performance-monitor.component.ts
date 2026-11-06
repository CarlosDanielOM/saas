import { DecimalPipe, UpperCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LanguageService } from '../../../services/language.service';
import { QualityLevel, ThreeQualityService } from '../../../core/services/three-quality.service';

@Component({
  selector: 'app-performance-monitor',
  imports: [UpperCasePipe, DecimalPipe],
  template: `
    <button type="button" class="perf-toggle" (click)="toggle()">
      {{ t(isVisible() ? 'hidePerformance' : 'showPerformance') }}
    </button>

    @if (isVisible()) {
      <section class="performance-monitor" [attr.aria-label]="t('performanceMonitor')">
        <div class="perf-grid">
          <p><span>{{ t('quality') }}</span><strong>{{ t(effectiveQuality()) | uppercase }}</strong></p>
          <p><span>{{ t('mode') }}</span><strong>{{ t(qualityMode()) | uppercase }}</strong></p>
          <p><span>FPS</span><strong [class]="'fps-' + fpsClass()">{{ metrics().currentFps }}</strong></p>
          <p><span>{{ t('averageFps') }}</span><strong>{{ metrics().averageFps | number: '1.0-0' }}</strong></p>
          <p><span>{{ t('frameTime') }}</span><strong>{{ metrics().frameTime | number: '1.1-1' }} ms</strong></p>
          <p><span>{{ t('memory') }}</span><strong>{{ metrics().memoryUsage }} MB</strong></p>
        </div>

        <div class="perf-controls">
          <button type="button" class="mode-btn" (click)="cycleMode()">{{ t(qualityMode()) }}</button>
          <button type="button" class="mode-btn" (click)="toggleEnabled()">
            {{ t(qualityEnabled() ? 'adaptiveOn' : 'adaptiveOff') }}
          </button>
        </div>

        <div class="quality-buttons">
          @for (level of qualityLevels; track level) {
            <button
              type="button"
              [class]="'quality-btn quality-btn-' + level + (effectiveQuality() === level ? ' is-active' : '')"
              (click)="setQuality(level)"
            >
              {{ t(level) | uppercase }}
            </button>
          }
        </div>
      </section>
    }
  `,
  styleUrl: './performance-monitor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PerformanceMonitorComponent {
  private readonly language = inject(LanguageService);
  protected t(key: string): string { return this.language.translate(`common.sliceAccessibility.${key}`); }
  private readonly qualityService = inject(ThreeQualityService);

  readonly isVisible = signal(false);
  readonly qualityLevels: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

  readonly qualityMode = computed(() => this.qualityService.qualityMode());
  readonly qualityEnabled = computed(() => this.qualityService.enabled());
  readonly effectiveQuality = computed(() => this.qualityService.effectiveQuality());
  readonly metrics = computed(() => this.qualityService.getPerformanceMetrics());

  toggle(): void {
    this.isVisible.update((value) => !value);
  }

  cycleMode(): void {
    const next = this.qualityMode() === 'auto' ? 'manual' : 'auto';
    this.qualityService.setQualityMode(next);
  }

  setQuality(level: QualityLevel): void {
    this.qualityService.setQuality(level);
  }

  toggleEnabled(): void {
    this.qualityService.setEnabled(!this.qualityEnabled());
  }

  fpsClass(): 'good' | 'warning' | 'critical' {
    const fps = this.metrics().currentFps;
    if (fps < 25) {
      return 'critical';
    }
    if (fps < 40) {
      return 'warning';
    }
    return 'good';
  }
}
