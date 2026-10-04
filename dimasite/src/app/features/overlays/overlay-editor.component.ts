import { OverlayKeyframeEditorComponent } from './overlay-keyframe-editor.component';
import { OverlayAppearanceComponent } from './overlay-appearance.component';
import { OverlayVariantsComponent } from './overlay-variants.component';
import { matchingVariant, selectAlertLayout, designLayouts, type AlertLayout, type AlertVariant } from './overlay.model';
import { OverlayTimelineComponent, type TimelineEdit } from './overlay-timeline.component';
import type { AlertTransport } from './overlay-sound.component';
import { OverlaySoundComponent } from './overlay-sound.component';
import type { AlertSound } from './overlay.model';
import { defaultMotion } from './overlay-object-motion';
import { ALERT_TRANSITIONS, ALERT_LOOPS } from './overlay.model';
import { OverlayHistory, type OverlayEditSnapshot } from './overlay-history';
import { OverlayQueueComponent } from './overlay-queue.component';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, signal } from '@angular/core';
import { SessionAuthService } from '../../services/session-auth.service';
import { OverlayTestMediaService, type TestChannel, type TestMedia } from '../landing-mocks/dev/overlay-test-media.service';
import { OverlayClipComponent } from './overlay-clip.component';
import { OverlayTriggerFilterComponent } from './overlay-trigger-filter.component';
import { ClipsService } from '../clips/clips.service';
import { CLIP_DESIGN_VARIANTS, type ClipDesignVariant } from '../clips/clips.model';
import { OverlayMediaComponent } from './overlay-media.component';
import { OverlayLayerComponent } from './overlay-layer.component';
import { clipPlaybackLimit } from './overlay-clip-motion';
import { AssetLibraryDialogComponent } from '../../shared/asset-library/asset-library-dialog.component';
import type { DesignAsset } from '../../shared/asset-library/asset-library.service';
import { OverlayConnectionsComponent, type ConnectionState } from './overlay-connections.component';
import { OverlayApi, StudioState } from './overlay-api.service';
import { OverlayDraftStorage, type LocalOverlayDraft, type OverlayRecovery } from './overlay-draft-storage.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { firstValueFrom } from 'rxjs';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AlignCenterHorizontal, AlignCenterVertical, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, ChevronDown, Clapperboard, Copy, ExternalLink, Eye, EyeOff, FlaskConical, Image, Undo2, Redo2, Layers3, LockKeyhole, LockOpen, Magnet, Monitor, Play, Plus, Radio, Settings2, Sparkles, Trash2, Type, Volume2, X, Zap, LucideAngularModule } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { ALERT_EVENTS, EVENT_KINDS, AlertDesign, AlertEvent, EventKind, OverlayScene, OverlayWidget, WidgetKind, clone, makeDesign, makeScene, matchesTrigger } from './overlay.model';

type Dimension = 'x' | 'y' | 'width' | 'height';
interface PointerSession { id: string; action: 'move' | 'resize'; startX: number; startY: number; original: OverlayWidget; canvas: DOMRect }
interface MockEvent { id: number; kind: EventKind; channel?: TestChannel; targets?: string[]; media?: TestMedia }
interface MediaJob { cancel?: () => void; timer?: ReturnType<typeof setTimeout>; pending: Set<string>; started: Set<string> }

