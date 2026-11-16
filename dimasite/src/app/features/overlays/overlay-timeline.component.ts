import { motionStop, motionWindows } from './overlay-motion-timing';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { defaultMotion } from './overlay-object-motion';
import { layoutSounds, soundStop, type AlertLayout, type OverlayWidget } from './overlay-model.generated';
import type { AlertTransport } from './overlay-sound.component';
/** `end` with `value: undefined` removes the end key, so the object or sound follows the alert's length again.
 * `id` is the row id: an object's id, or `$sound:<sound id>`. */
export interface TimelineEdit { id: string; field: 'delay' | 'end' | 'enterDuration' | 'exitDuration' | 'fadeIn' | 'fadeOut'; value: number | undefined }
type Edge = 'start' | 'end';
type Drag = { id: string; edge: Edge; value: number };
/** One row's bar in seconds; `end` is the effective stored end (undefined = when the alert ends). */
interface RowTiming { start: number; stop: number; end: number | undefined; startMax: number; endMin: number; enter: number; exit: number }
const GAP = .1;
/** Row ids of sounds: `$sound:<sound id>`. */
export const SOUND_ROW = '$sound:';
const tenths = (n: number) => Math.round(n * 10) / 10;
@Component({
  selector: 'app-overlay-timeline', changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overlay-timeline.component.html', styleUrl: './overlay-timeline.component.css'
})
export class OverlayTimelineComponent {
  readonly layout = input.required<AlertLayout>();
  readonly eventKey = input.required<string>();
  /** A trigger look (not an alert): its wording says so. */
  readonly look = input(false);
  readonly selectedId = input<string | null>(null);
  readonly transport = input<AlertTransport | null>(null);
  readonly selected = output<string>();
  readonly edited = output<TimelineEdit>();
  readonly editEnded = output<void>();
  readonly seek = output<number>();
  readonly toggle = output<void>();
  readonly closed = output<void>();
  private readonly language = inject(LanguageService);
  readonly dragging = signal<Drag | null>(null);
  private pointer?: { id: string; edge: Edge; pointerId: number; x: number; value: number; width: number; element: HTMLElement };
  readonly ticks = computed(() => Array.from({ length: 5 }, (_, i) => +(this.layout().duration * i / 4).toFixed(2)));
  /** Every row's bar with the grip being dragged applied, so the bar, its phases and both grips move together. */
  readonly timings = computed(() => {
    const layout = this.layout(), drag = this.dragging(), map = new Map<string, RowTiming>();
    for (const w of layout.widgets) map.set(w.id, this.rowTiming(w.id, w.motion?.delay ?? 0, w.motion?.end, drag, (start, end) => {
      const motion = { ...w.motion ?? defaultMotion(w.kind), delay: start, end };
      const windows = motionWindows(motion, layout.duration, w.keyframes);
      return { stop: motionStop(motion, layout.duration), enter: windows.enter.span, exit: windows.exit.span };
    }));
    for (const { row, sound } of this.soundRows()) map.set(row, this.rowTiming(row, sound.delay, sound.end, drag, (start, end) => ({ stop: Math.max(Math.min(start, layout.duration), soundStop({ ...sound, end }, layout.duration)), enter: 0, exit: 0 })));
    return map;
  });
  /** One row per sound, id `$sound:<id>`, named after its file (fallback "Sound 1", "Sound 2"…). */
  readonly soundRows = computed(() => layoutSounds(this.layout()).map((sound, index) => ({ row: SOUND_ROW + (sound.id ?? 'sound'), sound, name: sound.name || this.language.translate('overlayStudio.soundNumber', { n: index + 1 }) })));
  /** The sound row the user picked, or null when an object row is selected. */
  readonly soundSelected = signal<string | null>(null);
  constructor() { effect(() => { this.selectedId(); this.soundSelected.set(null); }); effect(() => { this.eventKey(); this.soundSelected.set(null); this.dragging.set(null); this.pointer = undefined; }); }
  private rowTiming(id: string, delay: number, stored: number | undefined, drag: Drag | null, measure: (start: number, end: number | undefined) => { stop: number; enter: number; exit: number }): RowTiming {
    const duration = this.layout().duration;
    const start = drag?.id === id && drag.edge === 'start' ? drag.value : delay;
    let end = typeof stored === 'number' && Number.isFinite(stored) && stored < duration ? stored : undefined;
    if (drag?.id === id && drag.edge === 'end') end = drag.value < duration ? drag.value : undefined;
    const { stop, enter, exit } = measure(start, end);
    // The grips keep at least 0.1 s between them, on the 0.1 s grid.
    const startMax = Math.max(0, Math.floor(((end ?? duration) - GAP) * 10 + 1e-6) / 10);
    const endMin = Math.min(duration, Math.ceil((start + GAP) * 10 - 1e-6) / 10);
    return { start, stop, end, startMax, endMin, enter, exit };
  }
  t(key: string): string { return this.language.translate('overlayStudio.' + key); }
  name(w: OverlayWidget): string { return w.name || this.t(w.kind + 'Name'); }
  select(id: string): void { const sound = id.startsWith(SOUND_ROW); this.soundSelected.set(sound ? id : null); if (!sound) this.selected.emit(id); }
  timing(id: string): RowTiming { return this.timings().get(id)!; }
  /** Slider values stay inside their advertised range even for saved times the renderer has to clamp. */
  within(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
  delay(id: string): number { return this.timing(id).start; }
  percent(n: number): number { return Math.max(0, Math.min(100, n / this.layout().duration * 100)); }
  seconds(n: number): string { return tenths(n) + ' s'; }
  endText(id: string): string { const end = this.timing(id).end; return end === undefined ? this.t(this.look() ? 'look_timelineEndsWithAlert' : 'timelineEndsWithAlert') : this.seconds(end); }
  draggingEdge(id: string, edge: Edge): boolean { const d = this.dragging(); return d?.id === id && d.edge === edge; }

  inputValue(event: Event): number { return Number((event.target as HTMLInputElement).value); }
  change(id: string, field: TimelineEdit['field'], value: number | undefined): void {
    if (field === 'end' && value === undefined) { this.edited.emit({ id, field, value }); return; }
    if (value === undefined || !Number.isFinite(value)) return;
    const min = field === 'enterDuration' || field === 'exitDuration' || field === 'end' ? .1 : 0;
    const max = field === 'delay' || field === 'end' ? 120 : field === 'fadeIn' || field === 'fadeOut' ? 10 : 5;
    this.edited.emit({ id, field, value: Math.max(min, Math.min(max, value)) });
  }
  /** Sets the end within its limits; the alert's end is stored as "no end". Returns whether anything changed. */
  private commitEnd(id: string, value: number): boolean {
    const timing = this.timing(id), duration = this.layout().duration;
    const end = Math.max(timing.endMin, Math.min(duration, value)), next = end >= duration ? undefined : end;
    const layout = this.layout(), raw = id.startsWith(SOUND_ROW) ? this.soundRows().find(r => r.row === id)?.sound.end : layout.widgets.find(w => w.id === id)?.motion?.end;
    if (next === raw) return false;
    this.change(id, 'end', next); return true;
  }
  down(event: PointerEvent, id: string, edge: Edge = 'start'): void {
    if (event.button !== 0) return; event.preventDefault(); this.select(id);
    const element = event.currentTarget as HTMLElement; element.setPointerCapture(event.pointerId);
    const timing = this.timing(id);
    this.pointer = { id, edge, pointerId: event.pointerId, x: event.clientX, value: edge === 'start' ? timing.start : timing.end ?? this.layout().duration, width: element.parentElement!.clientWidth, element };
  }
  move(event: PointerEvent): void {
    const p = this.pointer; if (!p || p.pointerId !== event.pointerId) return;
    const timing = this.timing(p.id), duration = this.layout().duration;
    const [low, high] = p.edge === 'start' ? [0, timing.startMax] : [timing.endMin, duration];
    const value = Math.max(low, Math.min(high, tenths(p.value + (event.clientX - p.x) / p.width * duration)));
    this.dragging.set({ id: p.id, edge: p.edge, value });
  }
  up(event: PointerEvent, cancel = false): void {
    const p = this.pointer; if (!p || p.pointerId !== event.pointerId) return;
    const value = this.dragging()?.value; this.pointer = undefined; this.dragging.set(null);
    if (p.element.hasPointerCapture(event.pointerId)) p.element.releasePointerCapture(event.pointerId);
    if (cancel || value === undefined) return;
    // One drag is one change, so undo takes it back in one step.
    if (p.edge === 'start') { if (value !== p.value) { this.change(p.id, 'delay', value); this.editEnded.emit(); } }
    else if (this.commitEnd(p.id, value)) this.editEnded.emit();
  }
  key(event: KeyboardEvent, id: string, edge: Edge = 'start'): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); this.select(id);
    const timing = this.timing(id), duration = this.layout().duration, step = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : .1);
    if (edge === 'start') {
      const value = event.key === 'Home' ? 0 : event.key === 'End' ? timing.startMax : timing.start + step;
      this.change(id, 'delay', tenths(Math.max(0, Math.min(timing.startMax, value))));
      return;
    }
    this.commitEnd(id, event.key === 'Home' ? timing.endMin : event.key === 'End' ? duration : tenths((timing.end ?? duration) + step));
  }
}
