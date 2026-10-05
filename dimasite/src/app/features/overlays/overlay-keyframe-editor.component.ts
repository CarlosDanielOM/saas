import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import type { AlertMotion, OverlayWidget } from './overlay.model';
import { defaultMotion } from './overlay-object-motion';
import { MOTION_EASINGS, MOTION_LIMITS, MOTION_PHASES, MOTION_PROPERTIES, neutralValue, type AlertKeyframes, type MotionEasing, type MotionPhase, type MotionPoint, type MotionProperty, type MotionSequence, type MotionTrack } from './overlay-keyframes.model';
import { MOTION_CURVES, easeProgress } from './overlay-keyframe-player';
import { motionWindows } from './overlay-motion-timing';
import { combineSequences } from './overlay-motion-presets';
import { OverlayMotionCatalogComponent, type MotionCatalogChoice } from './overlay-motion-catalog.component';
@Component({
  selector: 'app-overlay-keyframe-editor', imports: [OverlayMotionCatalogComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overlay-keyframe-editor.component.html', styleUrl: './overlay-keyframe-editor.component.css'
})
export class OverlayKeyframeEditorComponent {
  readonly widget = input.required<OverlayWidget>(); readonly duration = input(5); readonly contextKey = input(''); readonly time = input<number | null>(null);
  readonly opened = output<void>(); readonly changed = output<Partial<OverlayWidget>>(); readonly seek = output<number>(); readonly replay = output<void>(); readonly editEnded = output<void>();
  readonly phases = MOTION_PHASES; readonly properties = MOTION_PROPERTIES; readonly easings = MOTION_EASINGS;
  readonly phase = signal<MotionPhase>('enter'); readonly property = signal<MotionProperty>('x'); readonly pointIndex = signal(0);
  readonly catalog = signal(false); readonly expanded = signal(false); readonly dragOffset = signal<number | null>(null);
  readonly clipboard = signal<{keyframes: AlertKeyframes; motion: AlertMotion} | null>(null);
  private pointer?: {id:number; index:number; left:number; width:number; element:HTMLElement};
  private readonly language = inject(LanguageService);
  readonly sequence = computed(() => this.widget().keyframes?.[this.phase()]);
  readonly customCount = computed(() => MOTION_PHASES.filter(phase => this.widget().keyframes?.[phase]).length);
  private readonly identity = computed(() => this.contextKey() + ':' + this.widget().id);
  readonly track = computed(() => this.sequence()?.tracks.find(t => t.property === this.property()) ?? this.sequence()?.tracks[0]);
  readonly activeProperty = computed(() => this.track()?.property ?? this.property());
  readonly index = computed(() => Math.min(this.pointIndex(), (this.track()?.points.length ?? 1) - 1));
  readonly point = computed(() => this.track()?.points[this.index()]);
  readonly motion = computed(() => this.widget().motion ?? defaultMotion(this.widget().kind));
  readonly window = computed(() => motionWindows(this.motion(), this.duration(), this.widget().keyframes)[this.phase()]);
  readonly bounds = computed(() => { const property = this.activeProperty(), multiplier = property === 'scale' || property === 'opacity' ? 100 : 1; return MOTION_LIMITS[property].map(n => n * multiplier); });
  readonly displayedValue = computed(() => { const p = this.activeProperty(); return +((this.point()?.value ?? neutralValue(p)) * (p === 'scale' || p === 'opacity' ? 100 : 1)).toFixed(2); });
  readonly isEndpoint = computed(() => this.index() === 0 || this.index() === (this.track()?.points.length ?? 0) - 1);
  readonly points = computed(() => this.track()?.points.map((p, i) => i === this.index() && this.dragOffset() !== null ? {...p, offset:this.dragOffset()!} : p) ?? []);
  readonly graph = computed(() => {
    const points = this.points(); if (!points.length) return '';
    const values = points.map(p => p.value), min = Math.min(...values), span = Math.max(...values) - min || 1;
    return points.slice(0,-1).flatMap((p,i) => Array.from({length:21},(_,j) => { const t=j/20, next=points[i+1], value=p.value+(next.value-p.value)*easeProgress(p.easing,t); return `${i || j ? 'L' : 'M'}${8+(p.offset+(next.offset-p.offset)*t)*284},${60-(value-min)/span*48}`; })).join(' ');
  });
  readonly curve = computed(() => {
    const easing = this.point()?.easing ?? 'smooth', match = MOTION_CURVES[easing].match(/cubic-bezier\(([^)]+)\)/);
    if (!match) return easing === 'hold' ? 'M 5 55 L 55 55 L 55 5' : 'M 5 55 L 55 5';
    const [x1,y1,x2,y2] = match[1].split(',').map(Number); return `M 5 55 C ${5+x1*50} ${55-y1*50} ${5+x2*50} ${55-y2*50} 55 5`;
  });
  constructor() {
    effect(() => { this.identity(); this.phase.set('enter'); this.property.set('x'); this.pointIndex.set(0); this.catalog.set(false); this.dragOffset.set(null); this.pointer=undefined; });
  }
  t(key: string, params?: Record<string,string|number>) { return this.language.translate('overlayStudio.' + key, params); }
  phaseName(phase: MotionPhase) { return this.t(phase === 'enter' ? 'motionEnter' : phase === 'loop' ? 'motionLoop' : 'motionExit'); }
  setPhase(phase: MotionPhase) { this.phase.set(phase); this.pointIndex.set(0); this.dragOffset.set(null); this.pointer=undefined; this.editEnded.emit(); }
  setProperty(property: MotionProperty) { this.property.set(property); this.pointIndex.set(0); this.editEnded.emit(); }
  private emitSequence(sequence: MotionSequence | undefined, motion = this.motion()) {
    const keyframes = {...this.widget().keyframes}; if (sequence?.tracks.length) keyframes[this.phase()] = sequence; else delete keyframes[this.phase()];
    this.changed.emit({keyframes:Object.keys(keyframes).length ? keyframes : undefined, motion});
  }
  apply(choice: MotionCatalogChoice) {
    const old = this.widget().keyframes?.[choice.phase]; this.phase.set(choice.phase); this.expanded.set(true); this.catalog.set(false);
    const sequence = choice.combine ? combineSequences(old, choice.sequence) : choice.sequence;
    const field = choice.phase === 'enter' ? 'enterDuration' : choice.phase === 'loop' ? 'loopDuration' : 'exitDuration';
    this.emitSequence(sequence, {...this.motion(), [choice.phase]:'none', ...(!choice.combine || !old ? {[field]:choice.duration} : {})});
    this.property.set(choice.sequence.tracks[0].property); this.pointIndex.set(0); this.editEnded.emit(); this.replay.emit();
  }
  addTrack(property: MotionProperty) {
    if (this.sequence()?.tracks.some(t => t.property === property)) {this.setProperty(property); return;}
    const base = neutralValue(property), delta = property === 'scale' ? .1 : property === 'opacity' ? -.3 : property === 'rotation' ? 8 : 15;
    const values = this.phase() === 'loop' ? [base, base + delta, base] : this.phase() === 'enter' ? [property === 'opacity' ? 0 : base + delta, base] : [base, property === 'opacity' ? 0 : base + delta];
    const track: MotionTrack = {property, points: values.map((value,i) => ({offset:i / (values.length - 1), value, easing:'smooth'}))};
    this.emitSequence({tracks:[...(this.sequence()?.tracks ?? []), track]}, {...this.motion(), [this.phase()]:'none'}); this.property.set(property); this.pointIndex.set(0); this.expanded.set(true); this.editEnded.emit();
  }
  removeTrack() { this.emitSequence({tracks:this.sequence()!.tracks.filter(t => t.property !== this.activeProperty())}); this.pointIndex.set(0); this.editEnded.emit(); }
  removePhase() { this.emitSequence(undefined); this.editEnded.emit(); }
  copy() { this.clipboard.set({keyframes:structuredClone(this.widget().keyframes ?? {}), motion:structuredClone(this.motion())}); }
  paste() { const copy = this.clipboard(); if (copy) {this.changed.emit(structuredClone(copy)); this.expanded.set(true); this.editEnded.emit(); this.replay.emit();} }
  selectPoint(index: number) { this.pointIndex.set(index); const point = this.track()?.points[index]; if (point) this.seek.emit(this.window().start + point.offset * this.window().duration); }
  selectFromList(event: Event) { this.selectPoint(Number((event.target as HTMLSelectElement).value)); }
  private replacePoints(points: MotionPoint[], seek = true) {
    const property = this.activeProperty(); this.emitSequence({tracks:this.sequence()!.tracks.map(t => t.property === property ? {...t,points} : t)});
    if (seek) { const point = points[this.index()]; if (point) this.seek.emit(this.window().start + point.offset * this.window().duration); }
  }
  offsetLimit(value: number) { const points = this.track()!.points, index = this.index(); return +Math.max(points[index - 1].offset + .001, Math.min(points[index + 1].offset - .001, value)).toFixed(3); }
  offset(event: Event) { const value = Number((event.target as HTMLInputElement).value); if (!this.isEndpoint() && Number.isFinite(value)) this.replacePoints(this.track()!.points.map((p,i) => i === this.index() ? {...p,offset:this.offsetLimit(value / 100)} : p)); }
  value(event: Event) {
    const raw = Number((event.target as HTMLInputElement).value), property = this.activeProperty(); if (!Number.isFinite(raw)) return;
    const [min,max] = MOTION_LIMITS[property], value = +Math.max(min, Math.min(max, raw / (property === 'scale' || property === 'opacity' ? 100 : 1))).toFixed(4);
    this.replacePoints(this.track()!.points.map((p,i,all) => i === this.index() || this.phase() === 'loop' && this.isEndpoint() && (i === 0 || i === all.length - 1) ? {...p,value} : p));
  }
  easing(event: Event) { const easing = (event.target as HTMLSelectElement).value as MotionEasing; if (MOTION_EASINGS.includes(easing)) this.replacePoints(this.track()!.points.map((p,i) => i === this.index() ? {...p,easing} : p), false); }
  addPoint(atPlayhead = false) {
    const track = this.track(); if (!track || track.points.length >= 24) return;
    const points = track.points, window = this.window();
    let offset: number;
    if (atPlayhead && this.time() !== null && window.duration > 0) {
      const elapsed = Math.max(0, this.time()! - window.start);
      offset = +(this.phase() === 'loop' ? elapsed % window.duration / window.duration : Math.min(1, elapsed / window.duration)).toFixed(3);
      const existing = points.findIndex(p => Math.abs(p.offset - offset) < .001); if (existing >= 0) {this.selectPoint(existing); return;}
    } else {
      let index = Math.min(this.index(), points.length - 2);
      if (points[index+1].offset - points[index].offset < .004) index = points.slice(0,-1).reduce((best,p,i) => points[i+1].offset-p.offset > points[best+1].offset-points[best].offset ? i : best,0);
      if (points[index+1].offset - points[index].offset < .002) return;
      offset = +((points[index].offset + points[index+1].offset) / 2).toFixed(3);
    }
    const right = points.findIndex(p => p.offset > offset); if (right < 1) return;
    const left = points[right-1], next = points[right], mix = (offset-left.offset)/(next.offset-left.offset);
    const value = +(left.value+(next.value-left.value)*easeProgress(left.easing,mix)).toFixed(4);
    this.pointIndex.set(right); this.replacePoints([...points.slice(0,right), {offset,value,easing:left.easing}, ...points.slice(right)]); this.editEnded.emit();
  }
  removePoint() { if (!this.isEndpoint()) {const points=this.track()!.points.filter((_,i)=>i!==this.index()); this.pointIndex.set(Math.max(0,this.index()-1)); this.replacePoints(points); this.editEnded.emit();} }
  /** The parent's "Browse animations" button opens the catalog for the phase being edited. */
  openCatalog() { this.opened.emit(); this.catalog.set(true); }
  toggleDetails(event: Event) { this.expanded.set((event.target as HTMLDetailsElement).open); }
  down(event: PointerEvent, index: number) {
    if (event.button !== 0) return; event.preventDefault(); this.selectPoint(index);
    if (this.isEndpoint()) return;
    const element = event.currentTarget as HTMLElement, rect = element.parentElement!.getBoundingClientRect(); element.setPointerCapture(event.pointerId);
    this.pointer = {id:event.pointerId,index,left:rect.left,width:rect.width,element};
  }
  move(event: PointerEvent) { const p=this.pointer; if(p && p.id===event.pointerId) this.dragOffset.set(this.offsetLimit((event.clientX-p.left)/p.width)); }
  up(event: PointerEvent, cancel=false) {
    const p=this.pointer;if(!p || p.id!==event.pointerId)return; const offset=this.dragOffset();this.pointer=undefined;this.dragOffset.set(null);
    if(p.element.hasPointerCapture(event.pointerId))p.element.releasePointerCapture(event.pointerId);
    if(!cancel && offset!==null){this.replacePoints(this.track()!.points.map((point,i)=>i===p.index?{...point,offset}:point));this.editEnded.emit();}
  }
  key(event: KeyboardEvent,index: number) {
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();this.pointIndex.set(index);
    if(this.isEndpoint())return;
    const offset=event.key==='Home'?0:event.key==='End'?1:this.track()!.points[index].offset+(event.key==='ArrowRight'?1:-1)*(event.shiftKey ? .1 : .01);
    this.replacePoints(this.track()!.points.map((p,i)=>i===index?{...p,offset:this.offsetLimit(offset)}:p));
  }
}
