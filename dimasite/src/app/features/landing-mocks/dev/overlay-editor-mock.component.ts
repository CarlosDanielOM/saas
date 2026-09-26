import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { SessionAuthService } from '../../../services/session-auth.service';
import { OverlayTestMediaService, TestChannel, TestMedia } from './overlay-test-media.service';
import { OverlayTestPlayerComponent } from './overlay-test-player.component';
import { RouterLink } from '@angular/router';
import { ArrowLeft, Bell, Clapperboard, Copy, Eye, EyeOff, Grip, Image, Layers3, LockKeyhole, Moon, Play, Plus, RotateCcw, Save, Sparkles, Sun, Trash2, Type, Volume2, Zap, LucideAngularModule } from 'lucide-angular';
import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';
import { ALERT_EVENTS, EVENT_KINDS, STORAGE_KEY, AlertDesign, AlertEvent, EventKind, OverlayScene, OverlayWidget, WidgetKind, clone, makeDesign, makeScene } from './overlay-mock.model';

type Dimension = 'x' | 'y' | 'width' | 'height';
interface PointerSession { id: string; action: 'move' | 'resize'; startX: number; startY: number; original: OverlayWidget; canvas: DOMRect }
interface MockEvent { id: number; kind: EventKind; channel?: TestChannel; targets?: string[]; media?: TestMedia }
interface MediaJob { cancel?: () => void; timer?: ReturnType<typeof setTimeout>; pending: Set<string>; started: Set<string> }

