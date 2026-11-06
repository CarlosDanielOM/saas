import { OverlaySceneRendererComponent } from './overlay-scene-renderer.component';
import { OverlayAssetCache, type PreparedAsset } from './overlay-asset-cache';
import { AssetLibraryService } from '../../shared/asset-library/asset-library.service';
import { ALERT_READY_LIMIT_MS, alertPlacementIds, placementStartSeconds, placementMediaSeconds, placementMountSeconds, type OverlayRenderJob, type OverlayPlacementReport, type OverlayPlaybackId } from './overlay-playback';
import { OverlayWidgetSettingsComponent } from './overlay-widget-settings.component';
import { CustomWidgetsService, message as apiMessage, type CustomWidgetView } from './custom-widgets.service';
import { OverlayCustomWidgetImportComponent } from './overlay-custom-widget-import.component';
import { OverlayCustomWidgetCodeComponent } from './overlay-custom-widget-code.component';
import { groupFields } from './custom-widget-format.generated';
import { EditorWidgetEnv } from './widget-runtime/editor-env';
import { CUSTOM_WIDGET_ENV } from './widget-runtime/widget-env';
import { ALERT_TESTS, BOT_TEST_USES, CHAT_TESTS, botTestEvents, isStateTest, testAlert, testState, type AlertTest, type BotTestKind, type ChatTest } from './widget-runtime/test-events';
import type { DimaEvent } from './widget-runtime/dima-events';
import { createWidget, getWidgetModule, widgetModuleFor, widgetPalette } from './overlay-widget-registry';
import { OverlayInteractionSetupComponent } from './overlay-interaction-setup.component';
import { OverlayKeyframeEditorComponent } from './overlay-keyframe-editor.component';
import { OverlayAppearanceComponent } from './overlay-appearance.component';
import { OverlayVariantsComponent } from './overlay-variants.component';
import { OverlayBitsLooksComponent } from './overlay-bits-looks.component';
import { matchingVariant, selectAlertLayout, withoutLegacyBitsLooks, type AlertLayout, type AlertVariant } from './overlay.model';
import { BitsRulesService } from '../bits-rules/bits-rules.service';
import { amountText, matchBitsRule } from '../bits-rules/bits-rules.model';
import { OverlayTimelineComponent, type TimelineEdit } from './overlay-timeline.component';
import type { AlertTransport } from './overlay-sound.component';
import type { AlertSound } from './overlay.model';
import { defaultMotion } from './overlay-object-motion';
import { ALERT_TRANSITIONS, ALERT_LOOPS } from './overlay.model';
import { OverlayHistory, type OverlayEditSnapshot } from './overlay-history';
import { OverlayQueueComponent } from './overlay-queue.component';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ThemeService } from '../../services/theme.service';
import { LayoutFocusService } from '../../services/layout-focus.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { OverlayTestMediaService, type TestChannel, type TestMedia } from '../landing-mocks/dev/overlay-test-media.service';
import { OverlayTriggerFilterComponent } from './overlay-trigger-filter.component';
import { placeTrigger, triggerPlacementMargin } from './overlay-trigger-placement';
import { ClipsService } from '../clips/clips.service';
import { CLIP_DESIGN_VARIANTS, type ClipDesignVariant } from '../clips/clips.model';
import { OverlayLayerComponent } from './overlay-layer.component';
import { AssetLibraryDialogComponent } from '../../shared/asset-library/asset-library-dialog.component';
import type { DesignAsset } from '../../shared/asset-library/asset-library.service';
import { OverlayConnectionsComponent, type ConnectionState } from './overlay-connections.component';
import { OverlayApi, StudioState, Snapshot } from './overlay-api.service';
import { OverlayDraftStorage, type DraftScene, type LocalOverlayDraft, type OverlayRecovery } from './overlay-draft-storage.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { firstValueFrom } from 'rxjs';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AlignCenterHorizontal, AlignCenterVertical, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Check, ChevronDown, Clapperboard, Code2, Copy, CopyPlus, ExternalLink, Eye, EyeOff, FileUp, FlaskConical, Image, Keyboard, Languages, Link2, Moon, PanelsTopLeft, Scan, Sun, Undo2, Redo2, Layers3, LockKeyhole, LockOpen, Magnet, Monitor, Play, Plus, Puzzle, Radio, Settings2, Sparkles, Trash2, Type, Volume2, X, Zap, ZoomIn, ZoomOut, LucideAngularModule } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { ALERT_EVENTS, EVENT_KINDS, AlertDesign, AlertEvent, EventKind, OverlayScene, OverlayWidget, WidgetKind, clone, makeDesign, makeScene, matchesTrigger } from './overlay.model';

type Dimension = 'x' | 'y' | 'width' | 'height';
interface PointerSession { id: string; action: 'move' | 'resize'; startX: number; startY: number; original: OverlayWidget; canvas: DOMRect }
interface MockEvent { serialized?: boolean; originalTargets?: string[]; text?: string; layouts?: Record<string, AlertLayout>; snapshot?: Snapshot; assets?: Map<string, PreparedAsset>; texts?: Record<string, string>; preparing?: boolean; id: number; kind: EventKind; channel?: TestChannel; targets?: string[]; media?: TestMedia; placements?: OverlayWidget[] }
type StudioPop = 'scenes' | 'obs' | 'menu';
type MobileTab = 'layers' | 'add' | 'edit' | 'test' | 'more';
type StudioPane = 'variants' | 'add' | 'layers' | 'designs' | 'timeline' | 'tester' | 'layer' | 'overlay';
/** JSON with sorted object keys, so equal documents compare equal whatever order their fields were written in. */
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
/** Zoom steps for the canvas (1 = true pixels). "Fit" picks the largest scale that shows the whole canvas. */
const ZOOM_STEPS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];
/** Add palette groups, by what the streamer wants to show. Kinds not listed land in the last group. */
const PALETTE_GROUPS: { id: 'events' | 'interact' | 'media'; kinds: WidgetKind[] }[] = [
  { id: 'events', kinds: ['alert', 'trigger', 'tts', 'clip'] },
  { id: 'interact', kinds: ['poll', 'prediction'] },
  { id: 'media', kinds: [] }
];
interface MediaJob { cancel?: () => void; timers: Map<string, ReturnType<typeof setTimeout>>; pending: Set<string>; started: Set<string> }

