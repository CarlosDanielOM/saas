import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ArrowLeft, Bell, Clapperboard, Copy, Eye, EyeOff, Grip, Image, Layers3, LockKeyhole, Moon, Play, Plus, RotateCcw, Save, Sparkles, Sun, Trash2, Type, Volume2, Zap, LucideAngularModule } from 'lucide-angular';
import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';
import { ALERT_EVENTS, EVENT_KINDS, STORAGE_KEY, AlertDesign, AlertEvent, EventKind, OverlayScene, OverlayWidget, WidgetKind, clone, makeDesign, makeScene } from './overlay-mock.model';

type Dimension = 'x' | 'y' | 'width' | 'height';
interface PointerSession { id: string; action: 'move' | 'resize'; startX: number; startY: number; original: OverlayWidget; canvas: DOMRect }
interface MockEvent { id: number; kind: EventKind }

@Component({
  selector: 'app-overlay-editor-mock', imports: [RouterLink, LucideAngularModule],
  templateUrl: './overlay-editor-mock.component.html', styleUrl: './overlay-editor-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:pointermove)': 'onPointerMove($event)', '(window:pointerup)': 'stopPointer()', '(window:pointercancel)': 'stopPointer()' }
})
export class OverlayEditorMockComponent {
  readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  private pointer: PointerSession | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private queueTimer?: ReturnType<typeof setTimeout>;
  private nextId = Date.now();
  readonly icons = { ArrowLeft, Bell, Clapperboard, Copy, Eye, EyeOff, Grip, Layers3, LockKeyhole, Moon, Play, Plus, RotateCcw, Save, Sun, Trash2, Volume2, Zap };
  readonly alertEvents = ALERT_EVENTS;
  readonly eventKinds = EVENT_KINDS;
  readonly designs = signal<AlertDesign[]>([]);
  readonly scenes = signal<OverlayScene[]>([]);
  readonly sceneId = signal('gameplay');
  readonly scene = computed(() => this.scenes().find(s => s.id === this.sceneId())!);
  readonly designDraft = signal<AlertDesign | null>(null);
  readonly designEvent = signal<AlertEvent>('follow');
  readonly libraryOpen = signal(false);
  readonly canvasWidth = computed(() => this.designDraft()?.width ?? this.scene()?.width ?? 1920);
  readonly canvasHeight = computed(() => this.designDraft()?.height ?? this.scene()?.height ?? 1080);
  readonly widgets = computed(() => this.designDraft()?.events[this.designEvent()].widgets ?? this.scene()?.widgets ?? []);
  readonly palette = computed<WidgetKind[]>(() => this.designDraft() ? ['text', 'image', 'video', 'animation'] : ['tts', 'trigger', 'clip', 'alert', 'image', 'video']);
  readonly selectedId = signal<string | null>('alert-1');
  readonly panel = signal<'library' | 'canvas' | 'properties'>('canvas');
  readonly snap = signal(true);
  readonly saved = signal(false);
  readonly notice = signal('');
  readonly selected = computed(() => this.widgets().find(w => w.id === this.selectedId()) ?? null);
  readonly offCanvas = computed(() => this.widgets().filter(w => w.x < 0 || w.y < 0 || w.x + w.width > this.canvasWidth() || w.y + w.height > this.canvasHeight()).length);
  readonly queue = signal<MockEvent[]>([]);
  readonly active = signal<MockEvent | null>(null);
  readonly parallel = signal<MockEvent[]>([]);
  readonly previewDesign = signal(false);
  readonly sampleUser = signal('Luna');
  readonly sampleAmount = signal('100');