@Component({
  selector: 'app-overlay-editor-mock', imports: [RouterLink, LucideAngularModule, OverlayTestPlayerComponent], providers: [OverlayTestMediaService],
  templateUrl: './overlay-editor-mock.component.html', styleUrl: './overlay-editor-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:pointermove)': 'onPointerMove($event)', '(window:pointerup)': 'stopPointer()', '(window:pointercancel)': 'stopPointer()' }
})
export class OverlayEditorMockComponent {
  readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  readonly auth = inject(SessionAuthService);
  private readonly testMedia = inject(OverlayTestMediaService);
  private readonly jobs = new Map<number, MediaJob>();
  private readonly channelChoice = signal('');
  readonly testChannels = computed<TestChannel[]>(() => {
    const session = this.auth.session();
    if (!session) return [];
    const own = { id: session.appUser.twitch_user_id, login: session.twitchUser.login };
    return [own, ...session.appUser.administrating.filter(c => c.channelID !== own.id).map(c => ({ id: c.channelID, login: c.channelName }))];
  });
  readonly testChannel = computed(() => {
    const channels = this.testChannels();
    const selected = this.channelChoice() || this.auth.getLastViewedStreamerSnapshot();
    return channels.find(c => c.id === selected || c.login === selected) ?? channels[0] ?? null;
  });
  private pointer: PointerSession | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
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
    inject(DestroyRef).onDestroy(() => this.resetSimulation());
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
    this.reconcileTests();
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
    this.resetSimulation();
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
  changeTestChannel(event: Event): void { this.resetSimulation(); this.channelChoice.set(this.value(event)); }
  testBusy(kind: EventKind): boolean {
    return (kind === 'clip' || kind === 'trigger') && [...this.queue(), this.active(), ...this.parallel()].some(e => e?.kind === kind);
  }
  mediaEvents(widget: OverlayWidget): MockEvent[] {
    if (this.designDraft()) return [];
    return [this.active(), ...this.parallel()].filter((e): e is MockEvent => Boolean(e?.media && e.targets?.includes(widget.id)));
  }
  mediaMuted(event: MockEvent, widgetId: string): boolean {
    const firstVisible = event.targets?.find(id => this.widgets().some(w => w.id === id && w.visible));
    return firstVisible !== widgetId;
  }
  previewWidget(kind: EventKind): void {
    if (this.testBusy(kind)) return;
    const real = kind === 'clip' || kind === 'trigger';
    const channel = this.testChannel();
    if (real && (!this.auth.hasValidSession() || !channel)) { this.notice.set('testSignIn'); return; }
    const targets = this.widgets().filter(w => w.visible && w.kind === kind).map(w => w.id);
    if (real && !targets.length) { this.notice.set('testAddSource'); return; }
    const event: MockEvent = { id: this.nextId++, kind, ...(real && channel ? { channel: { ...channel }, targets } : {}) };
    if (this.scene().waitFor.includes(kind)) { this.queue.update(q => [...q, event]); this.runNext(); }
    else { this.parallel.update(q => [...q, event]); this.startEvent(event); }
  }
  private runNext(): void {
    if (this.active() || !this.queue().length) return;
    const [event, ...rest] = this.queue(); this.queue.set(rest); this.active.set(event); this.startEvent(event);
  }
  private startEvent(event: MockEvent): void {
    if (!event.channel) { this.later(() => this.finishEvent(event.id), 2500); return; }
    const visible = new Set(this.widgets().filter(w => w.visible).map(w => w.id));
    const targets = event.targets?.filter(id => visible.has(id)) ?? [];
    if (!targets.length) { this.finishEvent(event.id); return; }
    const job: MediaJob = { pending: new Set(targets), started: new Set() };
    this.jobs.set(event.id, job);
    this.notice.set(event.kind === 'clip' ? 'clipLoading' : 'triggerLoading');
    if (event.kind === 'clip') {
      job.cancel = this.testMedia.startClip(event.channel, media => this.showMedia(event.id, media), () => {
        if (this.jobs.has(event.id)) { this.notice.set('clipTestError'); this.finishEvent(event.id); }
      });
    } else {
      const request: Subscription = this.testMedia.randomTrigger(event.channel).subscribe({
        next: media => {
          if (!this.jobs.has(event.id)) return;
          if (media) this.showMedia(event.id, media);
          else { this.notice.set('noTriggers'); job.timer = this.later(() => this.finishEvent(event.id), 2500); }
        },
        error: () => { if (this.jobs.has(event.id)) { this.notice.set('triggerTestError'); this.finishEvent(event.id); } }
      });
      job.cancel = () => request.unsubscribe();
    }
  }
  private showMedia(id: number, media: TestMedia): void {
    const job = this.jobs.get(id); if (!job) return;
    const patch = (e: MockEvent) => e.id === id ? { ...e, media } : e;
    this.active.update(e => e ? patch(e) : e); this.parallel.update(all => all.map(patch));
    this.notice.set('mediaReady');
    // Loading/autoplay failures must not hold the scheduler forever.
    job.timer = this.later(() => { this.notice.set('testPlaybackError'); this.finishEvent(id); }, 30000);
  }
  mediaStarted(id: number, widgetId: string, actualDuration?: number): void {
    const job = this.jobs.get(id); if (!job || job.started.has(widgetId)) return;
    job.started.add(widgetId);
    if (job.started.size !== 1) return;
    if (job.timer) { clearTimeout(job.timer); this.timers.delete(job.timer); }
    const event = [this.active(), ...this.parallel()].find(e => e?.id === id);
    const duration = event?.media?.type === 'image' ? 5 : event?.media?.duration ?? (Number.isFinite(actualDuration) && actualDuration! > 0 ? actualDuration! + 15 : undefined);
    // Clips use the clip module's 30s maximum; other media finishes on ended/error.
    job.timer = this.later(() => this.finishEvent(id), duration ? duration * 1000 : 300000);
  }
  mediaFinished(id: number, widgetId: string, error = false): void {
    const job = this.jobs.get(id); if (!job || !job.pending.delete(widgetId)) return;
    if (error) this.notice.set('testPlaybackError');
    if (!job.pending.size) this.finishEvent(id);
  }
  private finishEvent(id: number): void {
    const job = this.jobs.get(id);
    this.jobs.delete(id);
    if (job?.timer) { clearTimeout(job.timer); this.timers.delete(job.timer); }
    job?.cancel?.();
    this.parallel.update(all => all.filter(e => e.id !== id));
    if (this.active()?.id === id) { this.active.set(null); this.runNext(); }
  }
  private reconcileTests(): void {
    const visible = new Set(this.widgets().filter(w => w.visible).map(w => w.id));
    for (const [id, job] of this.jobs) {
      for (const target of job.pending) if (!visible.has(target)) job.pending.delete(target);
      if (!job.pending.size) this.finishEvent(id);
    }
  }
  failMedia(): void {
    const active = this.active(); if (!active) return;
    this.notice.set('mediaReleased'); this.finishEvent(active.id);
  }
  testDesign(): void { this.previewDesign.set(true); this.later(()=>this.previewDesign.set(false),(this.designDraft()?.events[this.designEvent()].duration??5)*1000); }
  private resetSimulation(): void { this.jobs.forEach(job => job.cancel?.()); this.jobs.clear(); this.timers.forEach(t=>clearTimeout(t));this.timers.clear();this.active.set(null);this.parallel.set([]);this.queue.set([]); }
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