@Component({
  selector: 'app-overlay-editor', imports: [OverlaySceneRendererComponent, OverlayWidgetSettingsComponent, OverlayInteractionSetupComponent, OverlayKeyframeEditorComponent, OverlayAppearanceComponent, OverlayVariantsComponent, OverlayBitsLooksComponent, OverlayTimelineComponent,  OverlayQueueComponent, RouterLink, LucideAngularModule,  OverlayLayerComponent, AssetLibraryDialogComponent, OverlayConnectionsComponent,  OverlayTriggerFilterComponent, OverlayCustomWidgetImportComponent, OverlayCustomWidgetCodeComponent], providers: [OverlayTestMediaService, OverlayDraftStorage, EditorWidgetEnv, { provide: CUSTOM_WIDGET_ENV, useExisting: EditorWidgetEnv }],
  templateUrl: './overlay-editor.component.html', styleUrl: './overlay-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:visibilitychange)': 'pauseHiddenTimeline()', '(window:pointermove)': 'onPointerMove($event)', '(window:pointerup)': 'stopPointer()', '(window:pointercancel)': 'stopPointer()', '(window:beforeunload)': 'protectDraft($event)', '(window:pagehide)': 'saveLocalRecovery()', '(window:keydown)': 'onHistoryKeydown($event)', '(window:keyup)': 'onHistoryKeyup($event)', '(focusout)': 'endHistoryGroup()' }
})
export class OverlayEditorComponent {
  private readonly api = inject(OverlayApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly previewPreparations = new Map<string, AbortController>();
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
  /** Sample text per alert event: each event renders with its own sample, so Bits never shows 0 bits first. */
  readonly rendered = signal<Partial<Record<AlertEvent, Record<string, string>>>>({});
  private readonly playbackTexts = signal<Record<string, string> | null>(null);
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
  readonly customWidgets = inject(CustomWidgetsService);
  readonly widgetEnv = inject(EditorWidgetEnv);
  readonly chatTests = CHAT_TESTS;
  readonly alertTests = ALERT_TESTS;
  /** The overlay being edited has custom widget layers (the Test drawer then offers chat and widget alert tests). */
  readonly customLayers = computed(() => !this.designDraft() && this.widgets().some(w => w.kind === 'custom'));
  readonly customImportOpen = signal(false);
  /** Code editor for a new widget ("New widget" in the Add panel). */
  readonly customCodeOpen = signal(false);
  readonly customError = signal('');
  readonly customBusy = signal('');
  readonly soundPickerOpen = signal(false);
  readonly soundPercent = computed(() => Math.round((this.alertSound()?.volume ?? 1) * 100));
  readonly alertSound = computed(() => this.editingLayout()?.sound);
  readonly assetKind = computed(() => this.selected()?.kind === 'video' ? 'video' as const : 'image' as const);
  private disposed = false;
  readonly language = inject(LanguageService);
  readonly auth = inject(SessionAuthService);
  private readonly clips = inject(ClipsService);
  readonly clipDesigns = computed(() => this.clips.getDesigns({ channelID: this.channel, login: this.streamer, planTier: this.auth.getPlanTierForStreamer(this.streamer) }));
  private readonly jobs = new Map<number, MediaJob>();
  private readonly assetCache = new OverlayAssetCache();
  private readonly previewLinks = new Map<string, { url: string; at: number }>();
  /** The design replay the renderer last showed whole, and work waiting for the current one. */
  private shownDesign = '';
  private designShown?: { key: string; run: () => void };
  private whenDesignShown(run: () => void): void {
    const epoch = this.designPlaybackKey(), key = 'static:' + epoch;
    if (!epoch || this.shownDesign === key) { this.designShown = undefined; run(); } else this.designShown = { key, run };
  }
  private readonly assetLibrary = inject(AssetLibraryService);
  private readonly designAssets = signal<Map<string, PreparedAsset>>(new Map());
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
  readonly icons = { AlignCenterHorizontal, AlignCenterVertical, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Check, ChevronDown, Clapperboard, Code2, Copy, CopyPlus, ExternalLink, Eye, EyeOff, FileUp, FlaskConical, Keyboard, Languages, Link2, Moon, PanelsTopLeft, Scan, Sun, Undo2, Redo2, Layers3, LockKeyhole, LockOpen, Magnet, Monitor, Play, Plus, Puzzle, Radio, Settings2, Sparkles, Trash2, Volume2, X, Zap, ZoomIn, ZoomOut };
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
  readonly bitsRules = inject(BitsRulesService);
  /** The shared Bits rule the sample amount matches (Bits looks follow it). */
  readonly sampleBitsRule = computed(() => matchBitsRule(this.bitsRules.view()?.rules ?? [], Number(this.sampleAmount())));
  ruleFor(kind: AlertEvent) { return kind === 'bits' ? this.sampleBitsRule() : null; }
  readonly matchedVariantId = computed(() => { const draft = this.designDraft(); return draft ? matchingVariant(draft, this.designEvent(), this.sampleRaw(), this.ruleFor(this.designEvent()))?.id ?? null : null; });
  readonly matchedVariantName = computed(() => {
    const draft = this.designDraft(); if (!draft) return '';
    if (this.designEvent() === 'bits') {
      const rule = this.sampleBitsRule(), b = (key: string, params?: Record<string, string | number>) => this.language.translate('bitsRules.' + key, params);
      if (!rule) return b('overlay.matchDefault');
      const name = rule.name || b('autoName', { amount: amountText(rule, this.language.currentLanguage() === 'es' ? 'es' : 'en') });
      if (!rule.alert) return b('overlay.matchNoAlert', { name });
      return this.matchedVariantId() ? name : b('overlay.matchRuleDefault', { name });
    }
    return matchingVariant(draft, this.designEvent(), this.sampleRaw())?.name ?? this.t('defaultVariant');
  });
  /** Bits: show the sample's match once the channel has rules (looks are optional per rule). */
  readonly showVariantMatch = computed(() => this.designEvent() === 'bits' ? !!this.bitsRules.view()?.rules.length : this.designEvent() !== 'follow' && this.variants().length > 0);
  readonly canvasWidth = computed(() => this.designDraft()?.width ?? this.scene()?.width ?? 1920);
  readonly canvasHeight = computed(() => this.designDraft()?.height ?? this.scene()?.height ?? 1080);
  readonly widgets = computed(() => this.editingLayout()?.widgets ?? this.scene()?.widgets ?? []);
  readonly widgetPlacement = computed(() => this.designDraft() ? 'design' as const : 'scene' as const);
  readonly palette = computed(() => widgetPalette(this.widgetPlacement()));
  /** Local-only sample controls belong to an instance, never to the shared live state. */
  readonly widgetPreviews = signal<Partial<Record<string, string>>>({});
  setWidgetPreview(id: string, fixture: string): void { this.widgetPreviews.update(all => ({ ...all, [id]: fixture })); }
  widgetModule(widget: OverlayWidget) { return widgetModuleFor(widget, this.widgetPlacement()); }
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
  readonly randomMargin = computed(() => triggerPlacementMargin(this.scene(), this.selected()?.triggerPlacement?.margin ?? 24));
  readonly randomPlacementAdjusted = computed(() => {
    const widget = this.selected();
    if (widget?.kind !== 'trigger' || widget.triggerPlacement?.mode !== 'random') return false;
    const placed = placeTrigger(widget, this.scene(), 'size-check');
    return placed.width < widget.width || placed.height < widget.height || this.randomMargin() < widget.triggerPlacement.margin;
  });
  readonly offCanvas = computed(() => this.widgets().filter(w => w.x < 0 || w.y < 0 || w.x + w.width > this.canvasWidth() || w.y + w.height > this.canvasHeight()).length);
  readonly queue = signal<MockEvent[]>([]);
  readonly active = signal<MockEvent | null>(null);
  readonly parallel = signal<MockEvent[]>([]);
  readonly previewDesign = signal(false);
  readonly motionReplay = signal(0);
  readonly timeline = signal<AlertTransport | null>(null);
  private timelineFrame = 0;
  private timelineSeek = 0;
  private playbackGeneration = 0;
  private designRequest = 0;
  readonly motionTransitions = ALERT_TRANSITIONS;
  readonly motionLoops = ALERT_LOOPS;
  readonly selectedMotion = computed(() => this.selected()?.motion ?? defaultMotion(this.selected()?.kind));
  private designPreviewTimer?: ReturnType<typeof setTimeout>;
  readonly sampleUser = signal('Luna');
  readonly sampleAmount = signal('100');
  readonly renderScene = computed<Snapshot>(() => ({ width:this.canvasWidth(),height:this.canvasHeight(),widgets:this.widgets(),designs:this.designs(),waitFor:this.scene()?.waitFor ?? [] }));
  readonly renderTexts = computed(() => this.designDraft() && (this.previewDesign() || this.timeline()) ? this.playbackTexts() ?? {} : this.rendered()[this.designEvent()] ?? {});
  readonly renderJobs = computed<OverlayRenderJob[]>(() => {
    if (this.designDraft()) return [];
    const scene = this.renderScene();
    const active = [this.active(),...this.parallel()].filter((event): event is MockEvent => !!event && !event.preparing && !!event.snapshot);
    const playing = active.map(event => ({ event:{ id:event.id,kind:event.kind,media:event.media,text:event.text,layouts:event.layouts },
      widgets:(event.placements ?? event.snapshot!.widgets.filter(w => event.targets?.includes(w.id))),snapshot:event.snapshot!,assets:event.assets,audioWidgetId:event.originalTargets?.[0] }));
    // A box's resting example hides as soon as a test for it starts preparing, so the
    // test appears whole instead of the example streaming in its pictures first.
    const occupied = new Set([this.active(),...this.parallel()].flatMap(event => event?.originalTargets ?? event?.targets ?? []));
    // Idle examples remain editable, but never animate or play sound. Active events
    // mount fresh OBS jobs, so their clocks/GIFs cannot inherit an idle preview's phase.
    const idle = scene.widgets.filter(w => w.visible && w.kind === 'alert' && !occupied.has(w.id)).flatMap(widget => {
      const layout = this.playingLayout(widget); if (!layout) return [];
      const kind = this.eventFor(widget),texts = this.rendered()[kind] ?? {};
      return [{event:{id:'idle-'+widget.id,kind,layouts:{[widget.designId!]:{...layout,widgets:layout.widgets.map(layer => layer.kind === 'text' ? {...layer,text:texts[layer.text || ''] ?? layer.text} : layer)}}},widgets:[widget],snapshot:scene,idle:true,playbackKey:0}];
    });
    return [...idle,...playing];
  });
  readonly designPlaybackKey = computed(() => this.designDraft() && (this.previewDesign() || this.timeline()) ? this.motionReplay() : 0);
  readonly designPreparedAssets = this.designAssets.asReadonly();
  rendererStarted(report: OverlayPlacementReport): void { this.mediaStarted(Number(report.id),report.widgetId,report.duration); }
  rendererEnded(report: OverlayPlacementReport,failed = false): void { this.mediaFinished(Number(report.id),report.widgetId,failed); }
  readonly dirty = computed(() => {
    if (!this.loaded()) return false;
    if (this.recovered() || this.documentFingerprint() !== this.savedDocument()) return true;
    const draft = this.designDraft();
    return !!draft && this.designFingerprint(draft) !== this.designFingerprint(this.designs().find(d => d.id === draft.id));
  });
  /**
   * Per overlay, from the server: OBS already plays its saved draft. Only the server decides this, because
   * publishing may change the copy it stores (e.g. custom widget pins), so comparing that copy here can't work.
   */
  private readonly liveScenes = signal<Readonly<Record<string, boolean>>>({});
  /** Each overlay's content as last saved, to tell whether it has unsaved edits of its own. */
  private readonly savedContent = signal<ReadonlyMap<string, string>>(new Map());
  readonly unpublished = computed(() => {
    const scene = this.scene();
    if (!scene?.published || this.liveScenes()[scene.id] !== true) return true;
    // The server answered for the saved draft; edits to this overlay that aren't saved yet aren't in OBS either.
    const draft = this.designDraft();
    return this.sceneContent(scene, draft ? this.designs().map(d => d.id === draft.id ? draft : d) : this.designs()) !== this.savedContent().get(scene.id);
  });
  /** What publishing this overlay would send, as the editor holds it (draft vs saved, never vs the published copy). */
  private sceneContent(scene: OverlayScene, designs: readonly AlertDesign[]): string {
    // Saving increments design revisions even if no artwork changed.
    return canonicalJson({ width: scene.width, height: scene.height, widgets: scene.widgets, waitFor: scene.waitFor,
      designs: designs.filter(d => scene.widgets.some(w => w.designId === d.id)).map(({ revision: _revision, ...d }) => d) });
  }
  readonly saveStatus = computed(() => this.loading() ? 'loading' : this.busy() ? 'saving' : this.dirty() ? 'unsavedChanges'
    : this.designDraft() ? 'statusDesignSaved' : this.unpublished() ? 'statusNotLive' : 'statusLive');
  readonly designUsage = computed(() => { const id = this.designDraft()?.id; return id ? this.usage(id) : 0; });
  readonly designEventEnabled = computed(() => this.scene()?.widgets.some(w => w.visible && w.kind === 'alert'
    && w.designId === this.designDraft()?.id && w.events?.includes(this.designEvent())) ?? false);

  // ── Studio layout (view state only; nothing here is saved) ─────────────────
  private readonly theme = inject(ThemeService);
  private readonly layoutFocus = inject(LayoutFocusService);
  private readonly workspace = viewChild<ElementRef<HTMLElement>>('workspace');
  /** Below 960px the studio stacks: pinned canvas on top, one panel at a time behind bottom tabs. */
  readonly compact = signal(false);
  readonly pop = signal<StudioPop | null>(null);
  private popTrigger: HTMLElement | null = null;
  readonly testOpen = signal(false);
  readonly panels = signal(true);
  readonly addOpen = signal(true);
  readonly rightTab = signal<'layer' | 'overlay'>('layer');
  /** Phones open on Layers: what is on the overlay (and its alert designs) before any one setting. */
  readonly mobileTab = signal<MobileTab>('layers');
  /** Inspector groups the streamer folded away stay folded while hopping between layers. */
  readonly sections = signal<Record<string, boolean>>({ settings: true, position: true, appearance: true, motion: true });
  readonly workspaceSize = signal({ width: 0, height: 0 });
  readonly zoomMode = signal<'fit' | number>('fit');
  readonly fitScale = computed(() => {
    const { width, height } = this.workspaceSize();
    if (!width || !height) return 0.3;
    const pad = this.compact() ? 10 : 32, toolbar = this.compact() ? 0 : 72;
    return Math.max(0.05, Math.min((width - pad * 2) / this.canvasWidth(), (height - pad * 2 - toolbar) / this.canvasHeight()));
  });
  readonly zoom = computed(() => { const mode = this.zoomMode(); return mode === 'fit' ? this.fitScale() : mode; });
  readonly zoomPercent = computed(() => Math.round(this.zoom() * 100));
  /** Alignment guides shown while dragging, in canvas pixels. */
  readonly guides = signal<{ v: number[]; h: number[] }>({ v: [], h: [] });
  readonly paletteGroups = computed(() => {
    const kinds = this.palette(), listed = new Set(PALETTE_GROUPS.flatMap(g => g.kinds));
    return PALETTE_GROUPS.map(group => ({ id: group.id, kinds: group.id === 'media' ? kinds.filter(k => !listed.has(k)) : group.kinds.filter(k => kinds.includes(k)) }))
      .filter(group => group.kinds.length);
  });
  readonly dark = computed(() => this.theme.isDarkMode());
  readonly accountName = computed(() => this.auth.session()?.twitchUser.display_name || this.auth.session()?.twitchUser.login || '');
  readonly accountAvatar = computed(() => this.auth.session()?.twitchUser.profile_image_url || '');
  readonly accountAvatarFailed = signal(false);
  /** The Layers row being dragged and the row it would take the place of. */
  readonly layerDrag = signal<{ id: string; over: string } | null>(null);
  private layerGesture?: () => void;

  constructor() {
    this.seed();
    // The studio is full screen once it is open; loading, error and permission screens keep the site navbar.
    effect(() => this.layoutFocus.active.set(this.owner() && this.loaded()));
    inject(DestroyRef).onDestroy(() => this.layoutFocus.active.set(false));
    afterNextRender(() => {
      const media = window.matchMedia('(max-width: 959.98px)');
      const sync = () => this.compact.set(media.matches);
      sync(); media.addEventListener('change', sync);
      this.destroyRef.onDestroy(() => media.removeEventListener('change', sync));
    });
    // Phones: whatever scrolls into view (keyboard focus, error fields) lands between the pinned canvas
    // and the save bar/tabs instead of underneath them.
    effect(onCleanup => {
      if (!this.compact() || !this.workspace() || typeof ResizeObserver === 'undefined') return;
      const root = document.documentElement, canvas = this.host.querySelector('.studio__canvas'), bar = this.host.querySelector('.lf-save-bar');
      if (!canvas || !bar) return;
      const apply = () => {
        root.style.scrollPaddingTop = Math.round(canvas.getBoundingClientRect().height + 8) + 'px';
        root.style.scrollPaddingBottom = Math.round(Math.max(0, window.innerHeight - bar.getBoundingClientRect().top) + 8) + 'px';
      };
      apply();
      const observer = new ResizeObserver(apply); observer.observe(canvas); observer.observe(bar); window.addEventListener('resize', apply);
      onCleanup(() => { observer.disconnect(); window.removeEventListener('resize', apply); root.style.scrollPaddingTop = ''; root.style.scrollPaddingBottom = ''; });
    });
    // "Fit" follows the workspace size, so hiding panels or opening the test drawer re-fits the canvas.
    effect(onCleanup => {
      const element = this.workspace()?.nativeElement;
      if (!element || typeof ResizeObserver === 'undefined') return;
      const measure = () => this.workspaceSize.set({ width: element.clientWidth, height: element.clientHeight });
      const wheel = (event: WheelEvent) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); if (event.deltaY < 0) this.zoomIn(); else this.zoomOut(); };
      measure();
      const observer = new ResizeObserver(measure); observer.observe(element);
      element.addEventListener('wheel', wheel, { passive: false });
      onCleanup(() => { observer.disconnect(); element.removeEventListener('wheel', wheel); });
    });
    afterNextRender(() => void this.loadSaved());
    effect(onCleanup => {
      if (!this.loaded() || !this.channel || this.loading()) return;
      // Clearing only removes this editor's own copy; an offered recovery copy stays until the user chooses.
      const draft = this.dirty() ? this.localDraft() : null;
      const timer = setTimeout(() => { if (draft) this.writeRecovery(draft); else this.clearRecovery(); }, 250);
      onCleanup(() => clearTimeout(timer));
    });
    effect(onCleanup => {
      const ownTexts = this.widgets().filter(w => w.kind === 'text').map(w => w.text || '');
      const current = this.designEvent(), user = this.sampleUser(), amount = this.sampleAmount(), tier = this.sampleTier();
      const batches = ALERT_EVENTS.map(kind => {
        const designTexts = this.designs().flatMap(d => [d.events[kind], ...(d.variants?.[kind] ?? []).map(v => v.layout)])
          .flatMap(layout => layout?.widgets.filter(w => w.kind === 'text').map(w => w.text || '') ?? []);
        return { kind, texts: [...new Set([...(kind === current ? ownTexts : []), ...designTexts])].slice(0, 100) };
      }).filter(batch => batch.texts.length);
      this.loading();
      if (!this.channel || !batches.length) return;
      let valid = true;
      const timer = setTimeout(() => {
        // Each event updates independently, so one slow render cannot hold back the others.
        for (const { kind, texts } of batches) void this.api.render(this.channel, texts, kind, user, amount, tier).then(values => {
          if (valid) { this.rendered.update(all => ({ ...all, [kind]: Object.fromEntries(texts.map((text, i) => [text, values[i]])) })); this.astError.set(''); }
        }).catch(e => { if (valid) this.astError.set(e?.error?.message || this.t('astFailed')); });
      }, 200);
      onCleanup(() => { valid = false; clearTimeout(timer); });
    });
    // A custom widget's new revision (code editor, file replace) reaches OBS only when its overlays are published again.
    let widgetRevisions: ReadonlyMap<string, number> | null = null;
    effect(() => {
      if (!this.customWidgets.list()) return;
      const next = new Map(this.customWidgets.widgets().map(widget => [widget.id, widget.revision])), previous = widgetRevisions;
      widgetRevisions = next;
      if (!previous) return;
      const changed = new Set([...previous.keys(), ...next.keys()].filter(id => previous.get(id) !== next.get(id)));
      untracked(() => {
        const affected = [...this.serverScenes.values()].filter(scene => scene.widgets.some(w => w.kind === 'custom' && changed.has(w.config?.['widgetId'] as string)));
        if (!affected.length) return;
        // New code is never in OBS yet: these overlays are not live until the API answers (and stay so if it can't).
        this.liveScenes.update(live => ({ ...live, ...Object.fromEntries(affected.map(scene => [scene.id, false])) }));
        void this.refreshLive();
      });
    });
    // Widget code saved in another tab: ask again when the Studio comes back into view.
    afterNextRender(() => {
      const visible = () => { if (document.visibilityState === 'visible') void this.refreshLive(); };
      document.addEventListener('visibilitychange', visible);
      this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', visible));
    });
    effect(onCleanup => {
      // Notices sit next to the save bar; they fade on their own instead of piling up.
      if (!this.notice()) return;
      const timer = setTimeout(() => this.notice.set(''), 8000);
      onCleanup(() => clearTimeout(timer));
    });
    inject(DestroyRef).onDestroy(() => { this.layerGesture?.(); this.flushRecovery(); this.disposed = true; this.resetSimulation(); this.assetCache.clear(); });
  }
  /** Counted strings have a `…One` variant for 1. */
  n(key: string, count: number, params: Record<string, string | number> = {}): string { return this.t(count === 1 ? key + 'One' : key, { count, ...params }); }
  t(key: string, params?: Record<string, string | number>): string {
    this.language.currentLanguage(); return this.language.translate(`overlayStudio.${key}`, params);
  }
  toggleSnap(): void { this.snap.update(v => !v); }

  // ── Studio layout ──────────────────────────────────────────────────────────
  /** Which panes show: desktop uses the side panels/drawer state, phones show one pane per bottom tab. */
  paneOn(pane: StudioPane, device: 'desktop' | 'phone'): boolean {
    const design = !!this.designDraft();
    if (device === 'phone') {
      const tab = this.mobileTab();
      switch (pane) {
        case 'layers': case 'designs': return tab === 'layers';
        // Bits looks and variants pick what you are editing: they lead the Edit tab in design mode.
        case 'variants': return tab === 'edit';
        case 'add': return tab === 'add';
        // Alert designs: the timeline follows the selected object's settings, as before.
        case 'layer': case 'timeline': return tab === 'edit';
        case 'tester': return tab === 'test';
        case 'overlay': return tab === 'more';
      }
    }
    switch (pane) {
      case 'variants': return design;
      case 'designs': return !design;
      case 'add': case 'layers': return true;
      case 'timeline': return design;
      case 'tester': return this.testOpen();
      case 'layer': return this.rightTab() === 'layer';
      case 'overlay': return this.rightTab() === 'overlay';
    }
  }
  /** A layer picked by the streamer (canvas or list) opens its settings, on phones too. */
  pick(id: string): void {
    this.select(id); this.rightTab.set('layer');
    if (this.compact()) this.mobileTab.set('edit');
  }
  /** Clicking empty canvas clears the selection, like most design tools. */
  onWorkspaceClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('.widget, .resize-handle, .studio-toolbar, .pop')) return;
    if (this.selectedId()) { this.endHistoryGroup(); this.selectedId.set(null); }
  }
  setRightTab(tab: 'layer' | 'overlay'): void { this.rightTab.set(tab); }
  /** Adding from the palette selects the new layer; on phones it also opens its settings. */
  addFromPalette(kind: WidgetKind): void { this.addWidget(kind); this.rightTab.set('layer'); if (this.compact()) this.mobileTab.set('edit'); }
  setMobileTab(tab: MobileTab): void { this.closePop(); this.mobileTab.set(tab); }
  toggleTest(): void {
    if (this.compact()) { this.setMobileTab('test'); return; }
    this.testOpen.update(open => !open);
  }
  togglePop(pop: StudioPop, event?: Event): void {
    if (this.pop() === pop) { this.closePop(); return; }
    this.popTrigger = (event?.currentTarget as HTMLElement | null) ?? null;
    this.pop.set(pop);
    setTimeout(() => (this.host.querySelector('.pop:not([hidden]) [data-autofocus]') as HTMLElement | null)?.focus(), 0);
  }
  closePop(): void {
    if (!this.pop()) return;
    this.pop.set(null); this.popTrigger?.focus(); this.popTrigger = null;
  }
  setSection(key: string, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    if (this.sections()[key] !== open) this.sections.update(all => ({ ...all, [key]: open }));
  }
  zoomIn(): void { const now = this.zoom(); this.zoomMode.set(ZOOM_STEPS.find(z => z > now + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]); }
  zoomOut(): void { const now = this.zoom(); this.zoomMode.set([...ZOOM_STEPS].reverse().find(z => z < now - 0.001) ?? ZOOM_STEPS[0]); }
  fitCanvas(): void { this.zoomMode.set('fit'); }
  toggleTheme(): void { this.theme.toggleTheme(); }
  toggleLanguage(): void { this.language.toggleLanguage(); }
  sceneLayerCount(scene: OverlayScene): number { return scene.widgets.length; }
  /**
   * Drag a row in Layers to change what shows in front; the row takes the target's place.
   * Pointer events, so it works with touch: the grip drags at once, a mouse drags the row
   * after a few pixels, and a finger holds the row briefly (a quick swipe still scrolls).
   */
  startLayerDrag(event: PointerEvent, id: string, grip = false): void {
    const target = event.target as Element;
    // The grip handles its own press first; the row then sees a gesture in progress and skips it.
    if (event.button !== 0 || this.layerGesture || target.closest('.layer-toggle')) return;
    const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('.layer-row')!, touch = event.pointerType !== 'mouse';
    const pointerId = event.pointerId, startX = event.clientX, startY = event.clientY;
    // A drop only applies to the overlay or design it started in.
    const scope = this.sceneId() + '|' + (this.designDraft()?.id ?? '');
    let started = false, hold: ReturnType<typeof setTimeout> | undefined, frame = 0, lastX = startX, lastY = startY;
    const scroller = (() => { for (let node = row.parentElement; node; node = node.parentElement) { const overflow = getComputedStyle(node).overflowY; if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node; } return document.scrollingElement as HTMLElement | null; })();
    const retarget = () => {
      const over = document.elementFromPoint(lastX, lastY)?.closest<HTMLElement>('.layer-row[data-layer-id]')?.dataset['layerId'];
      if (over) this.layerDrag.set({ id, over });
    };
    // Holding near the list's edge keeps scrolling, so rows out of view can be reached.
    const edgeScroll = () => {
      const box = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller?.getBoundingClientRect();
      const step = !scroller || !box ? 0 : lastY < box.top + 48 ? -8 : lastY > box.bottom - 48 ? 8 : 0;
      if (step) { scroller!.scrollBy(0, step); retarget(); }
      frame = requestAnimationFrame(edgeScroll);
    };
    const begin = () => {
      started = true; clearTimeout(hold); this.layerDrag.set({ id, over: id });
      try { row.setPointerCapture(pointerId); } catch { /* The pointer already ended. */ }
      if (touch) navigator.vibrate?.(12);
      frame = requestAnimationFrame(edgeScroll);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!started) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < (touch ? 8 : 4)) return;
        // A finger that moves before the hold is scrolling the list, not dragging.
        if (touch && !grip) { stop(); return; }
        begin();
      }
      lastX = e.clientX; lastY = e.clientY; retarget();
    };
    // While dragging, the page must not scroll under the finger (needs a non-passive listener).
    const touchMove = (e: TouchEvent) => { if (started) e.preventDefault(); };
    const contextMenu = (e: Event) => e.preventDefault();
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const drag = started ? this.layerDrag() : null; stop();
      if (drag && drag.over !== drag.id && scope === this.sceneId() + '|' + (this.designDraft()?.id ?? '')) this.reorderLayer(drag.id, drag.over);
    };
    const cancel = (e: PointerEvent) => { if (e.pointerId === pointerId) stop(); };
    const stop = () => {
      clearTimeout(hold); cancelAnimationFrame(frame); this.layerDrag.set(null); this.layerGesture = undefined;
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', cancel);
      removeEventListener('touchmove', touchMove); row.removeEventListener('contextmenu', contextMenu);
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', cancel);
    addEventListener('touchmove', touchMove, { passive: false }); row.addEventListener('contextmenu', contextMenu);
    this.layerGesture = stop;
    if (touch && !grip) hold = setTimeout(begin, 350);
  }
  private reorderLayer(id: string, targetId: string): void {
    this.updateWidgets(all => {
      const from = all.findIndex(w => w.id === id), to = all.findIndex(w => w.id === targetId);
      if (from < 0 || to < 0) return all;
      const next = [...all], [moved] = next.splice(from, 1); next.splice(to, 0, moved); return next;
    });
  }
  /** Snap a dragged box to the canvas edges/centre and to other visible layers (within 8 screen pixels). */
  private alignMove(id: string, x: number, y: number, width: number, height: number, pxPerUnit: number): { x: number; y: number } {
    if (!this.snap()) { this.guides.set({ v: [], h: [] }); return { x, y }; }
    const threshold = 8 / Math.max(pxPerUnit, 0.01), others = this.widgets().filter(w => w.id !== id && w.visible);
    const axis = (pos: number, size: number, targets: number[]) => {
      let best: { d: number; pos: number | null; guide: number | null } = { d: threshold, pos: null, guide: null };
      for (const target of targets) for (const offset of [0, size / 2, size]) {
        const d = Math.abs(pos + offset - target);
        if (d < best.d) best = { d, pos: Math.round(target - offset), guide: target };
      }
      return best;
    };
    const vx = axis(x, width, [0, this.canvasWidth() / 2, this.canvasWidth(), ...others.flatMap(w => [w.x, w.x + w.width / 2, w.x + w.width])]);
    const hy = axis(y, height, [0, this.canvasHeight() / 2, this.canvasHeight(), ...others.flatMap(w => [w.y, w.y + w.height / 2, w.y + w.height])]);
    this.guides.set({ v: vx.guide === null ? [] : [vx.guide], h: hy.guide === null ? [] : [hy.guide] });
    return { x: vx.pos ?? x, y: hy.pos ?? y };
  }
  /** Studio shortcuts that are not edit history: Escape, zoom and delete. Typing in fields is never intercepted. */
  private onStudioKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape' && this.pop()) { event.preventDefault(); this.closePop(); return; }
    const target = event.target instanceof Element ? event.target : null;
    // Modal dialogs (code editor, import…) own their keys: Delete or zoom there never acts on the canvas underneath.
    if (!this.loaded() || !target?.closest('app-overlay-editor') || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"]:not(.pop)')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selected() && !this.busy()) { event.preventDefault(); this.deleteSelected(); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoomIn(); }
    else if (event.key === '-') { event.preventDefault(); this.zoomOut(); }
    else if (event.key === '0') { event.preventDefault(); this.fitCanvas(); }
  }
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
  /** Bits: a look for a shared Bits rule starts as a copy of the default Bits look. */
  addBitsLook(ruleId: string): void {
    const draft = this.designDraft(); if (!draft || this.designEvent() !== 'bits') return;
    const existing = draft.variants?.bits?.find(v => v.ruleId === ruleId);
    if (existing) { this.selectVariant(existing.id); return; }
    const rule = this.bitsRules.view()?.rules.find(r => r.id === ruleId), id = this.id('look');
    const name = (rule?.name || (rule ? amountText(rule, 'en') + ' Bits' : 'Bits')).slice(0, 80);
    this.edit(() => { this.updateVariants(all => [...all, { id, name, enabled: true, ruleId, layout: clone(draft.events.bits) }]); this.selectVariant(id); }, null);
  }
  removeBitsLook(ruleId: string): void {
    const look = this.designDraft()?.variants?.bits?.find(v => v.ruleId === ruleId); if (!look) return;
    this.edit(() => { this.updateVariants(all => all.filter(v => v.id !== look.id)); if (this.variantId() === look.id) this.selectVariant(null); }, null);
  }
  previewMatchingVariant(): void {
    const draft = this.designDraft(); if (!draft) return;
    this.selectVariant(matchingVariant(draft, this.designEvent(), this.sampleRaw(), this.ruleFor(this.designEvent()))?.id ?? null); this.testDesign();
  }
  alignEdge(edge: 'left' | 'right' | 'top' | 'bottom'): void {
    const w = this.selected(); if (!w || w.locked) return;
    this.patchSelected(edge === 'left' || edge === 'right' ? {x: edge === 'left' ? 0 : this.canvasWidth() - w.width} : {y: edge === 'top' ? 0 : this.canvasHeight() - w.height});
  }
  private playingLayout(widget: OverlayWidget, kind = this.eventFor(widget)): AlertLayout | undefined {
    const design = this.designFor(widget); return design ? selectAlertLayout(design, kind, this.sampleRaw(), this.ruleFor(kind)) : undefined;
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
    // Show the new choice straight away, like picking from the motion catalog does.
    if (value !== 'none') this.testDesign();
  }
  prepareAnimationCatalog(): void { this.resetSimulation(); }
  editKeyframes(changes: Partial<OverlayWidget>): void { this.resetSimulation(); this.patchSelected(changes); }
  setMotionTime(field: 'delay' | 'enterDuration' | 'exitDuration' | 'loopDuration', event: Event): void {
    const value = Number(this.value(event)); if (!Number.isFinite(value)) return;
    const min = field === 'delay' ? 0 : field === 'loopDuration' ? .2 : .1;
    const max = field === 'delay' ? 120 : field === 'loopDuration' ? 10 : 5;
    this.patchSelected({ motion: { ...this.selectedMotion(), [field]: Math.max(min, Math.min(max, value)) } });
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
  widgetIcon(kind: WidgetKind) { return getWidgetModule(kind)?.icon ?? Layers3; }
  widgetName(widget: OverlayWidget): string { return widget.name || this.t(getWidgetModule(widget.kind)?.nameKey ?? 'canvasItem'); }
  addWidget(kind: WidgetKind, position?: { x: number; y: number }): void {
    const widget = createWidget(kind, { id: this.id(kind), placement: this.widgetPlacement(), position, defaultDesignId: this.designs()[0]?.id });
    if (!widget) return;
    this.updateWidgets(all => [...all, widget]); this.select(widget.id);
  }
  /** Places an imported widget in the current overlay; its settings start from the widget's saved values. */
  addCustomWidget(source: CustomWidgetView): void {
    if (this.designDraft()) return;
    const widget = createWidget('custom', { id: this.id('custom'), placement: 'scene' });
    if (!widget) return;
    this.updateWidgets(all => [...all, { ...widget, name: source.name, config: { widgetId: source.id } }]); this.select(widget.id);
    this.rightTab.set('layer'); if (this.compact()) this.mobileTab.set('edit');
  }
  /** Layers in this overlay that still show the widget's old name follow a rename from the code editor. */
  customWidgetRenamed(change: { id: string | null; from: string; to: string }): void {
    if (!change.id) return;
    const follows = (w: OverlayWidget) => w.kind === 'custom' && w.config?.['widgetId'] === change.id && w.name === change.from;
    if (this.widgets().some(follows)) this.updateWidgets(all => all.map(w => follows(w) ? { ...w, name: change.to } : w));
  }
  customUses(source: CustomWidgetView): number { return this.scenes().reduce((sum, scene) => sum + scene.widgets.filter(w => w.kind === 'custom' && w.config?.['widgetId'] === source.id).length, 0); }
  customHint(source: CustomWidgetView): string {
    const settings = groupFields(source.fields).reduce((sum, group) => sum + group.fields.length, 0), uses = this.customUses(source);
    return [this.n('customSettingsCount', settings), uses ? this.n('customLayerCount', uses) : ''].filter(Boolean).join(' · ');
  }
  async deleteCustomWidget(source: CustomWidgetView): Promise<void> {
    const scenes = this.scenes().filter(scene => scene.widgets.some(w => w.kind === 'custom' && w.config?.['widgetId'] === source.id));
    if (scenes.length) { this.customError.set(this.t('customDeleteInUse', { name: source.name, overlays: scenes.map(scene => scene.name).join(', ') })); return; }
    if (!window.confirm(this.t('customDeleteConfirm', { name: source.name }))) return;
    this.customBusy.set(source.id); this.customError.set('');
    try { await this.customWidgets.remove(source.id); }
    catch (e) { this.customError.set(apiMessage(e) || this.t('customDeleteFailed')); }
    finally { this.customBusy.set(''); }
  }
  private sampleAlertToWidgets(kind: AlertEvent): void {
    const name = this.sampleUser().trim().slice(0, 40) || 'Luna', amount = Math.max(1, Math.round(Number(this.sampleAmount()) || 100));
    const base = testAlert(kind === 'bits' ? 'bits' : kind === 'raid' ? 'raid' : kind === 'sub' ? 'sub' : 'follow');
    const tier = this.sampleTier() as '1000' | '2000' | '3000';
    this.widgetEnv.emit({ type: 'alert', data: { ...base, user: { id: 'test-' + name.toLowerCase(), login: name.toLowerCase(), name },
      amount: kind === 'bits' || kind === 'raid' ? amount : 1, message: kind === 'bits' ? `Cheer${amount}` : base.message, ...(kind === 'sub' ? { tier } : {}) } });
  }
  /** Custom widget tests go to the preview, or (after a confirmation) to this overlay in OBS. */
  readonly widgetTestTarget = signal<'preview' | 'obs'>('preview');
  readonly widgetTestBusy = signal(false);
  setWidgetTestTarget(target: 'preview' | 'obs'): void {
    if (target === 'obs' && this.widgetTestTarget() !== 'obs') {
      // Tests reach the published version, so only an overlay that was never published blocks them.
      if (!this.scene()?.published) { this.error.set(this.t('testPublishFirst')); return; }
      if (!window.confirm(this.t('widgetTestsObsConfirm', { overlay: this.scene().name }))) return;
    }
    this.widgetTestTarget.set(target);
  }
  private async sendWidgetTest(event: DimaEvent | null): Promise<void> {
    if (!event) return;
    if (this.widgetTestTarget() === 'preview') { this.revealStage(); this.widgetEnv.emit(event); return; }
    if (this.widgetTestBusy()) return;
    this.widgetTestBusy.set(true); this.error.set('');
    try {
      await this.api.request('POST', `${this.channel}/widget-test`, { sceneId: this.sceneId(), type: event.type, data: event.data });
      this.notice.set('testSent');
      // Then the totals that alert leads to, for widgets that read session data (best effort: maybe none listen).
      const session = event.type === 'alert' ? this.widgetEnv.obsSessionAfter(event.data) : null;
      if (session) void this.api.request('POST', `${this.channel}/widget-test`, { sceneId: this.sceneId(), type: 'session', data: session }).catch(() => {});
    } catch (e) { this.error.set((e as { error?: { message?: string } })?.error?.message || this.t('testPlaybackError')); }
    finally { this.widgetTestBusy.set(false); }
  }
  sendWidgetChat(kind: ChatTest): void { void this.sendWidgetTest(this.widgetEnv.chatTest(kind)); }
  sendWidgetAlert(kind: AlertTest): void { void this.sendWidgetTest(this.widgetEnv.alertTest(kind)); }
  deleteWidgetMessage(): void { void this.sendWidgetTest(this.widgetEnv.deleteTest()); }
  clearWidgetChat(): void { void this.sendWidgetTest(this.widgetEnv.clearTest()); }
  /** Bot events and live state the overlay's custom widgets ask for (widget.json `uses`). */
  readonly botTests = computed(() => {
    const uses = new Set(this.widgets().filter(widget => widget.kind === 'custom').flatMap(widget => this.customWidgets.widget(widget.config?.['widgetId'])?.manifest?.uses ?? []));
    return BOT_TEST_USES.filter(([, use]) => uses.has(use)).map(([kind]) => kind);
  });
  sendBotTest(kind: BotTestKind): void {
    if (!isStateTest(kind)) {
      // Paired events (TTS, pet, duel, roulette) send their second half a few seconds later, like the real ones.
      const { now, later } = botTestEvents(kind);
      void this.sendWidgetTest(now);
      if (later) setTimeout(() => void this.sendWidgetTest(later), 3000);
    } else {
      const value = testState(kind);
      if (this.widgetTestTarget() === 'preview') { this.revealStage(); this.widgetEnv.setState(kind, value); }
      else void this.sendWidgetTest({ type: 'state', data: { name: kind, value } });
    }
  }
  /**
   * "Replay recent chat": the channel's last 20 messages (text only), in order, a little apart. Preview only: stored
   * history keeps messages moderators deleted, which must never reach the stream.
   */
  readonly replaying = signal(false);
  async replayChat(): Promise<void> {
    if (this.replaying() || this.widgetTestTarget() !== 'preview') return;
    this.replaying.set(true); this.error.set('');
    try {
      const { messages } = await this.customWidgets.chatHistory();
      if (!messages.length) { this.notice.set('widgetTestReplayEmpty'); return; }
      this.revealStage();
      for (const message of messages) {
        this.widgetEnv.emit({ type: 'chat', data: message });
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    } catch { this.error.set(this.t('widgetTestReplayFailed')); }
    finally { this.replaying.set(false); }
  }
  /** "Send a signal": what $(widget.signal name value) would send, from you. */
  readonly signalName = signal('');
  readonly signalValue = signal('');
  /** Signals the overlay's widgets declare in widget.json (quick picks). */
  private readonly shareLayers = effect(() => { const layers = this.widgets(); untracked(() => this.widgetEnv.sceneLayers.set(layers)); });
  readonly declaredSignals = computed(() => [...new Set(this.widgets().filter(w => w.kind === 'custom')
    .flatMap(w => this.customWidgets.widget(w.config?.['widgetId'])?.manifest?.signals?.map(s => s.name) ?? []))].slice(0, 12));
  sendWidgetSignal(): void {
    const name = this.signalName().trim().toLowerCase();
    if (!/^[a-z0-9_]{1,40}$/.test(name)) { this.error.set(this.t('widgetTestSignalInvalid')); return; }
    this.error.set('');
    const user = this.auth.session()?.twitchUser;
    void this.sendWidgetTest(this.widgetEnv.signalTest(name, this.signalValue(), null,
      { id: this.channel, login: user?.login ?? this.streamer, name: user?.display_name ?? this.streamer }));
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
    if (event.pointerType === 'touch' && action === 'move' && this.selectedId() !== widget.id) { this.pick(widget.id); return; }
    event.preventDefault(); event.stopPropagation();
    const canvas = (event.currentTarget as HTMLElement).closest('.stage')?.getBoundingClientRect();
    // Cancelling pointerdown also cancels the browser's focus; focus the source so arrow keys work next.
    ((event.currentTarget as HTMLElement).closest('.widget') as HTMLElement | null)?.focus({ preventScroll: true });
    if (canvas) { this.pick(widget.id); this.pointer = { id: widget.id, action, startX: event.clientX, startY: event.clientY, original: { ...widget }, canvas }; }
  }
  onPointerMove(event: PointerEvent): void {
    if (this.busy() || this.loading()) return;
    const s = this.pointer; if (!s) return;
    const dx = (event.clientX-s.startX)/s.canvas.width*this.canvasWidth(), dy = (event.clientY-s.startY)/s.canvas.height*this.canvasHeight();
    if (s.action === 'move') {
      const moved = this.alignMove(s.id, this.round(s.original.x+dx), this.round(s.original.y+dy), s.original.width, s.original.height, s.canvas.width/this.canvasWidth());
      this.patch(s.id, moved);
    } else this.patch(s.id, { width: Math.max(20,this.round(s.original.width+dx)), height: Math.max(20,this.round(s.original.height+dy)) });
  }
  stopPointer(): void { if (this.pointer) this.endHistoryGroup(); this.pointer = null; if (this.guides().v.length || this.guides().h.length) this.guides.set({ v: [], h: [] }); }
  onWidgetKeydown(event: KeyboardEvent, widget: OverlayWidget): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.pick(widget.id); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedId() === widget.id) { event.preventDefault(); this.deleteSelected(); return; }
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
  setTriggerPlacement(event: Event): void {
    const mode = this.value(event);
    if (this.selected()?.kind !== 'trigger' || (mode !== 'fixed' && mode !== 'random')) return;
    this.patchSelected({ triggerPlacement: { mode, margin: this.selected()?.triggerPlacement?.margin ?? 24 } });
  }
  setTriggerMargin(event: Event): void {
    const widget = this.selected(), input = event.target as HTMLInputElement, margin = Number(input.value);
    if (widget?.kind !== 'trigger' || widget.triggerPlacement?.mode !== 'random') return;
    if (!input.value || !Number.isFinite(margin)) { input.value = String(widget.triggerPlacement.margin); return; }
    this.patchSelected({ triggerPlacement: { mode: 'random', margin: Math.max(0, Math.min(500, Math.round(margin))) } });
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
  deleteSelected(): void {
    this.updateWidgets(all=>all.filter(w=>w.id!==this.selectedId())); this.selectedId.set(this.widgets().at(-1)?.id ?? null);
    // The focused source or button just disappeared: keep focus in the studio so Ctrl+Z still undoes.
    (this.host.querySelector('.workspace') as HTMLElement | null)?.focus({ preventScroll: true });
  }
  moveLayer(direction: -1 | 1): void {
    const all=[...this.widgets()], index=all.findIndex(w=>w.id===this.selectedId()), next=index+direction;
    if(index<0||next<0||next>=all.length) return;
    [all[index],all[next]]=[all[next],all[index]]; this.updateWidgets(()=>all);
  }
  switchScene(id: string): void { if (id === this.sceneId()) return; this.layerGesture?.(); this.stopPointer(); this.endHistoryGroup(); this.confirmRotate.set(false); this.confirmDelete.set(false); this.resetSimulation(); this.sceneId.set(id); this.selectedId.set(this.widgets()[0]?.id ?? null); this.saved.set(false); }
  newScene(): void {
    const scene=makeScene(this.id('overlay'),this.t('newOverlay'),this.designs()[0].id); scene.widgets=[]; scene.publicId='';
    this.stopPointer(); this.edit(() => { this.scenes.update(all=>[...all,scene]); this.sceneId.set(scene.id); this.selectedId.set(null); this.resetSimulation(); }, null);
  }
  openDesign(id?: string): void {
    if (this.designDraft() && this.dirty() && !window.confirm(this.t('discardDesign'))) return;
    this.stopPointer(); this.endHistoryGroup(); this.resetSimulation();
    const design=this.designs().find(d=>d.id===id) ?? makeDesign(this.id('design'),this.t('newDesign'));
    this.designDraft.set(clone(design)); this.variantId.set(null); this.designEvent.set('follow'); this.selectedId.set(this.widgets()[1]?.id ?? this.widgets()[0]?.id ?? null); this.saved.set(false);
    // Opening a design is to edit it: show the object's settings (and, on phones, its timeline).
    this.rightTab.set('layer'); if (this.compact()) this.mobileTab.set('edit');
  }
  async closeDesign(): Promise<void> { if (!await this.saveDesign()) return; this.stopPointer(); this.endHistoryGroup(); this.resetSimulation(); this.designDraft.set(null); this.selectedId.set('alert-1'); this.previewDesign.set(false); this.saved.set(false); if (this.compact()) this.mobileTab.set('layers'); }
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
  renderText(text='$(user)', widget?: OverlayWidget, kind: AlertEvent = widget?.kind === 'alert' ? this.eventFor(widget) : this.designEvent()): string {
    const event = widget && [this.active(), ...this.parallel()].find(e => e && !e.preparing && widget.events?.includes(e.kind as AlertEvent));
    const prepared = widget && this.designDraft() && (this.previewDesign() || this.timeline()) ? this.playbackTexts() : event?.texts;
    return prepared?.[text] ?? this.rendered()[kind]?.[text] ?? text;
  }
  alertLayout(widget: OverlayWidget): OverlayWidget[] { return this.playingLayout(widget)?.widgets ?? []; }
  eventFor(widget: OverlayWidget): AlertEvent {
    const playing=[this.active(),...this.parallel()].find(e=>e&&widget.events?.includes(e.kind as AlertEvent));
    return playing?.kind as AlertEvent ?? widget.events?.[0] ?? 'follow';
  }
  isPlaying(widget: OverlayWidget): boolean {
    return this.designDraft()?this.previewDesign():[this.active(),...this.parallel()].some(e=>e&&!e.preparing&&(widget.kind===e.kind && (!e.targets || e.targets.includes(widget.id)) || widget.kind==='alert'&&widget.events?.includes(e.kind as AlertEvent)));
  }
  changeTestChannel(event: Event): void { this.resetSimulation(); this.channelChoice.set(this.value(event)); }
  testBusy(kind: EventKind): boolean {
    return (kind === 'clip' || kind === 'trigger' || kind === 'tts') && [...this.queue(), this.active(), ...this.parallel()].some(e => e?.kind === kind);
  }
  mediaEvents(widget: OverlayWidget): MockEvent[] {
    if (this.designDraft()) return [];
    return [this.active(), ...this.parallel()].filter((e): e is MockEvent => Boolean(e?.media && e.targets?.includes(widget.id)));
  }
  previewPlacement(widget: OverlayWidget): OverlayWidget {
    return this.mediaEvents(widget).find(event => event.kind === 'trigger')?.placements?.find(w => w.id === widget.id) ?? widget;
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
    // Custom widgets get the same sample alert (viewer, amount and tier from the Test drawer).
    const widgetAlert = ALERT_EVENTS.includes(kind as AlertEvent) && this.customLayers();
    if (widgetAlert) this.sampleAlertToWidgets(kind as AlertEvent);
    const real = kind === 'clip' || kind === 'trigger' || kind === 'tts',channel = this.testChannel();
    if (real && (!this.auth.hasValidSession() || !channel)) { this.notice.set('testSignIn'); return; }
    const targets = real ? this.widgets().filter(w => w.visible && w.kind === kind).map(w => w.id) : alertPlacementIds(this.widgets(),kind);
    if (!targets.length) { if (!widgetAlert) this.notice.set('testAddSource'); return; }
    const event: MockEvent = {id:this.nextId++,kind,serialized:this.scene().waitFor.includes(kind),preparing:true,targets,...(real && channel ? {channel:{...channel}} : {})};
    this.queue.update(queue => [...queue,event]); this.runNext();
  }
  private runNext(): void {
    const occupied = new Set([this.active(),...this.parallel()].flatMap(event => event?.originalTargets ?? event?.targets ?? []).filter(id => this.widgets().some(w => w.id === id && w.kind === 'alert')));
    let index: number;
    while ((index = this.queue().findIndex(event => (!event.serialized || !this.active()) && !(event.targets ?? []).some(id => occupied.has(id)))) >= 0) {
      const event = this.queue()[index]; this.queue.update(queue => queue.filter((_,i) => i !== index));
      if (event.serialized) this.active.set(event); else this.parallel.update(all => [...all,event]);
      for (const id of event.targets ?? []) if (this.widgets().some(w => w.id === id && w.kind === 'alert')) occupied.add(id);
      this.startEvent(event);
    }
  }
  private startEvent(event: MockEvent): void {
    const visible = new Set(this.widgets().filter(w => w.visible).map(w => w.id)),targets = event.targets?.filter(id => visible.has(id)) ?? [];
    if (!targets.length) { this.finishEvent(event.id); return; }
    const job: MediaJob = {pending:new Set(targets),started:new Set(),timers:new Map()}; this.jobs.set(event.id,job);
    const snapshot = clone(this.renderScene());
    let canceled = false; job.cancel = () => { canceled = true; };
    if (!event.channel) {
      void this.prepareAlert('event-'+event.id,event.kind as AlertEvent).then(async texts => {
        if (!texts || canceled || !this.jobs.has(event.id)) { if (!canceled) this.finishEvent(event.id); return; }
        const layouts = Object.fromEntries(snapshot.widgets.filter(w => targets.includes(w.id)).flatMap(widget => {
          const design = snapshot.designs.find(d => d.id === widget.designId); if (!design) return [];
          const layout = selectAlertLayout(design,event.kind as AlertEvent,this.sampleRaw(),this.ruleFor(event.kind as AlertEvent));
          return [[design.id,{...layout,widgets:layout.widgets.map(layer => layer.kind === 'text' ? {...layer,text:texts[layer.text || ''] ?? layer.text} : layer)}]];
        }));
        const assets = await this.prepareAssets(Object.values(layouts),() => !canceled && this.jobs.has(event.id));
        if (canceled || !this.jobs.has(event.id)) { assets.forEach(asset => asset.release()); return; }
        this.mountEvent({...event,preparing:false,texts,layouts,snapshot,assets},targets);
      }); return;
    }
    this.notice.set('preparingTest');
    const widgets = snapshot.widgets.filter(w => targets.includes(w.id));
    const triggerIds = widgets.some(w => w.triggerIds === undefined) ? undefined : [...new Set(widgets.flatMap(w => w.triggerIds ?? []))];
    if (event.kind === 'trigger' && triggerIds?.length === 0) { this.notice.set('noMatchingTriggers'); this.finishEvent(event.id); return; }
    void this.api.request<{media?:TestMedia;triggerId?:string;text?:string}>('POST',`${this.channel}/test`,{
      kind:event.kind,destination:'preview',sceneId:this.sceneId(),triggerIds,language:this.language.currentLanguage()
    },90000).then(result => {
      if (canceled || !this.jobs.has(event.id)) return;
      if (!result.media) throw new Error(this.t('testPlaybackError'));
      const media = {...result.media,triggerId:result.triggerId}; if (media.url.startsWith('/')) media.url = this.api.base+media.url;
      const selected = event.kind === 'trigger' ? targets.filter(id => snapshot.widgets.some(w => w.id === id && matchesTrigger(w,media.triggerId))) : targets;
      if (!selected.length) { this.notice.set('noMatchingTriggers'); this.finishEvent(event.id); return; }
      const placements = snapshot.widgets.filter(w => selected.includes(w.id)).map(w => placeTrigger(w,snapshot,String(event.id)));
      this.mountEvent({...event,preparing:false,media,text:result.text,snapshot,placements},selected); this.notice.set('mediaReady');
    }).catch(error => { if (!canceled && this.jobs.has(event.id)) { this.error.set(error?.error?.message || this.t('testPlaybackError')); this.finishEvent(event.id); } });
  }
  private mountEvent(event: MockEvent,targets: string[]): void {
    const job = this.jobs.get(event.id); if (!job || !event.snapshot) return;
    job.pending = new Set(targets); event.targets = targets; event.originalTargets = [...targets];
    const patch = (current: MockEvent) => current.id === event.id ? event : current;
    this.active.update(current => current ? patch(current) : current); this.parallel.update(all => all.map(patch));
    // A designed alert's own clock starts when the renderer shows it (rendererReady).
    for (const widget of event.snapshot.widgets.filter(w => targets.includes(w.id))) {
      const seconds = placementMountSeconds({id:event.id,kind:event.kind,media:event.media,layouts:event.layouts},widget);
      job.timers.set(widget.id,this.later(() => this.mediaFinished(event.id,widget.id),seconds*1000));
    }
  }
  rendererReady(report: { id: OverlayPlaybackId }): void {
    if (typeof report.id === 'string' && report.id.startsWith('static:')) {
      this.shownDesign = report.id;
      if (this.designShown?.key === report.id) { const run = this.designShown.run; this.designShown = undefined; run(); }
      return;
    }
    const id = Number(report.id), job = this.jobs.get(id);
    const event = [this.active(),...this.parallel()].find(item => item?.id === id); if (!job || !event?.snapshot) return;
    for (const widget of event.snapshot.widgets.filter(w => job.pending.has(w.id))) {
      clearTimeout(job.timers.get(widget.id));
      const seconds = placementStartSeconds({id,kind:event.kind,media:event.media,layouts:event.layouts},widget);
      job.timers.set(widget.id,this.later(() => this.mediaFinished(id,widget.id),seconds*1000));
    }
  }
  private async prepareAssets(layouts: AlertLayout[],valid: () => boolean = () => true): Promise<Map<string,PreparedAsset>> {
    const generation = this.playbackGeneration;
    const ids = new Set(layouts.flatMap(layout => [...layout.widgets.filter(w => w.visible && (w.kind === 'image' || w.kind === 'video') && w.assetId).map(w => w.assetId!),...(layout.sound ? [layout.sound.assetId] : [])]));
    const assets = new Map<string,PreparedAsset>();
    const sources = await Promise.all([...ids].map(async id => {
      // Reusing a recent link keeps the bytes the cache already holds; links last 15 minutes.
      const recent = this.previewLinks.get(id);
      if (recent && Date.now() - recent.at < 10 * 60_000) return {id,url:recent.url};
      try { const url = await this.assetLibrary.preview(this.channel,id); this.previewLinks.set(id,{url,at:Date.now()}); return {id,url}; } catch { return null; }
    }));
    if (this.disposed || generation !== this.playbackGeneration || !valid()) return assets;
    // Register ownership before preparing: the shared loader retains encoded
    // bytes only for the current source set, within its 64 MiB OBS cache cap.
    this.assetCache.warm(sources.flatMap(source => source ? [source.url] : []));
    await Promise.all(sources.map(async source => {
      if (!source) return;
      const asset = await this.assetCache.prepare(source.url); if (asset) assets.set(source.id,asset);
    }));
    if (this.disposed || generation !== this.playbackGeneration || !valid()) { assets.forEach(asset => asset.release()); return new Map(); }
    if (typeof document !== 'undefined' && document.fonts && layouts.some(layout => layout.widgets.some(w => w.visible && w.kind === 'text'))) {
      await Promise.race([Promise.all(['400','700'].map(weight => document.fonts.load(`${weight} 40px 'Plus Jakarta Sans'`))).catch(() => {}),new Promise(resolve => setTimeout(resolve,1500))]);
    }
    return assets;
  }
  mediaStarted(id: number,widgetId: string,actualDuration?: number): void {
    const job = this.jobs.get(id); if (!job || job.started.has(widgetId)) return; job.started.add(widgetId);
    clearTimeout(job.timers.get(widgetId));
    const event = [this.active(),...this.parallel()].find(event => event?.id === id); if (!event) return;
    const seconds = placementMediaSeconds({id:event.id,kind:event.kind,media:event.media},actualDuration);
    job.timers.set(widgetId,this.later(() => this.mediaFinished(id,widgetId),seconds*1000));
  }
  mediaFinished(id: number,widgetId: string,error = false): void {
    const job = this.jobs.get(id); if (!job || !job.pending.delete(widgetId)) return;
    clearTimeout(job.timers.get(widgetId)); job.timers.delete(widgetId);
    if (error) this.notice.set('testPlaybackError');
    const retain = (event: MockEvent) => event.id === id ? {...event,targets:event.targets?.filter(target => target !== widgetId),placements:event.placements?.filter(w => w.id !== widgetId)} : event;
    this.active.update(event => event ? retain(event) : event); this.parallel.update(all => all.map(retain));
    if (!job.pending.size) this.finishEvent(id);
  }
  private finishEvent(id: number): void {
    this.previewPreparations.get('event-'+id)?.abort();
    const event = [this.active(),...this.parallel()].find(event => event?.id === id); event?.assets?.forEach(asset => asset.release());
    const job = this.jobs.get(id); this.jobs.delete(id); job?.timers.forEach(timer => {clearTimeout(timer);this.timers.delete(timer);}); job?.cancel?.();
    this.parallel.update(all => all.filter(event => event.id !== id)); if (this.active()?.id === id) this.active.set(null);
    this.runNext();
  }
  private reconcileTests(): void {
    const visible = new Set(this.widgets().filter(w => w.visible).map(w => w.id));
    for (const [id,job] of this.jobs) for (const target of [...job.pending]) if (!visible.has(target)) this.mediaFinished(id,target);
  }
  failMedia(): void { const active = this.active(); if (active) { this.notice.set('mediaReleased'); this.finishEvent(active.id); } }
  seekTimeline(time: number): void {
    this.designRequest++;
    this.previewPreparations.get('timeline')?.abort();
    if (!this.designDraft()) return;
    if (!this.timeline()) { this.resetSimulation(); this.motionReplay.update(n => n + 1); }
    if (this.timelineFrame) cancelAnimationFrame(this.timelineFrame);
    this.timeline.set({ time: Math.max(0, Math.min(this.editingLayout()!.duration, time)), playing: false, seek: ++this.timelineSeek });
  }
  async toggleTimeline(): Promise<void> {
    const current = this.timeline();
    if (current?.playing) { this.seekTimeline(current.time); return; }
    const duration = this.editingLayout()?.duration ?? 5;
    this.seekTimeline(current && current.time < duration ? current.time : 0);
    const preparation = this.timelineSeek, generation = this.playbackGeneration;
    const texts = await this.prepareAlert('timeline');
    if (!texts || !this.timeline() || preparation !== this.timelineSeek || generation !== this.playbackGeneration) return;
    this.playbackTexts.set(texts);
    const assets = await this.prepareAssets([this.editingLayout()!],() => preparation === this.timelineSeek && !!this.timeline());
    if (!this.timeline() || this.disposed || preparation !== this.timelineSeek || generation !== this.playbackGeneration) { assets.forEach(asset => asset.release()); return; }
    // Same media as on screen: keep it, nothing reloads. New media: a fresh replay waits for it.
    const onScreen = this.designAssets();
    if (assets.size === onScreen.size && [...assets.keys()].every(id => onScreen.has(id))) assets.forEach(asset => asset.release());
    else { onScreen.forEach(asset => asset.release()); this.designAssets.set(assets); this.motionReplay.update(n => n + 1); }
    // The playhead moves only once the replay is shown whole.
    this.whenDesignShown(() => {
      if (!this.timeline() || this.disposed || preparation !== this.timelineSeek || generation !== this.playbackGeneration) return;
      const start = this.timeline()!.time, began = performance.now(), seek = this.timelineSeek;
      this.timeline.set({ time: start, playing: true, seek });
      const tick = () => {
        const time = Math.min(duration, start + (performance.now() - began) / 1000);
        this.timeline.set({ time, playing: time < duration, seek });
        if (time < duration) this.timelineFrame = requestAnimationFrame(tick);
      };
      this.timelineFrame = requestAnimationFrame(tick);
    });
  }
  pauseHiddenTimeline(): void { const clock = this.timeline(); if (document.hidden && clock?.playing) this.seekTimeline(clock.time); }
  closeTimeline(): void { this.previewPreparations.get('timeline')?.abort(); if (this.timelineFrame) cancelAnimationFrame(this.timelineFrame); this.timeline.set(null); }
  editTimeline(change: TimelineEdit): void {
    this.resetSimulation();
    this.edit(() => this.updateLayout(layout => change.id === '$sound'
      ? { ...layout, sound: layout.sound ? { ...layout.sound, [change.field]: change.value } : undefined }
      : { ...layout, widgets: layout.widgets.map(w => w.id === change.id ? { ...w, motion: { ...(w.motion ?? defaultMotion(w.kind)), [change.field]: change.value } } : w) }), 'timeline:' + change.id + ':' + change.field);
  }
  async testDesign(): Promise<void> {
    const request = ++this.designRequest;
    this.closeTimeline(); this.revealStage();
    if (this.designPreviewTimer) { clearTimeout(this.designPreviewTimer); this.timers.delete(this.designPreviewTimer); }
    this.previewDesign.set(false);
    const generation = this.playbackGeneration;
    const texts = await this.prepareAlert('design');
    if (!texts || generation !== this.playbackGeneration || request !== this.designRequest) return;
    const assets = await this.prepareAssets([this.editingLayout()!],() => request === this.designRequest);
    if (this.disposed || !this.designDraft() || generation !== this.playbackGeneration || request !== this.designRequest) { assets.forEach(asset => asset.release()); return; }
    this.designAssets().forEach(asset => asset.release()); this.designAssets.set(assets);
    this.playbackTexts.set(texts);
    this.motionReplay.update(value => value + 1); this.previewDesign.set(true);
    // The preview's clock starts once the renderer shows it whole; the longer bound covers a stalled picture.
    const duration = (this.editingLayout()?.duration ?? 5) * 1000;
    this.designPreviewTimer = this.later(() => this.previewDesign.set(false), duration + ALERT_READY_LIMIT_MS + 2000);
    this.whenDesignShown(() => {
      if (request !== this.designRequest || !this.previewDesign()) return;
      if (this.designPreviewTimer) { clearTimeout(this.designPreviewTimer); this.timers.delete(this.designPreviewTimer); }
      this.designPreviewTimer = this.later(() => this.previewDesign.set(false), duration);
    });
  }
  private resetSimulation(): void { this.designShown = undefined; this.playbackGeneration++; this.designRequest++; this.playbackTexts.set(null); this.previewPreparations.forEach(controller => controller.abort()); this.previewPreparations.clear(); this.closeTimeline(); this.previewDesign.set(false); this.jobs.forEach(job => job.cancel?.()); [this.active(),...this.parallel()].forEach(event => event?.assets?.forEach(asset => asset.release())); this.designAssets().forEach(asset => asset.release()); this.designAssets.set(new Map()); this.jobs.clear(); this.timers.forEach(t=>clearTimeout(t));this.timers.clear();this.active.set(null);this.parallel.set([]);this.queue.set([]); }
  private async prepareAlert(key: string, kind = this.designEvent()): Promise<Record<string, string> | null> {
    this.previewPreparations.get(key)?.abort();
    const controller = new AbortController();
    this.previewPreparations.set(key, controller);
    this.notice.set('preparingTest');
    try {
      // Settle the requested draft/variant before resolving its sample text.
      // Targeted media is prepared separately, with the OBS asset loader.
      const rendered = await new Promise<boolean>(resolve => {
        const abort = () => { ref.destroy(); resolve(false); };
        const ref = afterNextRender(() => { controller.signal.removeEventListener('abort', abort); resolve(true); }, { injector: this.injector });
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      if (!rendered || controller.signal.aborted || this.disposed) return null;
      const texts = await this.resolvePlaybackTexts(kind);
      if (controller.signal.aborted || this.disposed) return null;
      this.astError.set(''); if (this.notice() === 'preparingTest') this.notice.set('');
      return texts;
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        this.astError.set((error as { error?: { message?: string } })?.error?.message || this.t('astFailed'));
        if (this.notice() === 'preparingTest') this.notice.set('');
      }
      controller.abort();
      return null;
    } finally {
      if (this.previewPreparations.get(key) === controller) this.previewPreparations.delete(key);
    }
  }
  private async resolvePlaybackTexts(kind: AlertEvent): Promise<Record<string, string>> {
    const widgets = this.designDraft() ? this.widgets() : this.widgets()
      .filter(w => w.visible && w.kind === 'alert' && w.events?.includes(kind))
      .flatMap(w => this.playingLayout(w, kind)?.widgets ?? []);
    const texts = [...new Set(widgets.filter(w => w.visible && w.kind === 'text').map(w => w.text ?? ''))];
    const user = this.sampleUser(), amount = this.sampleAmount(), tier = this.sampleTier();
    // The API accepts at most 100 templates per request; never leave later layers unresolved.
    const batches = Array.from({ length: Math.ceil(texts.length / 100) }, (_, i) => texts.slice(i * 100, (i + 1) * 100));
    const rendered = await Promise.all(batches.map(async batch => {
      const values = await this.api.render(this.channel, batch, kind, user, amount, tier);
      if (!Array.isArray(values) || values.length !== batch.length || values.some(value => typeof value !== 'string')) throw new Error('Invalid AST preview response');
      return batch.map((text, i) => [text, values[i]] as const);
    }));
    return Object.fromEntries(rendered.flat());
  }
  async publish(): Promise<void> {
    if (!(this.designDraft() ? await this.saveDesign() : await this.persist())) return;
    this.busy.set(true);
    try { this.accept(await this.api.action(this.channel, this.sceneId(), this.revision, 'publish')); this.notice.set('publishedNotice'); }
    catch (e) { this.report(e); } finally { this.busy.set(false); }
  }
  async regenerateUrl(): Promise<void> {
    if (!this.confirmRotate()) { this.confirmRotate.set(true); return; }
    this.busy.set(true);
    try { const state = await this.api.action(this.channel, this.sceneId(), this.revision, 'rotate'); this.rememberServerState(state); this.revision = state.revision; if (state.live) this.liveScenes.set(state.live); else void this.refreshLive(); const remote = state.scenes.find(s => s.id === this.sceneId())!; this.scenes.update(all => all.map(s => s.id === remote.id ? { ...s, publicId: remote.publicId } : s)); this.notice.set('urlRegenerated'); this.confirmRotate.set(false); }
    catch (e) { this.report(e); } finally { this.busy.set(false); }
  }
  async saveDraft(): Promise<void> { if (this.designDraft()) await this.saveDesign(); else await this.persist(); }
  private liveRequest = 0;
  /** Asks the API again (new custom widget code changes what publishing would send). */
  private async refreshLive(): Promise<void> {
    if (!this.channel || !this.loaded()) return;
    const request = ++this.liveRequest;
    try {
      const status = await this.api.live(this.channel);
      // Only the newest answer counts, and only about the saved draft open here.
      if (!this.disposed && request === this.liveRequest && status?.revision === this.revision && status.live) this.liveScenes.set(status.live);
    } catch { /* overlays already marked not live stay that way until the next answer */ }
  }
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
    this.revision = state.revision; this.scenes.set(state.scenes); this.designs.set(state.designs.map(withoutLegacyBitsLooks));
    if (!state.scenes.some(s => s.id === this.sceneId())) this.sceneId.set(state.scenes[0].id);
    this.loaded.set(true);
    this.savedDocument.set(this.documentFingerprint());
    this.savedContent.set(new Map(this.scenes().map(scene => [scene.id, this.sceneContent(scene, this.designs())])));
    // Without a status (the API couldn't work it out) nothing counts as live until it answers again.
    this.liveScenes.set(state.live ?? {}); if (!state.live) void this.refreshLive();
    this.recovered.set(false); this.conflict.set(false); this.recoveryRequestId = null;
    // Saving makes the account draft current, so a recovery copy the user passed over is stale now.
    if (!preserveRecovery) { this.discardRecovery(); this.recovery.set(null); }
    this.clearRecovery();
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
    const initial = !this.loaded(), rescan = initial || !!this.recovery();
    this.loading.set(true); this.error.set(''); this.stopPointer();
    try {
      if (this.owner()) {
        this.channel = (await firstValueFrom(this.auth.resolveChannelID(this.streamer))) || '';
        if (!this.channel) throw new Error('Channel unavailable');
        // Look before loading, so a copy can still be restored if loading fails.
        if (initial) this.findRecovery();
        void this.bitsRules.load(this.channel);
        void this.customWidgets.load(this.channel).then(() => { if (this.customWidgets.enabled()) void this.widgetEnv.loadSession(); });
        const state = await this.api.load(this.channel);
        if (this.disposed) return;
        // Replace local work only after the server has returned a complete saved draft.
        this.resetSimulation(); this.designDraft.set(null);
        // Reloading saves nothing, so an offered copy stays offered.
        this.accept(state, true); this.history.clear();
        // Now that the saved draft is known, copies that match it are deleted instead of offered.
        if (rescan) this.findRecovery();
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
    this.onStudioKey(event);
    if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('app-overlay-editor') || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"]')) return;
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
    else this.clearRecovery();
  }
  /** Removes this editor's own copy and the copy it restored; a copy still on offer is left alone. */
  private clearRecovery(): void {
    try {
      this.draftStorage.clear(this.channel);
      if (this.consumedRecovery) this.draftStorage.discard(this.consumedRecovery);
      this.consumedRecovery = null; this.storageError.set(false);
    } catch { this.storageError.set(true); }
  }
  private findRecovery(): void {
    try { this.recovery.set(this.draftStorage.find(this.channel, this.loaded() ? draft => this.matchesSaved(draft) : undefined)); }
    catch { this.storageError.set(true); }
  }
  /** True when a recovery copy holds nothing beyond the draft just loaded from the account. */
  private matchesSaved(draft: LocalOverlayDraft): boolean {
    const scenes = (list: readonly DraftScene[]) => list.map(scene => { const { publicId: _publicId, published: _published, revision: _revision, ...rest } = scene as OverlayScene; return rest; });
    const design = (value: AlertDesign) => { const { revision: _revision, ...rest } = withoutLegacyBitsLooks(value); return rest; };
    const saved = this.designs();
    if (canonicalJson([scenes(draft.scenes), draft.designs.map(design)]) !== canonicalJson([scenes(this.scenes()), saved.map(design)])) return false;
    const open = draft.designDraft, match = open && saved.find(d => d.id === open.id);
    return !open || (!!match && canonicalJson(design(open)) === canonicalJson(design(match)));
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
    this.designs.set(draft.designs.map(withoutLegacyBitsLooks)); this.designDraft.set(draft.designDraft && withoutLegacyBitsLooks(draft.designDraft)); this.sceneId.set(draft.sceneId);
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
      await this.api.request('POST', `${this.channel}/test`, { kind, sceneId: this.sceneId(), destination: 'obs', confirmed: true, language: this.language.currentLanguage(), user: this.sampleUser(), amount: Number(this.sampleAmount()), tier: this.sampleTier() }, 90000);
      this.notice.set('testSent');
    } catch(e) { this.error.set((e as {error?: {message?: string}})?.error?.message || this.t('testPlaybackError')); }
    finally { this.liveTesting.set(false); }
  }
  private round(value:number):number{return this.snap()?Math.round(value/10)*10:Math.round(value);}
}
