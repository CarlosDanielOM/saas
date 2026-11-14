import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { LucideAngularModule, Plus, Trash2, Volume2, ChevronDown } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { MAX_ALERT_SOUNDS, type AlertSound } from './overlay.model';

/** One edited field of one sound; `end: undefined` removes the key. The host applies it to its current list, so two
 * edits made before the panel re-renders never overwrite each other. */
export interface SoundEdit { id: string; field: 'volume' | 'delay' | 'fadeIn' | 'fadeOut' | 'end'; value: number | undefined }

const tenthsUp = (n: number) => Math.ceil(n * 10 - 1e-6) / 10;
const tenthsDown = (n: number) => Math.floor(n * 10 + 1e-6) / 10;

/**
 * The sounds of one alert layout (max 10). It never opens a file picker itself: it asks for one with `add` /
 * `replace`, so each host chooses its own library (Overlay Studio assets today, trigger media later).
 */
@Component({
  selector: 'app-overlay-sounds', imports: [LucideAngularModule], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overlay-sounds.component.html', styleUrl: './overlay-sounds.component.css'
})
export class OverlaySoundsComponent {
  readonly icons = { Plus, Trash2, Volume2, ChevronDown };
  readonly max = MAX_ALERT_SOUNDS;
  readonly sounds = input.required<readonly AlertSound[]>();
  /** The alert's length in seconds: "Stops at" at or after it means "until the alert ends". */
  readonly duration = input.required<number>();
  /** A different layout (event, look or design): the open row starts over. */
  readonly layoutKey = input('');
  readonly disabled = input(false);
  readonly add = output<void>();
  readonly replace = output<string>();
  readonly changed = output<SoundEdit>();
  readonly removed = output<string>();
  private readonly language = inject(LanguageService);
  /** undefined = nothing chosen yet (the first sound is open); null = all closed. */
  private readonly chosen = signal<string | null | undefined>(undefined);
  readonly openId = computed(() => { const chosen = this.chosen(), sounds = this.sounds(); return chosen === undefined ? sounds[0]?.id ?? null : sounds.some(s => s.id === chosen) ? chosen : null; });
  readonly full = computed(() => this.sounds().length >= MAX_ALERT_SOUNDS);
  private known = new Set<string>();
  constructor() {
    effect(() => { this.layoutKey(); this.chosen.set(undefined); this.known = new Set(untracked(this.sounds).map(s => s.id ?? '')); });
    // A sound that was just added opens, so its settings are right there.
    effect(() => {
      const ids = this.sounds().map(s => s.id ?? ''), added = ids.find(id => !this.known.has(id));
      this.known = new Set(ids);
      if (added !== undefined) untracked(() => this.chosen.set(added));
    });
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('overlayStudio.' + key, params); }
  name(sound: AlertSound, index: number): string { return sound.name || this.t('soundNumber', { n: index + 1 }); }
  percent(sound: AlertSound): number { return Math.round(sound.volume * 100); }
  summary(sound: AlertSound): string {
    return this.t('soundSummary', { volume: this.percent(sound), start: Math.round(sound.delay * 10) / 10 });
  }
  toggle(id: string): void { this.chosen.set(this.openId() === id ? null : id); }
  private value(event: Event): string { return (event.target as HTMLInputElement).value; }
  /** Volume (slider, %) and the times; a clamped number field shows what was kept. */
  setValue(sound: AlertSound, field: 'volume' | 'delay' | 'fadeIn' | 'fadeOut', event: Event): void {
    const value = Number(this.value(event)); if (!Number.isFinite(value)) return;
    const max = field === 'volume' ? 1 : field === 'delay' ? (sound.end === undefined ? 120 : Math.max(0, tenthsDown(sound.end - .1))) : 10;
    const next = Math.max(0, Math.min(max, field === 'volume' ? value / 100 : value));
    this.changed.emit({ id: sound.id!, field, value: next });
    if (field !== 'volume') (event.target as HTMLInputElement).value = String(next);
  }
  /** "Stops at": empty, or at/after the alert's end, removes `end`; otherwise at least 0.1 s after the start. */
  setEnd(sound: AlertSound, event: Event): void {
    const raw = this.value(event).trim(), duration = this.duration();
    let end: number | undefined;
    if (raw !== '') {
      const value = Number(raw); if (!Number.isFinite(value)) return;
      end = Math.min(120, Math.max(.1, tenthsUp(sound.delay + .1), Math.round(value * 10) / 10));
      if (end >= duration) end = undefined;
    }
    this.changed.emit({ id: sound.id!, field: 'end', value: end });
    (event.target as HTMLInputElement).value = end === undefined ? '' : String(end);
  }
}
