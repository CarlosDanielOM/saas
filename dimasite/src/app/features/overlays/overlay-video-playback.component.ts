import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import type { OverlayWidget } from './overlay-model.generated';

/**
 * How a video object of an alert design plays: with its own sound (`volume` present) and/or once (`loop: false`).
 * Both off = today's muted looping decoration, with neither key stored.
 */
@Component({
  selector: 'app-overlay-video-playback', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="video-playback" [attr.aria-label]="t('videoPlayback')">
    <label class="row"><span>{{ t('videoSound') }}</span><span class="switch"><input type="checkbox" role="switch" [checked]="hasSound()" (change)="toggleSound()" /><span class="switch__track" aria-hidden="true"></span></span></label>
    @if (hasSound()) {
      <label class="volume"><span>{{ t('soundVolume') }} · {{ percent() }}%</span><input class="range" type="range" min="0" max="100" step="1" [style.--pct]="widget().volume" [value]="percent()" (input)="setVolume($event)" /></label>
    }
    <label class="row"><span>{{ t('videoLoop') }}</span><span class="switch"><input type="checkbox" role="switch" [checked]="widget().loop !== false" (change)="toggleLoop()" aria-describedby="video-loop-hint" /><span class="switch__track" aria-hidden="true"></span></span></label>
    <p id="video-loop-hint">{{ t('videoLoopHint') }}</p>
  </section>`,
  styleUrl: './overlay-video-playback.component.css'
})
export class OverlayVideoPlaybackComponent {
  readonly widget = input.required<OverlayWidget>();
  /** Whole-key changes: `volume: undefined` / `loop: undefined` remove the key. */
  readonly changed = output<Partial<OverlayWidget>>();
  private readonly language = inject(LanguageService);
  readonly hasSound = computed(() => typeof this.widget().volume === 'number');
  readonly percent = computed(() => Math.round((this.widget().volume ?? 1) * 100));
  t(key: string): string { return this.language.translate('overlayStudio.' + key); }
  toggleSound(): void { this.changed.emit({ volume: this.hasSound() ? undefined : 1 }); }
  toggleLoop(): void { this.changed.emit({ loop: this.widget().loop === false ? undefined : false }); }
  setVolume(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.changed.emit({ volume: Math.max(0, Math.min(1, value / 100)) });
  }
}
