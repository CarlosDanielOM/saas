import { OverlayQueueComponent } from './overlay-queue.component';
import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, computed, effect, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { SessionAuthService } from '../../services/session-auth.service';
import { OverlayTestMediaService, TestChannel, TestMedia } from '../landing-mocks/dev/overlay-test-media.service';
import { OverlayClipComponent } from './overlay-clip.component';
import { OverlayTriggerFilterComponent } from './overlay-trigger-filter.component';
import { ClipsService } from '../clips/clips.service';
import { CLIP_DESIGN_VARIANTS, type ClipDesignVariant } from '../clips/clips.model';
import { OverlayMediaComponent } from './overlay-media.component';
import { OverlayLayerComponent } from './overlay-layer.component';
import { clipPlaybackLimit } from './overlay-clip-motion';
import { AssetLibraryDialogComponent } from '../../shared/asset-library/asset-library-dialog.component';
import type { DesignAsset } from '../../shared/asset-library/asset-library.service';
import { OverlayConnectionsComponent } from './overlay-connections.component';
import { OverlayApi, StudioState } from './overlay-api.service';
import { OverlayDraftStorage, type LocalOverlayDraft, type OverlayRecovery } from './overlay-draft-storage.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { firstValueFrom } from 'rxjs';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ArrowLeft, Bell, Clapperboard, Copy, Eye, EyeOff, Grip, Image, Layers3, LockKeyhole, Moon, Play, Plus, RotateCcw, Save, Sparkles, Sun, Trash2, Type, Volume2, Zap, LucideAngularModule } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { ThemeService } from '../../services/theme.service';
import { ALERT_EVENTS, EVENT_KINDS, AlertDesign, AlertEvent, EventKind, OverlayScene, OverlayWidget, WidgetKind, clone, makeDesign, makeScene, matchesTrigger } from './overlay.model';

type Dimension = 'x' | 'y' | 'width' | 'height';
interface PointerSession { id: string; action: 'move' | 'resize'; startX: number; startY: number; original: OverlayWidget; canvas: DOMRect }
interface MockEvent { id: number; kind: EventKind; channel?: TestChannel; targets?: string[]; media?: TestMedia }
interface MediaJob { cancel?: () => void; timer?: ReturnType<typeof setTimeout>; pending: Set<string>; started: Set<string> }