@Component({
  selector: 'app-overlay-editor', imports: [OverlayKeyframeEditorComponent, OverlayAppearanceComponent, OverlayVariantsComponent, OverlayTimelineComponent, OverlaySoundComponent, OverlayQueueComponent, RouterLink, LucideAngularModule, OverlayMediaComponent, OverlayLayerComponent, AssetLibraryDialogComponent, OverlayConnectionsComponent, OverlayClipComponent, OverlayTriggerFilterComponent], providers: [OverlayTestMediaService, OverlayDraftStorage],
  templateUrl: './overlay-editor.component.html', styleUrl: './overlay-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:visibilitychange)': 'pauseHiddenTimeline()', '(window:pointermove)': 'onPointerMove($event)', '(window:pointerup)': 'stopPointer()', '(window:pointercancel)': 'stopPointer()', '(window:beforeunload)': 'protectDraft($event)', '(window:pagehide)': 'saveLocalRecovery()', '(window:keydown)': 'onHistoryKeydown($event)', '(window:keyup)': 'onHistoryKeyup($event)', '(focusout)': 'endHistoryGroup()' }
})
export class OverlayEditorComponent {
  private readonly api = inject(OverlayApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly streamer = getRouteParam(inject(ActivatedRoute), 'streamer') ?? '';
  readonly owner = computed(() => this.auth.session()?.twitchUser.login.toLowerCase() === this.streamer.toLowerCase());
  readonly loading = signal(true);
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly conflict = signal(false);
  private recoveryRequestId: string | null = null;
  readonly astError = signal('');
  readonly rendered = signal<Record<string, string>>({});
  readonly confirmRotate = signal(false);
  readonly liveTestKind = signal<EventKind>('tts');
  readonly liveTesting = signal(false);
  readonly confirmDelete = signal(false);
  readonly recovery = signal<OverlayRecovery | null>(null);
  readonly storageError = signal(false);
  private readonly draftStorage = inject(OverlayDraftStorage);
  private readonly savedDocument = signal<string | null>(null);
  private readonly recovered = signal(false);
  private consumedRecovery: OverlayRecovery | null = null;
  private revision = 0;
  readonly history = new OverlayHistory();
  readonly canUndo = computed(() => this.loaded() && !this.busy() && !this.loading() && this.history.undoCount() > 0);
  readonly canRedo = computed(() => this.loaded() && !this.busy() && !this.loading() && this.history.redoCount() > 0);
  private editDepth = 0;
  private serverScenes = new Map<string, OverlayScene>();
  private serverDesigns = new Map<string, AlertDesign>();
  channel = '';
  readonly assetPickerOpen = signal(false);
  readonly soundPickerOpen = signal(false);
  readonly soundPercent = computed(() => Math.round((this.alertSound()?.volume ?? 1) * 100));
  readonly alertSound = computed(() => this.editingLayout()?.sound);
  readonly previewSounds = computed(() => {
    const draft = this.designDraft();
    if (draft) { const layout = this.editingLayout()!; return (this.previewDesign() || this.timeline()) && layout.sound ? [{ key: (this.timeline() ? 'timeline-' : 'design-') + this.motionReplay(), config: layout.sound, duration: layout.duration }] : []; }
    return [this.active(), ...this.parallel()].flatMap(event => {
      if (!event || !ALERT_EVENTS.includes(event.kind as AlertEvent)) return [];
      const ids = new Set(this.widgets().filter(w => w.visible && w.kind === 'alert' && w.events?.includes(event.kind as AlertEvent)).map(w => w.designId));
      return this.designs().filter(d => ids.has(d.id)).flatMap(d => { const layout = selectAlertLayout(d, event.kind as AlertEvent, this.sampleRaw()); return layout.sound ? [{ key: event.id + ':' + d.id, config: layout.sound, duration: layout.duration }] : []; });
    });
  });
  readonly assetKind = computed(() => this.selected()?.kind === 'video' ? 'video' as const : 'image' as const);
  private disposed = false;
  readonly language = inject(LanguageService);
  readonly auth = inject(SessionAuthService);
  private readonly clips = inject(ClipsService);
  readonly clipDesigns = computed(() => this.clips.getDesigns({ channelID: this.channel, login: this.streamer, planTier: this.auth.getPlanTierForStreamer(this.streamer) }));
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
  readonly icons = { AlignCenterHorizontal, AlignCenterVertical, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, ChevronDown, Clapperboard, Copy, ExternalLink, Eye, EyeOff, FlaskConical, Undo2, Redo2, Layers3, LockKeyhole, LockOpen, Magnet, Monitor, Play, Plus, Radio, Settings2, Trash2, Volume2, X, Zap };
  readonly alertEvents = ALERT_EVENTS;
  readonly eventKinds = EVENT_KINDS;
  readonly designs = signal<AlertDesign[]>([]);
  readonly scenes = signal<OverlayScene[]>([]);
  readonly sceneId = signal('gameplay');
  readonly scene = computed(() => this.scenes().find(s => s.id === this.sceneId())!);
  readonly designDraft = signal<AlertDesign | null>(null);
  readonly designEvent = signal<AlertEvent>('follow');
  readonly variantId = signal<string | null>(null);
  readonly variants = computed(() => this.designDraft()?.variants?.[this.designEvent()] ?? []);
  readonly editingLayout = computed(() => this.variants().find(v => v.id === this.variantId())?.layout ?? this.designDraft()?.events[this.designEvent()]);
  readonly sampleTier = signal('1000');
  readonly sampleRaw = computed(() => ({ tier: this.sampleTier(), bits: Number(this.sampleAmount()), viewers: Number(this.sampleAmount()) }));
  readonly matchedVariantName = computed(() => {
    const draft = this.designDraft(); return draft ? matchingVariant(draft, this.designEvent(), this.sampleRaw())?.name ?? this.t('defaultVariant') : '';
  });
  readonly canvasWidth = computed(() => this.designDraft()?.width ?? this.scene()?.width ?? 1920);
  readonly canvasHeight = computed(() => this.designDraft()?.height ?? this.scene()?.height ?? 1080);
  readonly widgets = computed(() => this.editingLayout()?.widgets ?? this.scene()?.widgets ?? []);
  readonly palette = computed<WidgetKind[]>(() => this.designDraft() ? ['text', 'image', 'video', 'animation', 'shape'] : ['tts', 'trigger', 'clip', 'alert', 'image', 'video', 'shape']);
  readonly selectedId = signal<string | null>('alert-1');
  /** Remembered so the exact-numbers section stays open while hopping between sources. */
  readonly exactOpen = signal(false);
  readonly connection = signal<{ state: ConnectionState; connected: number }>({ state: 'checking', connected: 0 });
  /** OBS states where viewers can't see this overlay yet; the setup strip turns amber. */
  readonly obsWarning = computed(() => ['unsaved', 'unpublished', 'offline', 'attention'].includes(this.connection().state));
  readonly layersTopFirst = computed(() => this.widgets().slice().reverse());
  readonly snap = signal(true);
  readonly saved = signal(false);
  readonly notice = signal('');
  readonly nudgeStep = computed(() => this.snap() ? 10 : 1);
  readonly selected = computed(() => this.widgets().find(w => w.id === this.selectedId()) ?? null);
  readonly offCanvas = computed(() => this.widgets().filter(w => w.x < 0 || w.y < 0 || w.x + w.width > this.canvasWidth() || w.y + w.height > this.canvasHeight()).length);
  readonly queue = signal<MockEvent[]>([]);
  readonly active = signal<MockEvent | null>(null);
  readonly parallel = signal<MockEvent[]>([]);
  readonly previewDesign = signal(false);
  readonly motionReplay = signal(0);
  readonly timeline = signal<AlertTransport | null>(null);
  private timelineFrame = 0;
  private timelineSeek = 0;
  readonly motionTransitions = ALERT_TRANSITIONS;
  readonly motionLoops = ALERT_LOOPS;
  readonly selectedMotion = computed(() => this.selected()?.motion ?? defaultMotion(this.selected()?.kind));
  private designPreviewTimer?: ReturnType<typeof setTimeout>;
  readonly sampleUser = signal('Luna');
  readonly sampleAmount = signal('100');
  readonly dirty = computed(() => {
    if (!this.loaded()) return false;
    if (this.recovered() || this.documentFingerprint() !== this.savedDocument()) return true;
    const draft = this.designDraft();
    return !!draft && this.designFingerprint(draft) !== this.designFingerprint(this.designs().find(d => d.id === draft.id));
  });
  readonly unpublished = computed(() => {
    const scene = this.scene();
    if (!scene?.published) return true;
    const designs = this.designs().map(d => this.designDraft()?.id === d.id ? this.designDraft()! : d);
    const snapshot = { width: scene.width, height: scene.height, widgets: scene.widgets, waitFor: scene.waitFor,
      designs: designs.filter(d => scene.widgets.some(w => w.designId === d.id)) };
    // Saving increments design revisions even if no artwork changed.
    const content = (value: typeof snapshot) => JSON.stringify({ ...value, designs: value.designs.map(({ revision: _revision, ...d }) => d) });
    return content(snapshot) !== content(scene.published);
  });
  readonly saveStatus = computed(() => this.loading() ? 'loading' : this.busy() ? 'saving' : this.dirty() ? 'unsavedChanges'
    : this.designDraft() ? 'statusDesignSaved' : this.unpublished() ? 'statusNotLive' : 'statusLive');
  readonly designUsage = computed(() => { const id = this.designDraft()?.id; return id ? this.usage(id) : 0; });
  readonly designEventEnabled = computed(() => this.scene()?.widgets.some(w => w.visible && w.kind === 'alert'
    && w.designId === this.designDraft()?.id && w.events?.includes(this.designEvent())) ?? false);

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
      const designTexts = this.designs().flatMap(d => designLayouts(d).flatMap(e => e.widgets.filter(w => w.kind === 'text').map(w => w.text || '')));
      const texts = [...new Set([...ownTexts, ...designTexts])].slice(0, 100);
      const kind = this.designEvent(), user = this.sampleUser(), amount = this.sampleAmount(), tier = this.sampleTier();
      this.loading();
      if (!this.channel || !texts.length) return;
      let valid = true;
      const timer = setTimeout(() => {
        void this.api.render(this.channel, texts, kind, user, amount, tier).then(values => {
          if (valid) { this.rendered.set(Object.fromEntries(texts.map((text, i) => [text, values[i]]))); this.astError.set(''); }
        }).catch(e => { if (valid) this.astError.set(e?.error?.message || this.t('astFailed')); });
      }, 200);
      onCleanup(() => { valid = false; clearTimeout(timer); });
    });
    effect(onCleanup => {
      // Notices sit next to the save bar; they fade on their own instead of piling up.
      if (!this.notice()) return;
      const timer = setTimeout(() => this.notice.set(''), 8000);
      onCleanup(() => clearTimeout(timer));
    });
    inject(DestroyRef).onDestroy(() => { this.flushRecovery(); this.disposed = true; this.resetSimulation(); });
  }
  t(key: string, params?: Record<string, string | number>): string {
    this.language.currentLanguage(); return this.language.translate(`overlayStudio.${key}`, params);
  }
  toggleSnap(): void { this.snap.update(v => !v); }
  select(id: string): void { if (this.selectedId() !== id) this.endHistoryGroup(); this.selectedId.set(id); }
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
  private updateLayout(update: (layout: AlertLayout) => AlertLayout): void {
    this.edit(() => this.designDraft.update(d => {
      if (!d) return d;
      const kind = this.designEvent(), id = this.variantId();
      if (id && d.variants?.[kind]?.some(v => v.id === id)) return {...d, variants: {...d.variants, [kind]: d.variants[kind]!.map(v => v.id === id ? {...v, layout: update(v.layout)} : v)}};
      return {...d, events: {...d.events, [kind]: update(d.events[kind])}};
    }));
  }
  selectVariant(id: string | null): void {
    this.resetSimulation(); this.stopPointer(); this.endHistoryGroup(); this.variantId.set(id);
    this.selectedId.set(this.widgets()[1]?.id ?? this.widgets()[0]?.id ?? null);
  }
  private updateVariants(update: (variants: AlertVariant[]) => AlertVariant[]): void {
    this.resetSimulation();
    this.edit(() => this.designDraft.update(d => d ? {...d, variants: {...d.variants, [this.designEvent()]: update(d.variants?.[this.designEvent()] ?? [])}} : d));
  }
  addVariant(): void {
    if (this.designEvent() === 'follow' || this.variants().length >= 10 || !this.editingLayout()) return;
    const source = this.variants().find(v => v.id === this.variantId()), id = this.id('variant');
    this.edit(() => {
      const variant: AlertVariant = {id, name: source ? source.name.slice(0, 60) + ' · ' + this.t('copy') : this.t('newVariant'), enabled: true,
        ...(this.designEvent() === 'sub' ? {tier: source?.tier ?? '2000'} : {min: source?.min ?? (this.designEvent() === 'bits' ? 100 : 10), ...(source?.max === undefined ? {} : {max: source.max})}), layout: clone(this.editingLayout()!)};
      this.updateVariants(all => [...all, variant]); this.selectVariant(id);
    }, null);
  }
  patchVariant(change: Partial<AlertVariant>): void { this.updateVariants(all => all.map(v => v.id === this.variantId() ? {...v, ...change} : v)); }
  moveVariant(direction: -1 | 1): void {
    this.edit(() => this.updateVariants(all => { const next = [...all], index = next.findIndex(v => v.id === this.variantId()), target = index + direction;
      if (index >= 0 && target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]]; return next; }), null);
  }
  removeVariant(): void { this.edit(() => { this.updateVariants(all => all.filter(v => v.id !== this.variantId())); this.selectVariant(null); }, null); }
  previewMatchingVariant(): void {
    const draft = this.designDraft(); if (!draft) return;
    this.selectVariant(matchingVariant(draft, this.designEvent(), this.sampleRaw())?.id ?? null); this.testDesign();
  }
  alignEdge(edge: 'left' | 'right' | 'top' | 'bottom'): void {
    const w = this.selected(); if (!w || w.locked) return;
    this.patchSelected(edge === 'left' || edge === 'right' ? {x: edge === 'left' ? 0 : this.canvasWidth() - w.width} : {y: edge === 'top' ? 0 : this.canvasHeight() - w.height});
  }
  private playingLayout(widget: OverlayWidget, kind = this.eventFor(widget)): AlertLayout | undefined {
    const design = this.designFor(widget); return design ? selectAlertLayout(design, kind, this.sampleRaw()) : undefined;
  }
  private updateWidgets(update: (widgets: OverlayWidget[]) => OverlayWidget[]): void {
    this.edit(() => {
      if (this.designDraft()) this.updateLayout(layout => ({...layout, widgets: update(layout.widgets)}));
      else this.updateScene({ widgets: update(this.widgets()) });
      this.reconcileTests();
    });
  }
  private updateScene(changes: Partial<OverlayScene>): void {
    this.edit(() => this.scenes.update(all => all.map(s => s.id === this.sceneId() ? { ...s, ...changes } : s)));
  }
  private patch(id: string, changes: Partial<OverlayWidget>): void { this.updateWidgets(all => all.map(w => w.id === id ? { ...w, ...changes } : w)); }
  selectClipDesign(event: Event): void {
    const design = this.value(event) as ClipDesignVariant;
    if (this.selected()?.kind !== 'clip' || !CLIP_DESIGN_VARIANTS.includes(design) || this.clipDesigns().find(d => d.variant === design)?.isLocked !== false) return;
    this.patchSelected({ clipDesign: design });
  }
  setMotionChoice(field: 'enter' | 'exit' | 'loop', event: Event): void {
    const value = this.value(event);
    if (!(field === 'loop' ? ALERT_LOOPS : ALERT_TRANSITIONS).includes(value as never)) return;
    const keyframes = {...this.selected()?.keyframes}; delete keyframes[field];
    this.patchSelected({ keyframes:Object.keys(keyframes).length ? keyframes : undefined, motion: { ...this.selectedMotion(), [field]: value } });
  }
  prepareAnimationCatalog(): void { this.resetSimulation(); }
  editKeyframes(changes: Partial<OverlayWidget>): void { this.resetSimulation(); this.patchSelected(changes); }
  setMotionTime(field: 'delay' | 'enterDuration' | 'exitDuration' | 'loopDuration', event: Event): void {
    const value = Number(this.value(event)); if (!Number.isFinite(value)) return;
    const min = field === 'delay' ? 0 : field === 'loopDuration' ? .2 : .1;
    const max = field === 'delay' ? 120 : field === 'loopDuration' ? 10 : 5;
    this.patchSelected({ motion: { ...this.selectedMotion(), [field]: Math.max(min, Math.min(max, value)) } });
  }
  objectPlaybackKey(widget: OverlayWidget): number {
    if (this.designDraft()) return this.previewDesign() || this.timeline() ? this.motionReplay() : 0;
    return [this.active(), ...this.parallel()].find(event => event && widget.events?.includes(event.kind as AlertEvent))?.id ?? 0;
  }
  objectPlaybackDuration(widget: OverlayWidget): number {
    return this.editingLayout()?.duration ?? this.playingLayout(widget)?.duration ?? 5;
  }
  patchSelected(changes: Partial<OverlayWidget>): void { const id = this.selectedId(); if (id) this.patch(id, changes); }
  useSound(asset: DesignAsset): void {
    if (asset.kind !== 'audio') return;
    this.setSound({ assetId: asset.id, name: asset.name, volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 }); this.soundPickerOpen.set(false);
  }
  setSound(sound: AlertSound | undefined): void {
    this.resetSimulation();
    this.updateLayout(layout => ({...layout, sound}));
  }
  soundValue(field: 'volume' | 'delay' | 'fadeIn' | 'fadeOut', event: Event): void {
    const sound = this.alertSound(), value = Number(this.value(event)); if (!sound || !Number.isFinite(value)) return;
    this.setSound({ ...sound, [field]: Math.max(0, Math.min(field === 'volume' ? 1 : field === 'delay' ? 120 : 10, field === 'volume' ? value / 100 : value)) });
  }
  useAsset(asset: DesignAsset): void {
    if (this.selected()?.kind === asset.kind) this.patchSelected({ assetId: asset.id, mediaUrl: undefined });
    this.assetPickerOpen.set(false);
  }
  widgetIcon(kind: WidgetKind) { return ({ tts: Volume2, trigger: Zap, clip: Clapperboard, alert: Bell, text: Type, image: Image, video: Play, animation: Sparkles, shape: Layers3 })[kind]; }
  widgetName(widget: OverlayWidget): string { return widget.name || this.t(`${widget.kind}Name`); }
  addWidget(kind: WidgetKind, position?: { x: number; y: number }): void {
    const width = kind === 'tts' ? 580 : kind === 'alert' ? 640 : kind === 'text' ? 400 : 300;
    const height = kind === 'tts' ? 160 : kind === 'alert' ? 192 : kind === 'text' ? 80 : 180;
    const widget: OverlayWidget = { id: this.id(kind), kind, x: position?.x ?? 40, y: position?.y ?? 40, width, height, visible: true, locked: false,
      ...(kind === 'alert' ? { designId: this.designs()[0].id, events: [...ALERT_EVENTS] } : {}), ...(kind === 'text' ? { text: '$(user)' } : {}) };
    this.updateWidgets(all => [...all, widget]); this.select(widget.id);
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
    // Touch: the first tap only selects, so swiping across the canvas still scrolls the page.
    if (event.pointerType === 'touch' && action === 'move' && this.selectedId() !== widget.id) { this.select(widget.id); return; }
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
  stopPointer(): void { if (this.pointer) this.endHistoryGroup(); this.pointer = null; }
  onWidgetKeydown(event: KeyboardEvent, widget: OverlayWidget): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.select(widget.id); return; }
    const moves: Record<string, number[]> = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] };
    const current = this.widgets().find(w => w.id === widget.id);
    const move = moves[event.key]; if (!move || !current || current.locked) return;
    event.preventDefault(); this.select(widget.id); const step = this.snap() ? 10 : 1;
    this.edit(() => this.patch(widget.id, { x: current.x+move[0]*step, y: current.y+move[1]*step }), 'nudge:' + widget.id);
  }
  /** Touch-friendly alternative to dragging: consecutive taps are one undo step. */
  nudge(dx: number, dy: number): void {
    const item = this.selected(); if (!item || item.locked) return;
    const step = this.nudgeStep();
    this.edit(() => this.patch(item.id, { x: item.x + dx * step, y: item.y + dy * step }), 'nudge:' + item.id);
  }
  center(axis: 'x' | 'y'): void {
    const item = this.selected(); if (!item || item.locked) return;
    this.endHistoryGroup();
    this.patch(item.id, axis === 'x' ? { x: Math.round((this.canvasWidth() - item.width) / 2) } : { y: Math.round((this.canvasHeight() - item.height) / 2) });
  }
  setExactOpen(event: Event): void { this.exactOpen.set((event.target as HTMLDetailsElement).open); }
  updateDimension(field: Dimension, event: Event): void {
    const number = Number(this.value(event)); if (!Number.isFinite(number) || !this.value(event)) return;
    this.patchSelected({ [field]: Math.max(field === 'width' || field === 'height' ? 20 : -16000, Math.min(16000, Math.round(number))) });
  }
  updateCanvas(field: 'width' | 'height', event: Event): void {
    const number = Number(this.value(event)); if (!Number.isFinite(number) || number < 100 || number > 7680) return;
    this.edit(() => {
      if (this.designDraft()) this.designDraft.update(d => d ? { ...d, [field]: Math.round(number) } : d);
      else this.updateScene({ [field]: Math.round(number) });
    });
  }
  rename(event: Event): void {
    const name = this.value(event).trim().slice(0,80); if (!name) return;
    this.edit(() => { if (this.designDraft()) this.designDraft.update(d => d ? { ...d, name } : d); else this.updateScene({ name }); });
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
  switchScene(id: string): void { if (id === this.sceneId()) return; this.stopPointer(); this.endHistoryGroup(); this.confirmRotate.set(false); this.confirmDelete.set(false); this.resetSimulation(); this.sceneId.set(id); this.selectedId.set(this.widgets()[0]?.id ?? null); this.saved.set(false); }
  newScene(): void {
    const scene=makeScene(this.id('overlay'),this.t('newOverlay'),this.designs()[0].id); scene.widgets=[]; scene.publicId='';
    this.stopPointer(); this.edit(() => { this.scenes.update(all=>[...all,scene]); this.sceneId.set(scene.id); this.selectedId.set(null); this.resetSimulation(); }, null);
  }
  openDesign(id?: string): void {
    if (this.designDraft() && this.dirty() && !window.confirm(this.t('discardDesign'))) return;
    this.stopPointer(); this.endHistoryGroup(); this.resetSimulation();
    const design=this.designs().find(d=>d.id===id) ?? makeDesign(this.id('design'),this.t('newDesign'));
    this.designDraft.set(clone(design)); this.variantId.set(null); this.designEvent.set('follow'); this.selectedId.set(this.widgets()[1]?.id ?? this.widgets()[0]?.id ?? null); this.saved.set(false);
  }
  async closeDesign(): Promise<void> { if (!await this.saveDesign()) return; this.stopPointer(); this.endHistoryGroup(); this.closeTimeline(); this.designDraft.set(null); this.selectedId.set('alert-1'); this.previewDesign.set(false); this.saved.set(false); }
  setDesignEvent(event: AlertEvent): void { this.resetSimulation(); this.stopPointer(); this.endHistoryGroup(); this.designEvent.set(event); this.variantId.set(null); this.selectedId.set(this.widgets()[1]?.id ?? this.widgets()[0]?.id ?? null); }
  async saveDesign(asCopy=false): Promise<boolean> {
    const draft=this.designDraft(); if(!draft) return false;
    const saved={...clone(draft),id:asCopy?this.id('design'):draft.id,name:asCopy?`${draft.name} · ${this.t('copy')}`:draft.name,revision:asCopy?1:draft.revision+1};
    const update = () => {
      this.designs.update(all=>all.some(d=>d.id===saved.id)?all.map(d=>d.id===saved.id?saved:d):[...all,saved]);
      this.designDraft.set(clone(saved));
    };
    if (asCopy) this.edit(update, null); else update();
    if (!await this.persist()) return false; this.notice.set('designSaved'); return true;
  }
  useDesign(id: string): void { this.edit(() => { this.addWidget('alert'); this.patchSelected({designId:id}); }, null); }
  designFor(widget: OverlayWidget): AlertDesign | undefined { return this.designs().find(d=>d.id===widget.designId); }
  usage(id: string): number { return this.scenes().filter(s=>s.widgets.some(w=>w.designId===id)).length; }
  toggleEvent(event: AlertEvent): void { const events=this.selected()?.events??[]; this.patchSelected({events:events.includes(event)?events.filter(e=>e!==event):[...events,event]}); }
  enableDesignEvent(): void {
    const design = this.designDraft(); if (!design) return;
    const widget = this.scene().widgets.find(w => w.kind === 'alert' && w.designId === design.id);
    if (!widget) return;
    this.updateScene({ widgets: this.scene().widgets.map(w => w.id === widget.id
      ? { ...w, visible: true, events: [...new Set([...(w.events ?? []), this.designEvent()])] } : w) });
  }
  designLinked(): boolean { return this.scene().widgets.some(w => w.kind === 'alert' && w.designId === this.designDraft()?.id); }
  toggleWait(kind: EventKind): void { const wait=this.scene().waitFor; this.updateScene({waitFor:wait.includes(kind)?wait.filter(e=>e!==kind):[...wait,kind]}); }
  updateDuration(event: Event): void {
    const value=Number(this.value(event)); if(!Number.isFinite(value)) return;
    this.resetSimulation();
    this.updateLayout(layout => ({...layout, duration: Math.max(1,Math.min(120,value))}));
  }
  renderText(text='$(user)'): string { return this.rendered()[text] ?? text; }
  alertLayout(widget: OverlayWidget): OverlayWidget[] { return this.playingLayout(widget)?.widgets ?? []; }
  eventFor(widget: OverlayWidget): AlertEvent {
    const playing=[this.active(),...this.parallel()].find(e=>e&&widget.events?.includes(e.kind as AlertEvent));
    return playing?.kind as AlertEvent ?? widget.events?.[0] ?? 'follow';
  }
  isPlaying(widget: OverlayWidget): boolean {
    return this.designDraft()?this.previewDesign():[this.active(),...this.parallel()].some(e=>e&&(widget.kind===e.kind && (!e.targets || e.targets.includes(widget.id)) || widget.kind==='alert'&&widget.events?.includes(e.kind as AlertEvent)));
  }
  changeTestChannel(event: Event): void { this.resetSimulation(); this.channelChoice.set(this.value(event)); }
  testBusy(kind: EventKind): boolean {
    return (kind === 'clip' || kind === 'trigger' || kind === 'tts') && [...this.queue(), this.active(), ...this.parallel()].some(e => e?.kind === kind);
  }
  mediaEvents(widget: OverlayWidget): MockEvent[] {
    if (this.designDraft()) return [];
    return [this.active(), ...this.parallel()].filter((e): e is MockEvent => Boolean(e?.media && e.targets?.includes(widget.id)));
  }
  mediaMuted(event: MockEvent, widgetId: string): boolean {
    const firstVisible = event.targets?.find(id => this.widgets().some(w => w.id === id && w.visible));
    return firstVisible !== widgetId;
  }
  /** Tests play on the canvas; on phones the test buttons sit below it, so bring it back into view. */
  private revealStage(): void {
    const stage = this.host.querySelector('.stage');
    if (!stage || typeof window === 'undefined') return;
    const box = stage.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= window.innerHeight) return;
    stage.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  previewWidget(kind: EventKind): void {
    if (ALERT_EVENTS.includes(kind as AlertEvent)) this.designEvent.set(kind as AlertEvent);
    if (this.testBusy(kind)) return;
    this.revealStage();
    const real = kind === 'clip' || kind === 'trigger' || kind === 'tts';
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
    if (!event.channel) {
      const durations = this.widgets().filter(w => w.visible && w.kind === 'alert' && w.events?.includes(event.kind as AlertEvent)).map(w => this.playingLayout(w, event.kind as AlertEvent)?.duration ?? 5);
      this.later(() => this.finishEvent(event.id), Math.max(1, ...durations) * 1000); return;
    }
    const visible = new Set(this.widgets().filter(w => w.visible).map(w => w.id));
    const targets = event.targets?.filter(id => visible.has(id)) ?? [];
    if (!targets.length) { this.finishEvent(event.id); return; }
    const job: MediaJob = { pending: new Set(targets), started: new Set() };
    this.jobs.set(event.id, job);
    this.notice.set('preparingTest');
    const widgets = this.widgets().filter(w => targets.includes(w.id));
    const triggerIds = widgets.some(w => w.triggerIds === undefined) ? undefined : [...new Set(widgets.flatMap(w => w.triggerIds ?? []))];
    if (event.kind === 'trigger' && triggerIds?.length === 0) { this.notice.set('noMatchingTriggers'); this.finishEvent(event.id); return; }
    let canceled = false; job.cancel = () => { canceled = true; };
    void this.api.request<{ media?: TestMedia; triggerId?: string }>('POST', `${this.channel}/test`, {
      kind: event.kind, destination: 'preview', sceneId: this.sceneId(), triggerIds,
      language: this.language.currentLanguage()
    }, 90000).then(result => {
      if (canceled || !this.jobs.has(event.id)) return;
      if (!result.media) throw new Error(this.t('testPlaybackError'));
      const media = { ...result.media, triggerId: result.triggerId };
      if (media.url.startsWith('/')) media.url = this.api.base + media.url;
      this.showMedia(event.id, media);
    }).catch(error => {
      if (canceled || !this.jobs.has(event.id)) return;
      this.error.set(error?.error?.message || this.t('testPlaybackError')); this.finishEvent(event.id);
    });
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
  seekTimeline(time: number): void {
    if (!this.designDraft()) return;
    if (!this.timeline()) { this.resetSimulation(); this.motionReplay.update(n => n + 1); }
    if (this.timelineFrame) cancelAnimationFrame(this.timelineFrame);
    this.timeline.set({ time: Math.max(0, Math.min(this.editingLayout()!.duration, time)), playing: false, seek: ++this.timelineSeek });
  }
  toggleTimeline(): void {
    const current = this.timeline();
    if (current?.playing) { this.seekTimeline(current.time); return; }
    const duration = this.editingLayout()?.duration ?? 5;
    this.seekTimeline(current && current.time < duration ? current.time : 0);
    const start = this.timeline()!.time, began = performance.now(), seek = this.timelineSeek;
    this.timeline.set({ time: start, playing: true, seek });
    const tick = () => {
      const time = Math.min(duration, start + (performance.now() - began) / 1000);
      this.timeline.set({ time, playing: time < duration, seek });
      if (time < duration) this.timelineFrame = requestAnimationFrame(tick);
    };
    this.timelineFrame = requestAnimationFrame(tick);
  }
  pauseHiddenTimeline(): void { const clock = this.timeline(); if (document.hidden && clock?.playing) this.seekTimeline(clock.time); }
  closeTimeline(): void { if (this.timelineFrame) cancelAnimationFrame(this.timelineFrame); this.timeline.set(null); }
  editTimeline(change: TimelineEdit): void {
    this.resetSimulation();
    this.edit(() => this.updateLayout(layout => change.id === '$sound'
      ? { ...layout, sound: layout.sound ? { ...layout.sound, [change.field]: change.value } : undefined }
      : { ...layout, widgets: layout.widgets.map(w => w.id === change.id ? { ...w, motion: { ...(w.motion ?? defaultMotion(w.kind)), [change.field]: change.value } } : w) }), 'timeline:' + change.id + ':' + change.field);
  }
  testDesign(): void {
    this.closeTimeline(); this.revealStage();
    if (this.designPreviewTimer) { clearTimeout(this.designPreviewTimer); this.timers.delete(this.designPreviewTimer); }
    this.motionReplay.update(value => value + 1); this.previewDesign.set(true);
    this.designPreviewTimer = this.later(() => this.previewDesign.set(false), (this.editingLayout()?.duration ?? 5) * 1000);
  }
  private resetSimulation(): void { this.closeTimeline(); this.previewDesign.set(false); this.jobs.forEach(job => job.cancel?.()); this.jobs.clear(); this.timers.forEach(t=>clearTimeout(t));this.timers.clear();this.active.set(null);this.parallel.set([]);this.queue.set([]); }
  async publish(): Promise<void> {
    if (!(this.designDraft() ? await this.saveDesign() : await this.persist())) return;
    this.busy.set(true);
    try { this.accept(await this.api.action(this.channel, this.sceneId(), this.revision, 'publish')); this.notice.set('publishedNotice'); }
    catch (e) { this.report(e); } finally { this.busy.set(false); }
  }
  async regenerateUrl(): Promise<void> {
    if (!this.confirmRotate()) { this.confirmRotate.set(true); return; }
    this.busy.set(true);
    try { const state = await this.api.action(this.channel, this.sceneId(), this.revision, 'rotate'); this.rememberServerState(state); this.revision = state.revision; const remote = state.scenes.find(s => s.id === this.sceneId())!; this.scenes.update(all => all.map(s => s.id === remote.id ? { ...s, publicId: remote.publicId } : s)); this.notice.set('urlRegenerated'); this.confirmRotate.set(false); }
    catch (e) { this.report(e); } finally { this.busy.set(false); }
  }
  async saveDraft(): Promise<void> { if (this.designDraft()) await this.saveDesign(); else await this.persist(); }
  private async persist(): Promise<boolean> {
    if (this.busy() || !this.channel) return false;
    this.stopPointer(); this.endHistoryGroup();
    this.busy.set(true); this.error.set('');
    try { this.accept(await this.api.save(this.channel, { schemaVersion: 1, revision: this.revision, scenes: this.scenes(), designs: this.designs() })); return true; }
    catch (e) { this.report(e); return false; } finally { this.busy.set(false); }
  }
  private accept(state: StudioState, preserveRecovery = false): void {
    if (this.disposed) return;
    this.rememberServerState(state);
    this.revision = state.revision; this.scenes.set(state.scenes); this.designs.set(state.designs);
    if (!state.scenes.some(s => s.id === this.sceneId())) this.sceneId.set(state.scenes[0].id);
    this.loaded.set(true);
    this.savedDocument.set(this.documentFingerprint());
    this.recovered.set(false); this.conflict.set(false); this.recoveryRequestId = null;
    if (!preserveRecovery) { this.recovery.set(null); this.clearRecovery(); }
    this.saved.set(true);
  }
  private report(e: unknown): void {
    const error = e as { status?: number; error?: { message?: string } };
    this.conflict.set(error.status === 409);
    this.error.set(error.status === 409 ? this.t('conflict') : error.error?.message || this.t('saveFailed')); this.saved.set(false);
  }
  exportLocalDraft(): void {
    this.flushRecovery();
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.localDraft(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'overlay-draft-recovery.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async recoverAsCopies(): Promise<void> {
    if (this.busy() || this.loading() || !this.loaded()) return;
    this.flushRecovery(); this.busy.set(true); this.error.set('');
    const draft = this.designDraft();
    const designs = draft ? [...this.designs().filter(d => d.id !== draft.id), draft] : this.designs();
    const existingIds = new Set(this.scenes().map(s => s.id));
    this.recoveryRequestId ??= crypto.randomUUID();
    try {
      const state = await this.api.request<StudioState>('POST', `${this.channel}/recover`, { recoveryId: this.recoveryRequestId, scenes: this.scenes(), designs });
      const copy = state.scenes.find(s => !existingIds.has(s.id) && s.id.startsWith('recovered-'));
      this.designDraft.set(null); this.accept(state); this.history.clear();
      if (copy) this.switchScene(copy.id);
      this.notice.set('recoveryCopiesSaved');
    } catch (e) {
      const error = e as { error?: { message?: string } };
      this.error.set(error.error?.message || this.t('saveFailed')); this.conflict.set(true);
    } finally { this.busy.set(false); }
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
      if (this.owner()) {
        this.channel = (await firstValueFrom(this.auth.resolveChannelID(this.streamer))) || '';
        if (!this.channel) throw new Error('Channel unavailable');
        if (initial) this.findRecovery();
        const state = await this.api.load(this.channel);
        if (this.disposed) return;
        // Replace local work only after the server has returned a complete saved draft.
        this.resetSimulation(); this.designDraft.set(null);
        this.accept(state, initial); this.history.clear();
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
  private edit(change: () => void, group: object | string | null = this.historyGroup()): void {
    if (this.busy() || this.loading() || !this.loaded()) return;
    if (this.editDepth) { change(); return; }
    const before = this.editSnapshot();
    this.editDepth++;
    try { change(); }
    finally {
      this.editDepth--;
      if (this.history.record(before, this.editSnapshot(), group)) { this.saved.set(false); this.recoveryRequestId = null; }
    }
  }
  private historyGroup(): object | null {
    if (this.pointer) return this.pointer;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    return active?.closest('app-overlay-editor') && active.matches('input, textarea, [contenteditable="true"]') ? active : null;
  }
  endHistoryGroup(): void { this.history.endGroup(); }
  private editSnapshot(): OverlayEditSnapshot {
    return {
      document: {
        scenes: this.scenes().map(({ publicId: _publicId, published: _published, revision: _revision, ...draft }) => draft),
        designs: this.designs().map(({ revision: _revision, ...draft }) => draft),
        designDraft: this.designDraft() ? (({ revision: _revision, ...draft }) => draft)(this.designDraft()!) : null
      },
      sceneId: this.sceneId(), designEvent: this.designEvent(), variantId: this.variantId(), selectedId: this.selectedId()
    };
  }
  private rememberServerState(state: StudioState): void {
    this.serverScenes = new Map(state.scenes.map(scene => [scene.id, scene]));
    this.serverDesigns = new Map(state.designs.map(design => [design.id, design]));
  }
  undo(): void {
    if (!this.canUndo()) return;
    this.stopPointer();
    const snapshot = this.history.undo(this.editSnapshot());
    if (snapshot) this.restoreEdit(snapshot, 'undone');
  }
  redo(): void {
    if (!this.canRedo()) return;
    this.stopPointer();
    const snapshot = this.history.redo(this.editSnapshot());
    if (snapshot) this.restoreEdit(snapshot, 'redone');
  }
  private restoreEdit(snapshot: OverlayEditSnapshot, notice: string): void {
    this.resetSimulation(); this.previewDesign.set(false); this.assetPickerOpen.set(false); this.soundPickerOpen.set(false);
    this.confirmRotate.set(false); this.confirmDelete.set(false);
    this.scenes.set(snapshot.document.scenes.map(scene => {
      const remote = this.serverScenes.get(scene.id);
      return { ...scene, publicId: remote?.publicId ?? '', revision: remote?.revision ?? 0, ...(remote?.published ? { published: remote.published } : {}) };
    }));
    this.designs.set(snapshot.document.designs.map(design => ({ ...design, revision: this.serverDesigns.get(design.id)?.revision ?? 1 })));
    const draft = snapshot.document.designDraft;
    this.designDraft.set(draft ? { ...draft, revision: this.serverDesigns.get(draft.id)?.revision ?? 1 } : null);
    this.sceneId.set(snapshot.sceneId); this.designEvent.set(snapshot.designEvent); this.variantId.set(snapshot.variantId ?? null);
    this.selectedId.set(this.widgets().some(widget => widget.id === snapshot.selectedId) ? snapshot.selectedId : this.widgets()[0]?.id ?? null);
    this.saved.set(!this.dirty()); this.notice.set(notice); this.flushRecovery();
  }
  onHistoryKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('app-overlay-editor') || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]')) return;
    if (!this.loaded() || this.busy() || this.loading() || this.assetPickerOpen() || this.soundPickerOpen()) return;
    event.preventDefault();
    if (key === 'y' || event.shiftKey) this.redo(); else this.undo();
  }
  onHistoryKeyup(event: KeyboardEvent): void { if (event.key.startsWith('Arrow')) this.endHistoryGroup(); }

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
      designs: this.designs(), designDraft: this.designDraft(), sceneId: this.sceneId(), designEvent: this.designEvent(), variantId: this.variantId(), selectedId: this.selectedId() };
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
    this.designEvent.set(draft.designEvent); this.variantId.set(draft.variantId ?? null); this.selectedId.set(draft.selectedId); this.revision = draft.revision;
    this.history.clear();
    this.loaded.set(true); this.recovered.set(true); this.saved.set(false);
    this.consumedRecovery = recovery; this.recovery.set(null);
    this.conflict.set(draft.revision !== currentRevision);
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
    this.stopPointer(); this.edit(() => { this.scenes.update(all => all.filter(s => s.id !== this.sceneId())); this.sceneId.set(this.scenes()[0].id); this.selectedId.set(this.widgets()[0]?.id ?? null); this.resetSimulation(); }, null);
    if (await this.persist()) this.confirmDelete.set(false);
  }
  selectAlertKind(event: Event): void { const kind = this.value(event) as AlertEvent; if (ALERT_EVENTS.includes(kind)) this.designEvent.set(kind); }
  selectLiveTest(event: Event): void {
    const kind = this.value(event) as EventKind; if (EVENT_KINDS.includes(kind)) this.liveTestKind.set(kind);
  }
  async testLiveAlert(): Promise<void> {
    if (this.liveTesting()) return;
    if (this.unpublished()) { this.error.set(this.t('testPublishFirst')); return; }
    const kind = this.liveTestKind();
    if (!window.confirm(this.t('confirmObsTest', { overlay: this.scene().name, event: this.t(kind + 'Name') }))) return;
    this.liveTesting.set(true); this.error.set('');
    try {
      await this.api.request('POST', `${this.channel}/test`, { kind, sceneId: this.sceneId(), destination: 'obs', confirmed: true, language: this.language.currentLanguage() }, 90000);
      this.notice.set('testSent');
    } catch(e) { this.error.set((e as {error?: {message?: string}})?.error?.message || this.t('testPlaybackError')); }
    finally { this.liveTesting.set(false); }
  }
  private round(value:number):number{return this.snap()?Math.round(value/10)*10:Math.round(value);}
}
