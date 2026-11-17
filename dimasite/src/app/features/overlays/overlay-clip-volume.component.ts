import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import type { OverlayWidget } from './overlay-model.generated';

/** How loud clips play in a clip layer, like a trigger's volume. No `volume` key = full volume (layers made before it). */
@Component({
  selector: 'app-overlay-clip-volume', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<label class="volume"><span>{{ t('clipVolume') }} · {{ percent() }}%</span><input class="range" type="range" min="0" max="100" step="1" [style.--pct]="percent() / 100" [value]="percent()" [attr.aria-valuetext]="percent() + '%'" aria-describedby="clip-volume-hint" (input)="setVolume($event)" /></label>
    <p id="clip-volume-hint">{{ t('clipVolumeHint') }}</p>`,
  // Same slider as a video's sound in alert designs.
  styleUrl: './overlay-video-playback.component.css'
})
export class OverlayClipVolumeComponent {
  readonly widget = input.required<OverlayWidget>();
  readonly changed = output<Pick<OverlayWidget, 'volume'>>();
  private readonly language = inject(LanguageService);
  readonly percent = computed(() => { const volume = this.widget().volume; return Math.round((typeof volume === 'number' && Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1) * 100); });
  t(key: string): string { return this.language.translate('overlayStudio.' + key); }
  setVolume(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.changed.emit({ volume: Math.max(0, Math.min(100, Math.round(value))) / 100 });
  }
}