@Component({
  selector: 'app-overlay-editor', imports: [OverlayQueueComponent, RouterLink, LucideAngularModule, OverlayMediaComponent, OverlayLayerComponent, AssetLibraryDialogComponent, OverlayConnectionsComponent, OverlayClipComponent, OverlayTriggerFilterComponent], providers: [OverlayTestMediaService, OverlayDraftStorage],
  templateUrl: './overlay-editor.component.html', styleUrl: './overlay-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:pointermove)': 'onPointerMove($event)', '(window:pointerup)': 'stopPointer()', '(window:pointercancel)': 'stopPointer()', '(window:beforeunload)': 'protectDraft($event)', '(window:pagehide)': 'saveLocalRecovery()' }
})
export class OverlayEditorComponent {
  private readonly api = inject(OverlayApi);
  readonly streamer = getRouteParam(inject(ActivatedRoute), 'streamer') ?? '';
  readonly pro = computed(() => this.auth.getPlanTierForStreamer(this.streamer) === 'pro');
  readonly owner = computed(() => this.auth.session()?.twitchUser.login.toLowerCase() === this.streamer.toLowerCase());
  readonly loading = signal(true);
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly astError = signal('');
  readonly rendered = signal<Record<string, string>>({});
  readonly confirmRotate = signal(false);
  readonly confirmDelete = signal(false);
  readonly recovery = signal<OverlayRecovery | null>(null);
  readonly storageError = signal(false);
  private readonly draftStorage = inject(OverlayDraftStorage);
  private readonly savedDocument = signal<string | null>(null);
  private readonly recovered = signal(false);
  private consumedRecovery: OverlayRecovery | null = null;
  private revision = 0;
  channel = '';
  readonly assetPickerOpen = signal(false);
  readonly assetKind = computed(() => this.selected()?.kind === 'video' ? 'video' as const : 'image' as const);
  private disposed = false;
  readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  readonly auth = inject(SessionAuthService);
  private readonly clips = inject(ClipsService);
  readonly clipDesigns = computed(() => this.clips.getDesigns({ channelID: this.channel, login: this.streamer, planTier: this.auth.getPlanTierForStreamer(this.streamer) }));
  private readonly testMedia = inject(OverlayTestMediaService);
  private readonly jobs = new Map<number, MediaJob>();
  private readonly channelChoice = signal('');
  readonly testChannels = computed<TestChannel[]>(() => {
    const session = this.auth.session();
    if (!session) return [];
    const own = { id: session.appUser.twitch_user_id, login: session.twitchUser.login };
    return [own];
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
  readonly dirty = computed(() => {
    if (!this.loaded()) return false;
    if (this.recovered() || this.documentFingerprint() !== this.savedDocument()) return true;
    const draft = this.designDraft();
    return !!draft && this.designFingerprint(draft) !== this.designFingerprint(this.designs().find(d => d.id === draft.id));
  });

  constructor() {
    this.seed();
    afterNextRender(() => void this.loadSaved());
    effect(onCleanup => {
      if (!this.loaded() || !this.channel || this.loading()) return;
      // A pristine editor must leave the offered recovery copy intact until the user chooses.
      const dirty = this.dirty(), offered = this.recovery();
      const draft = dirty ? this.localDraft() : null;
      const timer = setTimeout(() => {
        if (draft) this.writeRecovery(draft);
        else if (!offered) this.clearRecovery();
      }, 250);
      onCleanup(() => clearTimeout(timer));
    });
    effect(onCleanup => {
      const ownTexts = this.widgets().filter(w => w.kind === 'text').map(w => w.text || '');
      const designTexts = this.designs().flatMap(d => Object.values(d.events).flatMap(e => e.widgets.filter(w => w.kind === 'text').map(w => w.text || '')));
      const texts = [...new Set([...ownTexts, ...designTexts])].slice(0, 100);
      const kind = this.designEvent(), user = this.sampleUser(), amount = this.sampleAmount();
      this.loading();
      if (!this.channel || !texts.length) return;
      let valid = true;
      const timer = setTimeout(() => {
        void this.api.render(this.channel, texts, kind, user, amount).then(values => {
          if (valid) { this.rendered.set(Object.fromEntries(texts.map((text, i) => [text, values[i]]))); this.astError.set(''); }
        }).catch(e => { if (valid) this.astError.set(e?.error?.message || this.t('astFailed')); });
      }, 200);
      onCleanup(() => { valid = false; clearTimeout(timer); });
    });
    inject(DestroyRef).onDestroy(() => { this.flushRecovery(); this.disposed = true; this.resetSimulation(); });
  }
  t(key: string, params?: Record<string, string | number>): string {
    this.language.currentLanguage(); return this.language.translate(`overlayStudio.${key}`, params);
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
  selectClipDesign(event: Event): void {
    const design = this.value(event) as ClipDesignVariant;
    if (this.selected()?.kind !== 'clip' || !CLIP_DESIGN_VARIANTS.includes(design) || this.clipDesigns().find(d => d.variant === design)?.isLocked !== false) return;
    this.patchSelected({ clipDesign: design });
  }
  patchSelected(changes: Partial<OverlayWidget>): void { const id = this.selectedId(); if (id) this.patch(id, changes); }
  useAsset(asset: DesignAsset): void {
    if (this.selected()?.kind === asset.kind) this.patchSelected({ assetId: asset.id, mediaUrl: undefined });
    this.assetPickerOpen.set(false);
  }
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
    if (this.busy() || widget.locked || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const canvas = (event.currentTarget as HTMLElement).closest('.stage')?.getBoundingClientRect();
    if (canvas) { this.select(widget.id); this.pointer = { id: widget.id, action, startX: event.clientX, startY: event.clientY, original: { ...widget }, canvas }; }
  }
  onPointerMove(event: PointerEvent): void {
    if (this.busy() || this.loading()) return;
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
  switchScene(event: Event): void { this.confirmRotate.set(false); this.confirmDelete.set(false); this.resetSimulation(); this.sceneId.set(this.value(event)); this.selectedId.set(this.widgets()[0]?.id ?? null); this.saved.set(false); }
  newScene(): void {
    const scene=makeScene(this.id('overlay'),this.t('newOverlay'),this.designs()[0].id); scene.widgets=[]; scene.publicId='';
    this.scenes.update(all=>[...all,scene]); this.sceneId.set(scene.id); this.selectedId.set(null); this.resetSimulation(); this.saved.set(false);
  }
  openDesign(id?: string): void {
    if (this.designDraft() && this.dirty() && !window.confirm(this.t('discardDesign'))) return;
    this.resetSimulation();
    const design=this.designs().find(d=>d.id===id) ?? makeDesign(this.id('design'),this.t('newDesign'));
    this.designDraft.set(clone(design)); this.designEvent.set('follow'); this.libraryOpen.set(false); this.panel.set('canvas'); this.selectedId.set(this.widgets()[1]?.id ?? this.widgets()[0]?.id ?? null); this.saved.set(false);
  }
  async closeDesign(): Promise<void> { if (!await this.saveDesign()) return; this.designDraft.set(null); this.selectedId.set('alert-1'); this.previewDesign.set(false); this.saved.set(false); }
  setDesignEvent(event: AlertEvent): void { this.stopPointer(); this.designEvent.set(event); this.selectedId.set(this.widgets()[1]?.id ?? this.widgets()[0]?.id ?? null); }
  async saveDesign(asCopy=false): Promise<boolean> {
    const draft=this.designDraft(); if(!draft) return false;
    const saved={...clone(draft),id:asCopy?this.id('design'):draft.id,name:asCopy?`${draft.name} · ${this.t('copy')}`:draft.name,revision:asCopy?1:draft.revision+1};
    this.designs.update(all=>all.some(d=>d.id===saved.id)?all.map(d=>d.id===saved.id?saved:d):[...all,saved]);
    this.designDraft.set(clone(saved)); if (!await this.persist()) return false; this.notice.set('designSaved'); return true;
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
  renderText(text='$(user)'): string { return this.rendered()[text] ?? text; }
  alertLayout(widget: OverlayWidget): OverlayWidget[] { return this.designFor(widget)?.events[this.eventFor(widget)].widgets ?? []; }
  eventFor(widget: OverlayWidget): AlertEvent {
    const playing=[this.active(),...this.parallel()].find(e=>e&&widget.events?.includes(e.kind as AlertEvent));
    return playing?.kind as AlertEvent ?? widget.events?.[0] ?? 'follow';
  }
  isPlaying(widget: OverlayWidget): boolean {
    return this.designDraft()?this.previewDesign():[this.active(),...this.parallel()].some(e=>e&&(widget.kind===e.kind && (!e.targets || e.targets.includes(widget.id)) || widget.kind==='alert'&&widget.events?.includes(e.kind as AlertEvent)));
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
    if (ALERT_EVENTS.includes(kind as AlertEvent)) this.designEvent.set(kind as AlertEvent);
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
      const widgets = this.widgets().filter(w => targets.includes(w.id));
      const triggerIds = widgets.some(w => w.triggerIds === undefined) ? undefined : [...new Set(widgets.flatMap(w => w.triggerIds ?? []))];
      const request: Subscription = this.testMedia.randomTrigger(event.channel, triggerIds).subscribe({
        next: media => {
          if (!this.jobs.has(event.id)) return;
          if (media) this.showMedia(event.id, media);
          else { this.notice.set(triggerIds === undefined ? 'noTriggers' : 'noMatchingTriggers'); job.timer = this.later(() => this.finishEvent(event.id), 2500); }
        },
        error: () => { if (this.jobs.has(event.id)) { this.notice.set('triggerTestError'); this.finishEvent(event.id); } }
      });
      job.cancel = () => request.unsubscribe();
    }
  }
  private showMedia(id: number, media: TestMedia): void {
    const job = this.jobs.get(id); if (!job) return;
    const event = [this.active(), ...this.parallel()].find(e => e?.id === id);
    const targets = event?.kind === 'trigger' ? event.targets?.filter(target => this.widgets().some(w => w.id === target && matchesTrigger(w, media.triggerId))) : event?.targets;
    if (!targets?.length) { this.notice.set('noMatchingTriggers'); this.finishEvent(id); return; }
    job.pending = new Set(targets);
    const patch = (e: MockEvent) => e.id === id ? { ...e, targets, media } : e;
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
    const duration = event?.kind === 'clip' ? clipPlaybackLimit(event.media, actualDuration) + 4
      : event?.media?.type === 'image' ? 5 : event?.media?.duration ?? (Number.isFinite(actualDuration) && actualDuration! > 0 ? actualDuration! + 15 : undefined);
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
  async publish(): Promise<void> {
    if (!await this.persist()) return;
    this.busy.set(true);
    try { this.accept(await this.api.action(this.channel, this.sceneId(), this.revision, 'publish')); this.notice.set('publishedNotice'); }
    catch (e) { this.report(e); } finally { this.busy.set(false); }
  }
  async regenerateUrl(): Promise<void> {
    if (!this.confirmRotate()) { this.confirmRotate.set(true); return; }
    this.busy.set(true);
    try { const state = await this.api.action(this.channel, this.sceneId(), this.revision, 'rotate'); this.revision = state.revision; const remote = state.scenes.find(s => s.id === this.sceneId())!; this.updateScene({ publicId: remote.publicId }); this.notice.set('urlRegenerated'); this.confirmRotate.set(false); }
    catch (e) { this.report(e); } finally { this.busy.set(false); }
  }
  async saveDraft(): Promise<void> { if (this.designDraft()) await this.saveDesign(); else await this.persist(); }
  private async persist(): Promise<boolean> {
    if (this.busy() || !this.channel) return false;
    this.busy.set(true); this.error.set('');
    try { this.accept(await this.api.save(this.channel, { schemaVersion: 1, revision: this.revision, scenes: this.scenes(), designs: this.designs() })); return true; }
    catch (e) { this.report(e); return false; } finally { this.busy.set(false); }
  }
  private accept(state: StudioState, preserveRecovery = false): void {
    if (this.disposed) return;
    this.revision = state.revision; this.scenes.set(state.scenes); this.designs.set(state.designs);
    if (!state.scenes.some(s => s.id === this.sceneId())) this.sceneId.set(state.scenes[0].id);
    this.loaded.set(true);
    this.savedDocument.set(this.documentFingerprint());
    this.recovered.set(false);
    if (!preserveRecovery) { this.recovery.set(null); this.clearRecovery(); }
    this.saved.set(true);
  }
  private report(e: unknown): void {
    const error = e as { status?: number; error?: { message?: string } };
    this.error.set(error.status === 409 ? this.t('conflict') : error.error?.message || this.t('saveFailed')); this.saved.set(false);
  }
  async resetDraft(): Promise<void> {
    if (this.busy() || this.loading()) return;
    if (this.dirty() && !window.confirm(this.t('discardReload'))) return;
    await this.loadSaved();
  }
  private async loadSaved(): Promise<void> {
    const initial = !this.loaded();
    this.loading.set(true); this.error.set(''); this.stopPointer();
    try {
      if (this.pro() && this.owner()) {
        this.channel = (await firstValueFrom(this.auth.resolveChannelID(this.streamer))) || '';
        if (!this.channel) throw new Error('Channel unavailable');
        if (initial) this.findRecovery();
        const state = await this.api.load(this.channel);
        if (this.disposed) return;
        // Replace local work only after the server has returned a complete saved draft.
        this.resetSimulation(); this.designDraft.set(null);
        this.accept(state, initial);
        this.selectedId.set(this.widgets()[0]?.id ?? null);
      }
    } catch (e) { this.report(e); } finally { this.loading.set(false); }
  }

  canLeave(): boolean {
    if (this.busy() || this.loading() && this.loaded()) return false;
    this.flushRecovery();
    return !this.dirty() || window.confirm(this.t('leaveUnsaved'));
  }
  protectDraft(event: BeforeUnloadEvent): void {
    this.flushRecovery();
    if (this.dirty()) { event.preventDefault(); event.returnValue = ''; }
  }
  private documentFingerprint(): string {
    return JSON.stringify({ scenes: this.scenes().map(({ publicId: _publicId, published: _published, revision: _revision, ...draft }) => draft), designs: this.designs().map(({ revision: _revision, ...draft }) => draft) });
  }
  private designFingerprint(design?: AlertDesign): string {
    if (!design) return '';
    const { revision: _revision, ...draft } = design;
    return JSON.stringify(draft);
  }
  private localDraft(): LocalOverlayDraft {
    return { schemaVersion: 1, channelID: this.channel, updatedAt: Date.now(), revision: this.revision,
      scenes: this.scenes().map(({ publicId: _publicId, published: _published, revision: _revision, ...draft }) => draft),
      designs: this.designs(), designDraft: this.designDraft(), sceneId: this.sceneId(), designEvent: this.designEvent(), selectedId: this.selectedId() };
  }
  private writeRecovery(draft: LocalOverlayDraft): void {
    try { this.draftStorage.write(this.channel, draft); this.storageError.set(false); }
    catch { this.storageError.set(true); }
  }
  saveLocalRecovery(): void { this.flushRecovery(); }
  private flushRecovery(): void {
    if (!this.channel || !this.loaded()) return;
    if (this.dirty()) this.writeRecovery(this.localDraft());
    else if (!this.recovery()) this.clearRecovery();
  }
  private clearRecovery(): void {
    try {
      // Loading a saved draft must not remove a recovery copy that hasn't been offered yet.
      if (this.recovery()) return;
      this.draftStorage.clear(this.channel);
      if (this.consumedRecovery) this.draftStorage.discard(this.consumedRecovery);
      this.consumedRecovery = null; this.storageError.set(false);
    } catch { this.storageError.set(true); }
  }
  private findRecovery(): void {
    try { this.recovery.set(this.draftStorage.find(this.channel)); }
    catch { this.storageError.set(true); }
  }
  restoreRecovery(): void {
    const recovery = this.recovery();
    if (!recovery || this.busy() || this.loading()) return;
    if (this.dirty() && !window.confirm(this.t('discardRestore'))) return;
    const draft = clone(recovery.draft), remote = this.scenes(), currentRevision = this.revision;
    this.resetSimulation(); this.stopPointer();
    this.scenes.set(draft.scenes.map(scene => {
      const saved = this.loaded() ? remote.find(s => s.id === scene.id) : undefined;
      return { ...scene, publicId: saved?.publicId ?? '', revision: saved?.revision ?? 0, ...(saved?.published ? { published: saved.published } : {}) };
    }));
    this.designs.set(draft.designs); this.designDraft.set(draft.designDraft); this.sceneId.set(draft.sceneId);
    this.designEvent.set(draft.designEvent); this.selectedId.set(draft.selectedId); this.revision = draft.revision;
    this.loaded.set(true); this.recovered.set(true); this.saved.set(false);
    this.consumedRecovery = recovery; this.recovery.set(null);
    this.error.set(draft.revision !== currentRevision ? this.t('conflict') : ''); this.notice.set('draftRestored');
    this.flushRecovery();
  }
  discardRecovery(): void {
    const recovery = this.recovery(); if (!recovery) return;
    try { this.draftStorage.discard(recovery); this.recovery.set(null); this.storageError.set(false); }
    catch { this.storageError.set(true); }
  }
  async copyUrl(): Promise<void> { try { await navigator.clipboard.writeText(this.overlayUrl()); this.notice.set('urlCopied'); } catch { this.notice.set('copyFailed'); } }
  overlayUrl(): string { return `https://domdimabot.com/overlays/${this.scene().publicId}`; }
  async deleteScene(): Promise<void> {
    if (this.scenes().length < 2) return;
    if (!this.confirmDelete()) { this.confirmDelete.set(true); return; }
    this.scenes.update(all => all.filter(s => s.id !== this.sceneId())); this.sceneId.set(this.scenes()[0].id); this.resetSimulation();
    if (await this.persist()) this.confirmDelete.set(false);
  }
  selectAlertKind(event: Event): void { const kind = this.value(event) as AlertEvent; if (ALERT_EVENTS.includes(kind)) this.designEvent.set(kind); }
  async testLiveAlert(): Promise<void> {
    try { await this.api.request('POST', `${this.channel}/test-alert`, { kind: this.designEvent() }); this.notice.set('testSent'); }
    catch(e) { this.report(e); }
  }
  private round(value:number):number{return this.snap()?Math.round(value/10)*10:Math.round(value);}
}
