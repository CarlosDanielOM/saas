import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { OverlayLayerComponent } from './overlay-layer.component';
import { defaultMotion } from './overlay-object-motion';
import { motionWindows } from './overlay-motion-timing';
import { MOTION_PHASES, type AlertKeyframes, type MotionPhase, type MotionSequence } from './overlay-keyframes.model';
import { MOTION_PRESETS, presetSequence, type MotionMood, type MotionPreset } from './overlay-motion-presets';
import type { OverlayWidget } from './overlay.model';
export interface MotionCatalogChoice { phase: MotionPhase; sequence: MotionSequence; duration: number; combine: boolean }
@Component({
  selector: 'app-overlay-motion-catalog', imports: [OverlayLayerComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overlay-motion-catalog.component.html', styleUrl: './overlay-motion-catalog.component.css',
  host: {'(document:visibilitychange)': 'visibilityChanged()'}
})
export class OverlayMotionCatalogComponent {
  readonly initialPhase = input<MotionPhase>('enter'); readonly existing = input<AlertKeyframes>();
  readonly applied = output<MotionCatalogChoice>(); readonly closed = output<void>();
  private readonly language = inject(LanguageService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  readonly phases = MOTION_PHASES; readonly moods = ['all', 'gentle', 'playful', 'bold'] as const;
  readonly phase = signal<MotionPhase>('enter'); readonly mood = signal<MotionMood | 'all'>('all'); readonly query = signal('');
  readonly chosenId = signal('dissolve'); readonly strength = signal(100); readonly speed = signal(.7);
  readonly settingsOpen = signal(false); readonly paused = signal(false); readonly hidden = signal(false); readonly replay = signal(1); readonly requestReplay = signal(0);
  readonly chosen = computed(() => MOTION_PRESETS.find(p => p.id === this.chosenId())!);
  readonly presets = computed(() => MOTION_PRESETS.filter(p => p.phase === this.phase() && (this.mood() === 'all' || p.mood === this.mood())
    && (this.t('kfPreset_' + p.id) + ' ' + this.t('kfDesc_' + p.id)).toLocaleLowerCase().includes(this.query().trim().toLocaleLowerCase())));
  readonly preview = computed(() => this.demo(this.chosen(), this.strength() / 100, this.speed()));
  readonly thumbs = new Map(MOTION_PRESETS.map(p => [p.id, this.demo(p)]));
  private returnFocus: HTMLElement | null = null;
  constructor() {
    effect(() => this.setPhase(this.initialPhase()));
    effect(cleanup => {
      const duration = this.preview().duration; this.requestReplay();
      const paused = this.paused() || this.hidden();
      untracked(() => this.replay.update(n => n + 1));
      if (paused) return;
      const timer = setInterval(() => this.replay.update(n => n + 1), (duration + .5) * 1000);
      cleanup(() => clearInterval(timer));
    });
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      this.returnFocus = document.activeElement as HTMLElement; this.dialog().nativeElement.showModal(); this.hidden.set(document.hidden);
      const reduced = matchMedia('(prefers-reduced-motion: reduce)'), wide = matchMedia('(min-width:640px)');
      this.paused.set(reduced.matches); this.settingsOpen.set(wide.matches);
      const reduce = () => { if (reduced.matches) this.paused.set(true); }, resize = () => this.settingsOpen.set(wide.matches);
      reduced.addEventListener('change', reduce); wide.addEventListener('change', resize);
      destroy.onDestroy(() => { reduced.removeEventListener('change', reduce); wide.removeEventListener('change', resize); });
    });
    destroy.onDestroy(() => this.returnFocus?.focus());
  }
  t(key: string) { return this.language.translate('overlayStudio.' + key); }
  phaseName(phase: MotionPhase) { return this.t(phase === 'enter' ? 'motionEnter' : phase === 'loop' ? 'motionLoop' : 'motionExit'); }
  private demo(preset: MotionPreset, strength = 1, duration = preset.duration) {
    const motion = {...defaultMotion(), enterDuration: .5, loopDuration: 2, exitDuration: .5, [preset.phase === 'enter' ? 'enterDuration' : preset.phase === 'loop' ? 'loopDuration' : 'exitDuration']: duration};
    const total = preset.phase === 'loop' ? duration * 2 + .001 : duration + .8;
    const keyframes = {[preset.phase]: presetSequence(preset, strength)}, window = motionWindows(motion, total, keyframes)[preset.phase];
    const layer: OverlayWidget = {id: 'preview', kind: 'shape', x:0, y:0, width:120, height:72, visible:true, locked:false, color:'#a78bfa', radius:18, borderColor:'#e9ddff', borderWidth:2, motion, keyframes};
    return {layer, duration:total, time:window.start + window.duration * .42};
  }
  setPhase(phase: MotionPhase) { this.phase.set(phase); this.mood.set('all'); this.query.set(''); this.choose(MOTION_PRESETS.find(p => p.phase === phase)!); }
  choose(preset: MotionPreset) { this.chosenId.set(preset.id); this.strength.set(100); this.speed.set(preset.duration); this.requestReplay.update(n => n + 1); }
  search(event: Event) { this.query.set((event.target as HTMLInputElement).value); }
  number(kind: 'speed' | 'strength', event: Event) {
    const value = Number((event.target as HTMLInputElement).value); if (!Number.isFinite(value)) return;
    if (kind === 'strength') this.strength.set(Math.max(25, Math.min(200, value)));
    else this.speed.set(Math.max(this.phase() === 'loop' ? .2 : .1, Math.min(this.phase() === 'loop' ? 10 : 5, value)));
  }
  use(combine: boolean) { this.applied.emit({phase:this.phase(), sequence:presetSequence(this.chosen(), this.strength() / 100), duration:this.speed(), combine}); }
  replayPreview() { this.paused.set(false); this.requestReplay.update(n => n + 1); }
  toggleSettings(event: Event) { this.settingsOpen.set((event.target as HTMLDetailsElement).open); }
  visibilityChanged() { this.hidden.set(document.hidden); }
  close(event?: Event) { event?.preventDefault(); event?.stopPropagation(); this.closed.emit(); }
}