  constructor() {
    this.seed();
    afterNextRender(() => this.restoreDraft());
    inject(DestroyRef).onDestroy(() => this.timers.forEach(timer => clearTimeout(timer)));
  }
  t(key: string, params?: Record<string, string | number>): string {
    this.language.currentLanguage(); return this.language.translate(`overlayMock.${key}`, params);
  }
  isDark(): boolean { return this.theme.isDarkMode(); }
  toggleTheme(): void { this.theme.toggleTheme(); }
  toggleLanguage(): void { this.language.toggleLanguage(); }
  setPanel(panel: 'library' | 'canvas' | 'properties'): void { this.panel.set(panel); }
  toggleSnap(): void { this.snap.update(v => !v); }
  select(id: string): void { this.selectedId.set(id); }
  value(event: Event): string { return (event.target as HTMLInputElement).value; }
  private id(prefix: string): string { return `${prefix}-${this.nextId++}`; }
  private seed(): void {
    const design = makeDesign('aurora', this.t('starterDesign'));
    this.designs.set([design]);
    this.scenes.set([makeScene('gameplay', this.t('gameplay'), design.id), makeScene('chatting', this.t('chatting'), design.id)]);
  }
  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); return timer;
  }
  private updateWidgets(update: (widgets: OverlayWidget[]) => OverlayWidget[]): void {
    if (this.designDraft()) this.designDraft.update(d => d ? { ...d, events: { ...d.events, [this.designEvent()]: { ...d.events[this.designEvent()], widgets: update(d.events[this.designEvent()].widgets) } } } : d);
    else this.updateScene({ widgets: update(this.widgets()) });
    this.saved.set(false);
  }
  private updateScene(changes: Partial<OverlayScene>): void {
    this.scenes.update(all => all.map(s => s.id === this.sceneId() ? { ...s, ...changes } : s)); this.saved.set(false);
  }
  private patch(id: string, changes: Partial<OverlayWidget>): void { this.updateWidgets(all => all.map(w => w.id === id ? { ...w, ...changes } : w)); }
  patchSelected(changes: Partial<OverlayWidget>): void { const id = this.selectedId(); if (id) this.patch(id, changes); }
  widgetIcon(kind: WidgetKind) { return ({ tts: Volume2, trigger: Zap, clip: Clapperboard, alert: Bell, text: Type, image: Image, video: Play, animation: Sparkles })[kind]; }
  widgetName(widget: OverlayWidget): string { return widget.name || this.t(`${widget.kind}Name`); }
  addWidget(kind: WidgetKind, position?: { x: number; y: number }): void {
    const width = kind === 'tts' ? 580 : kind === 'alert' ? 640 : kind === 'text' ? 400 : 300;
    const height = kind === 'tts' ? 160 : kind === 'alert' ? 192 : kind === 'text' ? 80 : 180;
    const widget: OverlayWidget = { id: this.id(kind), kind, x: position?.x ?? 40, y: position?.y ?? 40, width, height, visible: true, locked: false,
      ...(kind === 'alert' ? { designId: this.designs()[0].id, events: [...ALERT_EVENTS] } : {}), ...(kind === 'text' ? { text: '$(user)' } : {}) };
    this.updateWidgets(all => [...all, widget]); this.select(widget.id); this.panel.set('canvas');
  }
  onPaletteDrag(event: DragEvent, kind: WidgetKind): void { event.dataTransfer?.setData('application/x-overlay-widget', kind); }
  onCanvasDragOver(event: DragEvent): void { event.preventDefault(); }
  onCanvasDrop(event: DragEvent): void {
    event.preventDefault(); const kind = event.dataTransfer?.getData('application/x-overlay-widget') as WidgetKind;
    if (!this.palette().includes(kind)) return;
    const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.addWidget(kind, { x: this.round((event.clientX-r.left)/r.width*this.canvasWidth()), y: this.round((event.clientY-r.top)/r.height*this.canvasHeight()) });
  }
  startPointer(event: PointerEvent, widget: OverlayWidget, action: 'move' | 'resize'): void {
    if (widget.locked || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const canvas = (event.currentTarget as HTMLElement).closest('.stage')?.getBoundingClientRect();
    if (canvas) { this.select(widget.id); this.pointer = { id: widget.id, action, startX: event.clientX, startY: event.clientY, original: { ...widget }, canvas }; }
  }
  onPointerMove(event: PointerEvent): void {
    const s = this.pointer; if (!s) return;
    const dx = (event.clientX-s.startX)/s.canvas.width*this.canvasWidth(), dy = (event.clientY-s.startY)/s.canvas.height*this.canvasHeight();
    this.patch(s.id, s.action === 'move' ? { x: this.round(s.original.x+dx), y: this.round(s.original.y+dy) } : { width: Math.max(20,this.round(s.original.width+dx)), height: Math.max(20,this.round(s.original.height+dy)) });
  }
  stopPointer(): void { this.pointer = null; }
  onWidgetKeydown(event: KeyboardEvent, widget: OverlayWidget): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.select(widget.id); return; }
    const moves: Record<string, number[]> = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] };
    const move = moves[event.key]; if (!move || widget.locked) return;
    event.preventDefault(); this.select(widget.id); const step = this.snap() ? 10 : 1;
    this.patch(widget.id, { x: widget.x+move[0]*step, y: widget.y+move[1]*step });
  }
  updateDimension(field: Dimension, event: Event): void {
    const number = Number(this.value(event)); if (!Number.isFinite(number) || !this.value(event)) return;
    this.patchSelected({ [field]: Math.max(field === 'width' || field === 'height' ? 20 : -16000, Math.min(16000, Math.round(number))) });
  }
  updateCanvas(field: 'width' | 'height', event: Event): void {
    const number = Number(this.value(event)); if (!Number.isFinite(number) || number < 100 || number > 7680) return;
    if (this.designDraft()) this.designDraft.update(d => d ? { ...d, [field]: Math.round(number) } : d);
    else this.updateScene({ [field]: Math.round(number) });
    this.saved.set(false);
  }
  rename(event: Event): void {
    const name = this.value(event).trim().slice(0,80); if (!name) return;
    if (this.designDraft()) this.designDraft.update(d => d ? { ...d, name } : d); else this.updateScene({ name });
    this.saved.set(false);
  }
  toggleVisibility(id: string): void { const w = this.widgets().find(w => w.id === id); if(w) this.patch(id,{visible:!w.visible}); }
  toggleLock(id: string): void { const w = this.widgets().find(w => w.id === id); if(w) this.patch(id,{locked:!w.locked}); }
  duplicateSelected(): void {
    const w = this.selected(); if(!w) return;
    const copy = { ...clone(w), id:this.id(w.kind), x:w.x+30,y:w.y+30,locked:false };
    this.updateWidgets(all=>[...all,copy]); this.select(copy.id);
  }
  deleteSelected(): void { this.updateWidgets(all=>all.filter(w=>w.id!==this.selectedId())); this.selectedId.set(this.widgets().at(-1)?.id ?? null); }
  moveLayer(direction: -1 | 1): void {
    const all=[...this.widgets()], index=all.findIndex(w=>w.id===this.selectedId()), next=index+direction;
    if(index<0||next<0||next>=all.length) return;
    [all[index],all[next]]=[all[next],all[index]]; this.updateWidgets(()=>all);
  }
  switchScene(event: Event): void { this.resetSimulation(); this.sceneId.set(this.value(event)); this.selectedId.set(this.widgets()[0]?.id ?? null); this.saved.set(false); }
  newScene(): void {
    const scene=makeScene(this.id('overlay'),this.t('newOverlay'),this.designs()[0].id); scene.widgets=[];
    this.scenes.update(all=>[...all,scene]); this.sceneId.set(scene.id); this.selectedId.set(null); this.resetSimulation(); this.saved.set(false);
  }
  openDesign(id?: string): void {
    const design=this.designs().find(d=>d.id===id) ?? makeDesign(this.id('design'),this.t('newDesign'));
    this.designDraft.set(clone(design)); this.designEvent.set('follow'); this.libraryOpen.set(false); this.panel.set('canvas'); this.selectedId.set(this.widgets()[1]?.id ?? null); this.saved.set(false);
  }
  closeDesign(): void { if (!this.saveDesign()) return; this.designDraft.set(null); this.selectedId.set('alert-1'); this.previewDesign.set(false); this.saved.set(false); }
  setDesignEvent(event: AlertEvent): void { this.stopPointer(); this.designEvent.set(event); this.selectedId.set(this.widgets()[1]?.id ?? null); }
  saveDesign(asCopy=false): boolean {
    const draft=this.designDraft(); if(!draft) return false;
    const saved={...clone(draft),id:asCopy?this.id('design'):draft.id,name:asCopy?`${draft.name} · ${this.t('copy')}`:draft.name,revision:asCopy?1:draft.revision+1};
    this.designs.update(all=>all.some(d=>d.id===saved.id)?all.map(d=>d.id===saved.id?saved:d):[...all,saved]);
    this.designDraft.set(clone(saved)); if (!this.persist()) return false; this.notice.set('designSaved'); return true;
  }
  useDesign(id: string): void { this.libraryOpen.set(false); this.addWidget('alert'); this.patchSelected({designId:id}); this.panel.set('properties'); }
  designFor(widget: OverlayWidget): AlertDesign | undefined { return this.designs().find(d=>d.id===widget.designId); }
  usage(id: string): number { return this.scenes().filter(s=>s.widgets.some(w=>w.designId===id)).length; }
  toggleEvent(event: AlertEvent): void { const events=this.selected()?.events??[]; this.patchSelected({events:events.includes(event)?events.filter(e=>e!==event):[...events,event]}); }
  toggleWait(kind: EventKind): void { const wait=this.scene().waitFor; this.updateScene({waitFor:wait.includes(kind)?wait.filter(e=>e!==kind):[...wait,kind]}); }
  updateDuration(event: Event): void {
    const value=Number(this.value(event)); if(!Number.isFinite(value)) return;
    this.designDraft.update(d=>d?{...d,events:{...d.events,[this.designEvent()]:{...d.events[this.designEvent()],duration:Math.max(1,Math.min(60,value))}}}:d); this.saved.set(false);
  }
  renderText(text='$(user)'): string { return text.replaceAll('$(user)',this.sampleUser()).replaceAll('$(amount)',this.sampleAmount()); }
  alertLayout(widget: OverlayWidget): OverlayWidget[] { return this.designFor(widget)?.events[this.eventFor(widget)].widgets ?? []; }
  eventFor(widget: OverlayWidget): AlertEvent {
    const playing=[this.active(),...this.parallel()].find(e=>e&&widget.events?.includes(e.kind as AlertEvent));
    return playing?.kind as AlertEvent ?? widget.events?.[0] ?? 'follow';
  }
  isPlaying(widget: OverlayWidget): boolean {
    return this.designDraft()?this.previewDesign():[this.active(),...this.parallel()].some(e=>e&&(widget.kind===e.kind || widget.kind==='alert'&&widget.events?.includes(e.kind as AlertEvent)));
  }
  previewWidget(kind: EventKind): void {
    const event={id:this.nextId++,kind};
    if(this.scene().waitFor.includes(kind)){ this.queue.update(q=>[...q,event]); this.runNext(); }
    else { this.parallel.update(q=>[...q,event]); this.later(()=>this.parallel.update(q=>q.filter(e=>e.id!==event.id)),2500); }
  }
  private runNext(): void {
    if(this.active()||!this.queue().length) return;
    const [event,...rest]=this.queue(); this.queue.set(rest); this.active.set(event);
    this.queueTimer=this.later(()=>{this.active.set(null);this.runNext();},2500);
  }
  failMedia(): void {
    if(!this.active()) return;
    if(this.queueTimer){clearTimeout(this.queueTimer);this.timers.delete(this.queueTimer);}
    this.active.set(null); this.notice.set('mediaReleased'); this.runNext();
  }
  testDesign(): void { this.previewDesign.set(true); this.later(()=>this.previewDesign.set(false),(this.designDraft()?.events[this.designEvent()].duration??5)*1000); }
  private resetSimulation(): void { this.timers.forEach(t=>clearTimeout(t));this.timers.clear();this.active.set(null);this.parallel.set([]);this.queue.set([]); }
  publish(): void {
    const scene=this.scene(); this.updateScene({revision:scene.revision+1,published:clone({width:scene.width,height:scene.height,widgets:scene.widgets,waitFor:scene.waitFor,designs:this.designs().filter(d=>scene.widgets.some(w=>w.designId===d.id))})});
    if (this.persist()) this.notice.set('publishedNotice');
  }
  regenerateUrl(): void { this.updateScene({publicId:`mock-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`});this.notice.set('urlRegenerated'); }
  saveDraft(): void { if(this.designDraft())this.saveDesign();else this.persist(); }
  private persist(): boolean {
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify({version:2,scenes:this.scenes(),designs:this.designs(),sceneId:this.sceneId()}));this.saved.set(true);return true;}
    catch{this.saved.set(false);this.notice.set('storageError');return false;}
  }
  resetDraft(): void {
    this.resetSimulation();this.seed();this.sceneId.set('gameplay');this.designDraft.set(null);this.selectedId.set('alert-1');this.saved.set(false);
    try{localStorage.removeItem(STORAGE_KEY);}catch{this.notice.set('storageError');}
  }
  private restoreDraft(): void {
    try{
      const stored=localStorage.getItem(STORAGE_KEY);if(!stored)return;
      const value=JSON.parse(stored);
      if(value.version!==2||!Array.isArray(value.scenes)||!value.scenes.length||!Array.isArray(value.designs)||!value.designs.length)return;
      const box=(s: {width:number;height:number})=>Number.isFinite(s.width)&&s.width>=100&&s.width<=7680&&Number.isFinite(s.height)&&s.height>=100&&s.height<=7680;
      const widgets=(items:unknown)=>Array.isArray(items)&&items.every(w=>w&&typeof w.id==='string'&&['tts','trigger','clip','alert','text','image','video','animation'].includes(w.kind)&&['x','y','width','height'].every(k=>Number.isFinite(w[k]))&&typeof w.visible==='boolean'&&typeof w.locked==='boolean'&&(w.events===undefined||Array.isArray(w.events)&&w.events.every((e:AlertEvent)=>ALERT_EVENTS.includes(e)))&&(w.text===undefined||typeof w.text==='string'));
      if(!value.designs.every((d:AlertDesign)=>d&&typeof d.id==='string'&&typeof d.name==='string'&&box(d)&&ALERT_EVENTS.every(e=>d.events?.[e]&&Number.isFinite(d.events[e].duration)&&widgets(d.events[e].widgets))))return;
      if(!value.scenes.every((s:OverlayScene)=>s&&typeof s.id==='string'&&typeof s.name==='string'&&typeof s.publicId==='string'&&box(s)&&widgets(s.widgets)&&Array.isArray(s.waitFor)&&s.waitFor.every(e=>EVENT_KINDS.includes(e))&&s.widgets.every(w=>w.kind!=='alert'||value.designs.some((d:AlertDesign)=>d.id===w.designId))))return;
      this.scenes.set(value.scenes);this.designs.set(value.designs);this.sceneId.set(value.scenes.some((s:OverlayScene)=>s.id===value.sceneId)?value.sceneId:value.scenes[0].id);this.saved.set(true);
    }catch{ /* Ignore incompatible local drafts. */ }
  }
  private round(value:number):number{return this.snap()?Math.round(value/10)*10:Math.round(value);}
}
