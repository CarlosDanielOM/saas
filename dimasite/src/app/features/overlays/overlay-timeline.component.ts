import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { defaultMotion } from './overlay-object-motion';
import type { AlertLayout, OverlayWidget } from './overlay.model';
import type { AlertTransport } from './overlay-sound.component';
export interface TimelineEdit { id: string; field: 'delay' | 'enterDuration' | 'exitDuration' | 'fadeIn' | 'fadeOut'; value: number }
@Component({
  selector: 'app-overlay-timeline', changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overlay-timeline.component.html', styleUrl: './overlay-timeline.component.css'
})
export class OverlayTimelineComponent {
  readonly layout = input.required<AlertLayout>();
  readonly eventKey = input.required<string>();
  readonly selectedId = input<string | null>(null);
  readonly transport = input<AlertTransport | null>(null);
  readonly selected = output<string>();
  readonly edited = output<TimelineEdit>();
  readonly editEnded = output<void>();
  readonly seek = output<number>();
  readonly toggle = output<void>();
  readonly closed = output<void>();
  private readonly language = inject(LanguageService);
  readonly soundSelected = signal(false);
  readonly dragging = signal<{ id: string; value: number } | null>(null);
  private pointer?: { id: string; pointerId: number; x: number; value: number; width: number; element: HTMLElement };
  readonly item = computed(() => this.layout().widgets.find(w => w.id === this.selectedId()));
  readonly motion = computed(() => this.item()?.motion ?? defaultMotion(this.item()?.kind));
  readonly ticks = computed(() => Array.from({ length: 5 }, (_, i) => +(this.layout().duration * i / 4).toFixed(2)));
  constructor() { effect(() => { this.selectedId(); this.soundSelected.set(false); }); effect(() => { this.eventKey(); this.soundSelected.set(false); this.dragging.set(null); this.pointer = undefined; }); }
  t(key: string): string { return this.language.translate('overlayStudio.' + key); }
  name(w: OverlayWidget): string { return w.name || this.t(w.kind + 'Name'); }
  select(id: string): void { this.soundSelected.set(id === '$sound'); if (id !== '$sound') this.selected.emit(id); }
  delay(id: string): number { return this.dragging()?.id === id ? this.dragging()!.value : id === '$sound' ? this.layout().sound?.delay ?? 0 : this.layout().widgets.find(w => w.id === id)?.motion?.delay ?? 0; }
  percent(n: number): number { return Math.max(0, Math.min(100, n / this.layout().duration * 100)); }
  phases(w: OverlayWidget): { enter: number; exit: number } {
    const motion = w.motion ?? defaultMotion(w.kind), available = Math.max(0, this.layout().duration - this.delay(w.id));
    const entrance = motion.enter === 'none' ? .001 : motion.enterDuration, exit = motion.exit === 'none' ? 0 : motion.exitDuration;
    const fit = Math.min(1, available / (entrance + exit));
    return { enter: this.percent(entrance * fit), exit: this.percent(exit * fit) };
  }
  inputValue(event: Event): number { return Number((event.target as HTMLInputElement).value); }
  change(id: string, field: TimelineEdit['field'], value: number): void {
    if (!Number.isFinite(value)) return;
    const min = field === 'enterDuration' || field === 'exitDuration' ? .1 : 0;
    const max = field === 'delay' ? 120 : field === 'fadeIn' || field === 'fadeOut' ? 10 : 5;
    this.edited.emit({ id, field, value: Math.max(min, Math.min(max, value)) });
  }
  down(event: PointerEvent, id: string): void {
    if (event.button !== 0) return; event.preventDefault(); this.select(id);
    const element = event.currentTarget as HTMLElement; element.setPointerCapture(event.pointerId);
    this.pointer = { id, pointerId: event.pointerId, x: event.clientX, value: this.delay(id), width: element.parentElement!.clientWidth, element };
  }
  move(event: PointerEvent): void {
    const p = this.pointer; if (!p || p.pointerId !== event.pointerId) return;
    const value = Math.round(Math.max(0, Math.min(this.layout().duration, p.value + (event.clientX - p.x) / p.width * this.layout().duration)) * 10) / 10;
    this.dragging.set({ id: p.id, value });
  }
  up(event: PointerEvent, cancel = false): void {
    const p = this.pointer; if (!p || p.pointerId !== event.pointerId) return;
    const value = this.dragging()?.value; this.pointer = undefined; this.dragging.set(null);
    if (p.element.hasPointerCapture(event.pointerId)) p.element.releasePointerCapture(event.pointerId);
    if (!cancel && value !== undefined && value !== p.value) { this.change(p.id, 'delay', value); this.editEnded.emit(); }
  }
  key(event: KeyboardEvent, id: string): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); this.select(id);
    const value = event.key === 'Home' ? 0 : event.key === 'End' ? this.layout().duration : this.delay(id) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : .1);
    this.change(id, 'delay', Math.round(Math.max(0, Math.min(this.layout().duration, value)) * 10) / 10);
  }
}
