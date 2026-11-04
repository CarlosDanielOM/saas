import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical,
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, BringToFront, Check, ChevronDown, CircleHelp, Clapperboard, Copy, CopyPlus, Crown,
  ExternalLink, Eye, EyeOff, FlaskConical, Grid3x3, Image, Layers3, Link2, LockKeyhole, LockOpen, LucideAngularModule, Magnet,
  Monitor, PanelsTopLeft, Play, Plus, Radio, Redo2, Scan, SendToBack, Settings2, Sparkles, Square, Trash2, Type, Undo2, Volume2, VolumeX, X, Zap, ZoomIn, ZoomOut,
  type LucideIconData
} from 'lucide-angular';

import { LanguageService } from '../../../../services/language.service';
import { ThemeService } from '../../../../services/theme.service';
import { OverlayClipComponent } from '../../../overlays/overlay-clip.component';
import { OverlayWidgetHostComponent } from '../../../overlays/overlay-widget-host.component';
import { createWidget } from '../../../overlays/overlay-widget-registry';
import type { OverlayWidget } from '../../../overlays/overlay.model';
import type { ClipDesignVariant } from '../../../clips/clips.model';
import { OswCopy } from './osw-copy';
import {
  ALERT_EVENTS, CLIP_LOOKS, FREE_CLIP_LOOKS, LOOPS, MOTIONS, PALETTE, PLAYS, POLL_STAGES, PREDICTION_STAGES, SIZES, TEST_KINDS, TRIGGERS,
  makeLayer, startingScenes,
  type AlertEvent, type Background, type Design, type Handle, type Kind, type Layer, type Scene, type TestKind
} from './osw-model';

type Pane = 'layers' | 'add' | 'edit' | 'designs' | 'overlay';
type Pop = 'test' | 'obs' | 'scenes' | 'help' | 'mock';
type Rect = { x: number; y: number; w: number; h: number };
interface Gesture { mode: 'move' | 'resize'; id: string; handle?: Handle; sx: number; sy: number; orig: Rect; recorded: boolean; ratio: number }
interface Play { kind: TestKind; key: number; user: string; amount: string; tier: string; at?: { x: number; y: number }; trigger?: string; stage?: string }
interface Toast { text: string; key: number; action?: { label: string; run: () => void } }

const ZOOMS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];
const STYLED: Kind[] = ['image', 'video', 'shape', 'text'];
const HISTORY_LIMIT = 80;

/**
 * Overlay Studio, wide layout (mock). StreamElements' editor shape — layers on the left,
 * a zoomable full-size canvas, a floating tool bar with Test, collapsible setting groups —
 * with DomDimaBot's Live First look, plain-language settings, real widget previews,
 * OBS status and the draft → Publish live flow. Everything stays in this tab.
 */
@Component({
  selector: 'app-overlay-studio-wide-mock',
  imports: [NgTemplateOutlet, RouterLink, LucideAngularModule, OverlayWidgetHostComponent, OverlayClipComponent],
  providers: [OswCopy],
  templateUrl: './overlay-studio-wide.component.html',
  styleUrl: './overlay-studio-wide.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:pointermove)': 'onPointerMove($event)',
    '(window:pointerup)': 'endGesture()',
    '(window:pointercancel)': 'endGesture()',
    '(window:keydown)': 'onKey($event)'
  }
})
export class OverlayStudioWideMockComponent {
  readonly c = inject(OswCopy);
  readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly wsRef = viewChild<ElementRef<HTMLElement>>('ws');
  private readonly stageRef = viewChild<ElementRef<HTMLElement>>('stage');

  readonly i = {
    AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical,
    ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, BringToFront, Check, ChevronDown, CircleHelp, Copy, CopyPlus, Crown, ExternalLink,
    Eye, EyeOff, FlaskConical, Grid3x3, Layers3, Link2, LockKeyhole, LockOpen, Magnet, Monitor, PanelsTopLeft, Play, Plus, Redo2, Scan, SendToBack,
    Settings2, Sparkles, Trash2, Undo2, Volume2, VolumeX, X, Zap, ZoomIn, ZoomOut
  };
  readonly kindIcon: Record<Kind, LucideIconData> = {
    alert: Bell, trigger: Zap, tts: Volume2, clip: Clapperboard, poll: Radio, prediction: Sparkles,
    image: Image, video: Play, shape: Square, text: Type
  };
  readonly palette = PALETTE;
  readonly testKinds = TEST_KINDS;
  readonly queueKinds = TEST_KINDS.filter(k => k !== 'poll' && k !== 'prediction');
  readonly alertEvents = ALERT_EVENTS;
  readonly motions = MOTIONS;
  readonly loops = LOOPS;
  readonly clipLooks = CLIP_LOOKS;
  readonly freeLooks = FREE_CLIP_LOOKS;
  readonly triggers = TRIGGERS;
  readonly sizes = SIZES;
  readonly handles: Handle[] = ['nw', 'ne', 'sw', 'se'];
  readonly steps = [1, 10, 50];
  readonly tokens = ['$(user)', '$(amount)'];

  // ── Document ──────────────────────────────────────────────
  readonly scenes = signal<Scene[]>(startingScenes());
  readonly sceneId = signal('main');
  readonly scene = computed(() => this.scenes().find(s => s.id === this.sceneId()) ?? this.scenes()[0]);
  readonly layers = computed(() => this.scene().layers);
  readonly layersTopFirst = computed(() => [...this.layers()].reverse());
  readonly selectedId = signal<string | null>('trigger-1');
  readonly selected = computed(() => this.layers().find(l => l.id === this.selectedId()) ?? null);
  readonly designs = signal<Design[]>([
    { id: 'pop', name: '', nameKey: 'designs.pop', look: 'pop' },
    { id: 'line', name: '', nameKey: 'designs.line', look: 'line' }
  ]);

  // ── Panels ────────────────────────────────────────────────
  readonly leftTab = signal<'layers' | 'designs'>('layers');
  readonly addOpen = signal(true);
  readonly mobileTab = signal<Pane>('edit');
  readonly panels = signal(true);
  readonly sections = signal<Record<string, boolean>>({ settings: true, position: false, style: false, animation: false, sample: false });
  readonly compact = signal(false);

  // ── Canvas view ───────────────────────────────────────────
  readonly ws = signal({ w: 0, h: 0 });
  readonly zoomMode = signal<'fit' | number>('fit');
  readonly fitScale = computed(() => {
    const { w, h } = this.ws(), sc = this.scene();
    if (!w || !h) return 0.3;
    const pad = this.compact() ? 10 : 36, bottom = this.compact() ? 0 : 70;
    return Math.max(0.05, Math.min((w - pad * 2) / sc.width, (h - pad * 2 - bottom) / sc.height));
  });
  readonly scale = computed(() => { const z = this.zoomMode(); return z === 'fit' ? this.fitScale() : z; });
  readonly percent = computed(() => Math.round(this.scale() * 100));
  readonly grid = signal(false);
  readonly snap = signal(true);
  readonly bg = signal<Background>('checker');
  readonly sound = signal(true);
  readonly guides = signal<{ v: number[]; h: number[] }>({ v: [], h: [] });
  readonly dropping = signal(false);

  // ── Status, popovers, feedback ────────────────────────────
  readonly obsConnected = signal(true);
  readonly unpublished = signal(false);
  readonly saving = signal(false);
  readonly pop = signal<Pop | null>(null);
  readonly toast = signal<Toast | null>(null);
  readonly sendToObs = signal(false);
  readonly sampleUser = signal('Luna');
  readonly sampleAmount = signal('500');
  readonly sampleTier = signal('1000');
  readonly plays = signal<Partial<Record<string, Play>>>({});
  readonly replays = signal<Partial<Record<string, number>>>({});
  readonly confirm = signal('');
  readonly linkId = signal('k7f2m9q4x1');
  readonly overlayUrl = computed(() => `https://domdimabot.com/overlay/${this.linkId()}`);
  readonly lockedLook = signal<ClipDesignVariant | null>(null);
  readonly nudgeStep = signal(10);
  readonly dark = computed(() => this.theme.isDarkMode());

  readonly statusTone = computed(() => !this.obsConnected() ? 'warn' : this.unpublished() ? 'behind' : 'ok');
  readonly statusText = computed(() => this.c.t(!this.obsConnected() ? 'status.off' : this.unpublished() ? 'status.behind' : 'status.live'));
  readonly outsideCount = computed(() => this.layers().filter(l => this.isOutside(l)).length);
  readonly randomBounds = computed(() => {
    const l = this.selected(), sc = this.scene();
    if (!l || l.kind !== 'trigger' || l.placement !== 'random') return null;
    const m = l.margin ?? 0;
    return { x: m, y: m, w: Math.max(0, sc.width - 2 * m), h: Math.max(0, sc.height - 2 * m) };
  });

  // ── History (per overlay) ─────────────────────────────────
  private readonly history = signal<Record<string, { past: Scene[]; future: Scene[] }>>({});
  readonly canUndo = computed(() => (this.history()[this.sceneId()]?.past.length ?? 0) > 0);
  readonly canRedo = computed(() => (this.history()[this.sceneId()]?.future.length ?? 0) > 0);
  private lastGroup = '';
  private lastGroupAt = 0;

  private gesture: Gesture | null = null;
  private dragLayerId: string | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private confirmTimer?: ReturnType<typeof setTimeout>;
  private playKey = 0;
  private nextId = 1;
  private audio?: AudioContext;
  private popTrigger: HTMLElement | null = null;
  private readonly widgetCache = new Map<string, OverlayWidget>();

  constructor() {
    afterNextRender(() => {
      const media = window.matchMedia('(max-width: 959.98px)');
      const onMedia = () => this.compact.set(media.matches);
      onMedia();
      media.addEventListener('change', onMedia);
      if (media.matches) this.mobileTab.set('edit');
      this.destroyRef.onDestroy(() => media.removeEventListener('change', onMedia));
    });
    // Measure the workspace for "Fit" as soon as it exists, and keep measuring as panels/viewport change.
    effect(onCleanup => {
      const ws = this.wsRef()?.nativeElement;
      if (!ws || typeof ResizeObserver === 'undefined') return;
      const measure = () => this.ws.set({ w: ws.clientWidth, h: ws.clientHeight });
      const onWheel = (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        if (event.deltaY < 0) this.zoomIn(); else this.zoomOut();
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(ws);
      ws.addEventListener('wheel', onWheel, { passive: false });
      onCleanup(() => { observer.disconnect(); ws.removeEventListener('wheel', onWheel); });
    });
    this.destroyRef.onDestroy(() => {
      for (const timer of this.timers) clearTimeout(timer);
      clearTimeout(this.saveTimer);
      clearTimeout(this.confirmTimer);
      void this.audio?.close().catch(() => undefined);
    });
  }

  // ── Labels ────────────────────────────────────────────────
  name(l: Layer): string { return l.name || (l.nameKey ? this.c.t(l.nameKey) : this.c.t('kinds.' + l.kind)); }
  sceneName(s: Scene): string { return s.name || this.c.t('scenes.' + s.id); }
  designName(d: Design): string { return d.name || (d.nameKey ? this.c.t(d.nameKey) : ''); }
  designLook(l: Layer): 'pop' | 'line' { return this.designs().find(d => d.id === l.designId)?.look ?? 'pop'; }
  designUsage(id: string): number {
    return this.scenes().reduce((n, s) => n + s.layers.filter(l => l.kind === 'alert' && l.designId === id).length, 0);
  }
  usageText(id: string): string {
    const n = this.designUsage(id);
    return n === 0 ? this.c.t('designs.unused') : this.c.t(n === 1 ? 'designs.usedBy' : 'designs.usedByMany', { count: n });
  }
  textOf(l: Layer): string {
    const raw = l.text || (l.textKey ? this.c.t(l.textKey) : '');
    return raw.replaceAll('$(user)', this.sampleUser() || 'Luna').replaceAll('$(amount)', this.sampleAmount() || '0');
  }
  rawText(l: Layer): string { return l.text || (l.textKey ? this.c.t(l.textKey) : ''); }
  alertText(l: Layer): string {
    const play = this.plays()[l.id];
    const user = play?.user ?? this.sampleUser() ?? 'Luna';
    return play && play.kind !== 'trigger' ? this.c.t('render.' + play.kind, { user, amount: play.amount }) : this.c.t('render.sample', { user: user || 'Luna' });
  }
  layerLabel(l: Layer): string { return this.c.t(l.visible ? 'tools.layer' : 'tools.hiddenLayer', { name: this.name(l) }); }
  isStyled(l: Layer): boolean { return STYLED.includes(l.kind); }
  isOutside(l: Layer): boolean { const sc = this.scene(); return l.x < 0 || l.y < 0 || l.x + l.w > sc.width || l.y + l.h > sc.height; }
  rectOf(l: Layer): Rect { const at = this.plays()[l.id]?.at; return at ? { x: at.x, y: at.y, w: l.w, h: l.h } : { x: l.x, y: l.y, w: l.w, h: l.h }; }
  bgLabel(): string { return this.c.t('tools.bg', { name: this.c.t('tools.' + this.bg()) }); }
  stageFixture(l: Layer): string { return this.plays()[l.id]?.stage ?? l.fixture ?? 'progress'; }
  stagesFor(l: Layer): string[] { return l.kind === 'poll' ? POLL_STAGES : PREDICTION_STAGES; }
  val(event: Event): string { return (event.target as HTMLInputElement).value; }
  checked(event: Event): boolean { return (event.target as HTMLInputElement).checked; }

  /** Stable widget objects for the real poll/prediction renderers, so drags don't rebuild them. */
  interactionWidget(l: Layer): OverlayWidget | null {
    if (l.kind !== 'poll' && l.kind !== 'prediction') return null;
    const key = `${l.id}:${l.kind}:${l.look}`;
    let widget = this.widgetCache.get(key);
    if (!widget) {
      const base = createWidget(l.kind, { id: l.id, placement: 'scene' });
      if (!base) return null;
      widget = { ...base, interactionDesign: l.look ?? 'card' };
      this.widgetCache.set(key, widget);
    }
    return widget;
  }

  // ── Editing core ──────────────────────────────────────────
  private record(group?: string): void {
    const now = Date.now();
    if (group && group === this.lastGroup && now - this.lastGroupAt < 1200) { this.lastGroupAt = now; return; }
    this.lastGroup = group ?? '';
    this.lastGroupAt = now;
    const id = this.sceneId(), snapshot = structuredClone(this.scene());
    this.history.update(all => {
      const h = all[id] ?? { past: [], future: [] };
      return { ...all, [id]: { past: [...h.past.slice(-HISTORY_LIMIT + 1), snapshot], future: [] } };
    });
  }

  private apply(fn: (scene: Scene) => void): void {
    const next = structuredClone(this.scene());
    fn(next);
    this.scenes.update(list => list.map(s => s.id === next.id ? next : s));
    this.touch();
  }

  edit(fn: (scene: Scene) => void, group?: string): void { this.record(group); this.apply(fn); }

  private editLayer(id: string, fn: (layer: Layer) => void, group?: string): void {
    this.edit(s => { const l = s.layers.find(x => x.id === id); if (l) fn(l); }, group ? `${group}:${id}` : undefined);
  }

  patch(patch: Partial<Layer>, group?: string): void {
    const id = this.selectedId();
    if (id) this.editLayer(id, l => Object.assign(l, patch), group);
  }

  private touch(): void {
    this.unpublished.set(true);
    this.saving.set(true);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saving.set(false), 700);
  }

  undo(): void { this.step('past'); }
  redo(): void { this.step('future'); }

  private step(from: 'past' | 'future'): void {
    const id = this.sceneId(), h = this.history()[id];
    const stack = h?.[from];
    if (!h || !stack?.length) return;
    const target = stack[stack.length - 1], current = structuredClone(this.scene());
    const other = from === 'past' ? 'future' : 'past';
    this.history.update(all => ({ ...all, [id]: { ...h, [from]: stack.slice(0, -1), [other]: [...h[other], current] } as { past: Scene[]; future: Scene[] } }));
    this.scenes.update(list => list.map(s => s.id === id ? target : s));
    this.lastGroup = '';
    if (this.selectedId() && !target.layers.some(l => l.id === this.selectedId())) this.selectedId.set(null);
    this.touch();
  }

  // ── Selection & layers ────────────────────────────────────
  select(id: string | null, fromCanvas = false): void {
    if (id !== this.selectedId()) { this.lockedLook.set(null); this.disarm(); }
    this.selectedId.set(id);
    if (id && fromCanvas && this.compact()) this.mobileTab.set('edit');
  }

  add(kind: Kind, at?: { x: number; y: number }): void {
    const sc = this.scene(), id = `${kind}-n${this.nextId++}`;
    const layer = makeLayer(kind, id, at, { w: sc.width, h: sc.height });
    if (!at) {
      const same = sc.layers.filter(l => l.kind === kind).length;
      layer.x += same * 30; layer.y += same * 30;
    }
    this.edit(s => s.layers.push(layer));
    this.select(id);
    if (this.compact()) this.mobileTab.set('edit');
    this.sections.update(v => ({ ...v, settings: true }));
    this.flash(this.c.t('toast.added', { name: this.name(layer) }));
  }

  duplicate(): void {
    const l = this.selected();
    if (!l) return;
    const id = `${l.kind}-n${this.nextId++}`;
    const copy: Layer = { ...structuredClone(l), id, name: `${this.name(l)} 2`, nameKey: undefined, x: l.x + 30, y: l.y + 30, locked: false };
    this.edit(s => { const at = s.layers.findIndex(x => x.id === l.id); s.layers.splice(at + 1, 0, copy); });
    this.select(id);
    this.flash(this.c.t('toast.duplicated', { name: this.name(l) }));
  }

  remove(id: string): void {
    const l = this.layers().find(x => x.id === id);
    if (!l) return;
    this.edit(s => { s.layers = s.layers.filter(x => x.id !== id); });
    if (this.selectedId() === id) this.select(null);
    this.flash(this.c.t('toast.deleted', { name: this.name(l) }), { label: this.c.t('toast.undo'), run: () => { this.undo(); this.select(id); } });
  }

  toggleVisible(id: string): void { this.editLayer(id, l => { l.visible = !l.visible; }); }
  toggleLock(id: string): void { this.editLayer(id, l => { l.locked = !l.locked; }); }

  order(dir: 'front' | 'forward' | 'backward' | 'back'): void {
    const id = this.selectedId();
    if (!id) return;
    this.edit(s => {
      const from = s.layers.findIndex(l => l.id === id);
      if (from < 0) return;
      const to = dir === 'front' ? s.layers.length - 1 : dir === 'back' ? 0 : Math.max(0, Math.min(s.layers.length - 1, from + (dir === 'forward' ? 1 : -1)));
      const [layer] = s.layers.splice(from, 1);
      s.layers.splice(to, 0, layer);
    });
  }

  align(edge: 'left' | 'cx' | 'right' | 'top' | 'cy' | 'bottom'): void {
    const l = this.selected(), sc = this.scene();
    if (!l || l.locked) return;
    const x = edge === 'left' ? 0 : edge === 'cx' ? Math.round((sc.width - l.w) / 2) : edge === 'right' ? sc.width - l.w : l.x;
    const y = edge === 'top' ? 0 : edge === 'cy' ? Math.round((sc.height - l.h) / 2) : edge === 'bottom' ? sc.height - l.h : l.y;
    this.patch({ x, y });
  }

  nudge(dx: number, dy: number): void {
    const l = this.selected();
    if (!l || l.locked) return;
    const step = this.nudgeStep();
    this.patch({ x: l.x + dx * step, y: l.y + dy * step }, 'nudge');
  }

  setDimension(key: 'x' | 'y' | 'w' | 'h', event: Event): void {
    const raw = Number(this.val(event));
    if (!Number.isFinite(raw)) return;
    const value = key === 'w' || key === 'h' ? Math.max(20, Math.round(raw)) : Math.round(raw);
    this.patch({ [key]: value }, 'dim-' + key);
  }

  toggleEvent(event: AlertEvent): void {
    const l = this.selected();
    if (!l) return;
    const events = l.events ?? [];
    this.patch({ events: events.includes(event) ? events.filter(e => e !== event) : ALERT_EVENTS.filter(e => e === event || events.includes(e)) });
  }

  toggleTrigger(id: string): void {
    const l = this.selected();
    if (!l) return;
    const ids = l.triggerIds ?? [];
    this.patch({ triggerIds: ids.includes(id) ? ids.filter(x => x !== id) : TRIGGERS.filter(t => t === id || ids.includes(t)) });
  }

  pickClipLook(look: ClipDesignVariant): void {
    if (!this.freeLooks.includes(look)) { this.lockedLook.set(look); return; }
    this.lockedLook.set(null);
    this.patch({ clipLook: look });
  }

  insertToken(token: string): void {
    const l = this.selected();
    if (!l) return;
    const current = this.rawText(l);
    this.patch({ text: current ? `${current} ${token}` : token, textKey: undefined });
  }

  setSection(key: string, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    if (this.sections()[key] !== open) this.sections.update(v => ({ ...v, [key]: open }));
  }

  replay(l: Layer): void {
    this.replays.update(v => ({ ...v, [l.id]: (v[l.id] ?? 0) + 1 }));
  }

  // ── Layer list drag & drop ────────────────────────────────
  onRowDragStart(event: DragEvent, id: string): void {
    this.dragLayerId = id;
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  onRowDragOver(event: DragEvent): void { if (this.dragLayerId) event.preventDefault(); }

  onRowDrop(event: DragEvent, targetId: string): void {
    const id = this.dragLayerId;
    this.dragLayerId = null;
    if (!id || id === targetId) return;
    event.preventDefault();
    this.edit(s => {
      const from = s.layers.findIndex(l => l.id === id), to = s.layers.findIndex(l => l.id === targetId);
      if (from < 0 || to < 0) return;
      // The dragged layer takes the target row's slot; the rows in between shift by one.
      const [layer] = s.layers.splice(from, 1);
      s.layers.splice(to, 0, layer);
    });
  }

  // ── Palette → canvas drag ─────────────────────────────────
  onPaletteDrag(event: DragEvent, kind: Kind): void {
    event.dataTransfer?.setData('application/x-osw-kind', kind);
    event.dataTransfer?.setData('text/plain', kind);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
  }

  onStageDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('application/x-osw-kind')) return;
    event.preventDefault();
    this.dropping.set(true);
  }

  onStageDrop(event: DragEvent): void {
    this.dropping.set(false);
    const kind = event.dataTransfer?.getData('application/x-osw-kind') as Kind | undefined;
    const stage = this.stageRef()?.nativeElement;
    if (!kind || !stage) return;
    event.preventDefault();
    const box = stage.getBoundingClientRect(), s = this.scale();
    const probe = makeLayer(kind, 'probe');
    this.add(kind, { x: (event.clientX - box.left) / s - probe.w / 2, y: (event.clientY - box.top) / s - probe.h / 2 });
  }

  // ── Canvas pointer gestures ───────────────────────────────
  onLayerDown(event: PointerEvent, layer: Layer): void {
    if (event.button > 0) return;
    event.stopPropagation();
    const wasSelected = this.selectedId() === layer.id;
    this.select(layer.id, true);
    if (layer.locked) {
      if (wasSelected && event.pointerType === 'mouse') this.flash(this.c.t('toast.locked', { name: this.name(layer) }));
      return;
    }
    // Touch: the first tap only selects, so scrolling the page never drags a layer by accident.
    if (event.pointerType !== 'mouse' && !wasSelected) return;
    this.startGesture(event, layer, 'move');
  }

  onHandleDown(event: PointerEvent, handle: Handle): void {
    event.stopPropagation();
    event.preventDefault();
    const l = this.selected();
    if (l && !l.locked) this.startGesture(event, l, 'resize', handle);
  }

  private startGesture(event: PointerEvent, l: Layer, mode: Gesture['mode'], handle?: Handle): void {
    this.gesture = { mode, id: l.id, handle, sx: event.clientX, sy: event.clientY, orig: { x: l.x, y: l.y, w: l.w, h: l.h }, recorded: false, ratio: l.w / l.h };
  }

  onPointerMove(event: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    if (!g.recorded) {
      if (Math.hypot(event.clientX - g.sx, event.clientY - g.sy) < 3) return;
      this.record();
      g.recorded = true;
    }
    event.preventDefault();
    const s = this.scale(), dx = (event.clientX - g.sx) / s, dy = (event.clientY - g.sy) / s;
    const rect = g.mode === 'move' ? this.moveRect(g, dx, dy) : this.resizeRect(g, dx, dy, event.shiftKey);
    this.apply(scene => { const l = scene.layers.find(x => x.id === g.id); if (l) Object.assign(l, rect); });
  }

  endGesture(): void {
    if (!this.gesture) return;
    this.gesture = null;
    this.lastGroup = '';
    this.guides.set({ v: [], h: [] });
  }

  private moveRect(g: Gesture, dx: number, dy: number): Partial<Rect> {
    const { w, h } = g.orig;
    let x = g.orig.x + dx, y = g.orig.y + dy;
    if (!this.snap()) { this.guides.set({ v: [], h: [] }); return { x: Math.round(x), y: Math.round(y) }; }
    const sc = this.scene(), threshold = 8 / this.scale();
    const others = sc.layers.filter(l => l.id !== g.id && l.visible);
    const vx = this.snapAxis(x, w, [0, sc.width / 2, sc.width, ...others.flatMap(l => [l.x, l.x + l.w / 2, l.x + l.w])], threshold);
    const hy = this.snapAxis(y, h, [0, sc.height / 2, sc.height, ...others.flatMap(l => [l.y, l.y + l.h / 2, l.y + l.h])], threshold);
    x = vx.pos ?? Math.round(x / 10) * 10;
    y = hy.pos ?? Math.round(y / 10) * 10;
    this.guides.set({ v: vx.guide === null ? [] : [vx.guide], h: hy.guide === null ? [] : [hy.guide] });
    return { x: Math.round(x), y: Math.round(y) };
  }

  private snapAxis(pos: number, size: number, targets: number[], threshold: number): { pos: number | null; guide: number | null } {
    let best = { d: threshold, pos: null as number | null, guide: null as number | null };
    for (const target of targets) for (const offset of [0, size / 2, size]) {
      const d = Math.abs(pos + offset - target);
      if (d < best.d) best = { d, pos: target - offset, guide: target };
    }
    return best;
  }

  private resizeRect(g: Gesture, dx: number, dy: number, keepRatio: boolean): Rect {
    const { x, y, w, h } = g.orig;
    const east = g.handle === 'ne' || g.handle === 'se', south = g.handle === 'sw' || g.handle === 'se';
    let nw = east ? w + dx : w - dx, nh = south ? h + dy : h - dy;
    if (keepRatio) { if (Math.abs(nw / w) > Math.abs(nh / h)) nh = nw / g.ratio; else nw = nh * g.ratio; }
    else if (this.snap()) { nw = Math.round(nw / 10) * 10; nh = Math.round(nh / 10) * 10; }
    nw = Math.max(20, nw); nh = Math.max(20, nh);
    return { x: Math.round(east ? x : x + w - nw), y: Math.round(south ? y : y + h - nh), w: Math.round(nw), h: Math.round(nh) };
  }

  onWorkspaceClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('.ly, .sel, .toolbar, .pop')) return;
    this.select(null);
  }

  // ── Zoom ──────────────────────────────────────────────────
  zoomIn(): void { const s = this.scale(); this.zoomMode.set(ZOOMS.find(z => z > s + 0.001) ?? ZOOMS[ZOOMS.length - 1]); }
  zoomOut(): void { const s = this.scale(); this.zoomMode.set([...ZOOMS].reverse().find(z => z < s - 0.001) ?? ZOOMS[0]); }
  fit(): void { this.zoomMode.set('fit'); }
  cycleBg(): void { const order: Background[] = ['checker', 'dark', 'game']; this.bg.set(order[(order.indexOf(this.bg()) + 1) % order.length]); }

  // ── Overlays (scenes) ─────────────────────────────────────
  switchScene(id: string): void {
    this.sceneId.set(id);
    this.select(null);
    this.plays.set({});
    this.fit();
    this.closePop();
  }

  newScene(): void {
    const n = this.scenes().length + 1, id = `scene-${this.nextId++}`;
    this.scenes.update(list => [...list, { id, name: this.c.t('top.newName', { n }), width: 1920, height: 1080, layers: [], waitFor: ['tts', 'trigger'] }]);
    this.switchScene(id);
    this.leftTab.set('layers');
    this.addOpen.set(true);
    if (this.compact()) this.mobileTab.set('add');
  }

  renameScene(event: Event): void {
    const value = this.val(event).trim();
    if (value && value !== this.sceneName(this.scene())) this.edit(s => { s.name = value; }, 'rename');
  }

  setSize(w: number, h: number): void {
    const sc = this.scene();
    if (sc.width === w && sc.height === h) return;
    this.edit(s => { s.width = w; s.height = h; });
    this.fit();
  }

  bringIn(): void {
    this.edit(s => {
      for (const l of s.layers) {
        l.w = Math.min(l.w, s.width); l.h = Math.min(l.h, s.height);
        l.x = Math.min(Math.max(0, l.x), s.width - l.w); l.y = Math.min(Math.max(0, l.y), s.height - l.h);
      }
    });
  }

  toggleWait(kind: TestKind): void {
    this.edit(s => { s.waitFor = s.waitFor.includes(kind) ? s.waitFor.filter(k => k !== kind) : [...s.waitFor, kind]; });
  }

  deleteScene(): void {
    if (this.scenes().length < 2) return;
    if (this.confirm() !== 'delete-scene') { this.arm('delete-scene'); return; }
    const gone = this.scene();
    this.disarm();
    this.scenes.update(list => list.filter(s => s.id !== gone.id));
    this.history.update(all => { const next = { ...all }; delete next[gone.id]; return next; });
    this.switchScene(this.scenes()[0].id);
    this.flash(this.c.t('overlay.deleted', { name: this.sceneName(gone) }));
  }

  // ── Alert designs ─────────────────────────────────────────
  newDesign(): void {
    const id = `design-${this.nextId++}`;
    this.designs.update(list => [...list, { id, name: `${this.c.t('designs.new')} ${list.length + 1}`, look: 'pop' }]);
  }

  // ── OBS + publish ─────────────────────────────────────────
  publish(): void {
    if (!this.unpublished()) return;
    this.unpublished.set(false);
    this.flash(this.c.t(this.obsConnected() ? 'top.publishedToast' : 'top.publishedToastOff'));
  }

  copyUrl(): void {
    void navigator.clipboard?.writeText(this.overlayUrl()).catch(() => undefined);
    this.flash(this.c.t('obs.copied'));
  }

  newLink(): void {
    if (this.confirm() !== 'new-link') { this.arm('new-link'); return; }
    this.disarm();
    this.linkId.set(Math.random().toString(36).slice(2, 12).padEnd(10, '0'));
    this.flash(this.c.t('obs.newLinkDone'));
  }

  // ── Test events ───────────────────────────────────────────
  fire(kind: TestKind): void {
    const target = PLAYS[kind];
    const event = this.c.t('test.' + kind), layerName = this.c.t('kinds.' + target);
    const ofKind = this.layers().filter(l => l.kind === target);
    const listening = ofKind.filter(l => target !== 'alert' || l.events?.includes(kind as AlertEvent));
    const visible = listening.filter(l => l.visible);
    if (this.sound()) this.chime(kind);
    if (!listening.length) {
      const off = ofKind[0];
      this.flash(this.c.t('test.nobody', { event }), off
        ? { label: this.c.t('test.turnOn'), run: () => { this.select(off.id, true); this.editLayer(off.id, l => { l.events = ALERT_EVENTS.filter(e => e === kind || l.events?.includes(e)); }); this.fire(kind); } }
        : { label: this.c.t('test.addIt', { layer: layerName }), run: () => { this.add(target); this.fire(kind); } });
      return;
    }
    if (!visible.length) {
      const hidden = listening[0];
      this.flash(this.c.t('test.hidden', { layer: this.name(hidden) }), { label: this.c.t('test.showIt'), run: () => { this.toggleVisible(hidden.id); this.fire(kind); } });
      return;
    }
    const key = ++this.playKey, sc = this.scene();
    const user = this.sampleUser().trim() || 'Luna', amount = this.sampleAmount().trim() || '1', tier = this.sampleTier();
    const duration = kind === 'poll' || kind === 'prediction' || kind === 'clip' ? 6000 : 4200;
    for (const l of visible) {
      const play: Play = { kind, key, user, amount, tier };
      if (kind === 'trigger') {
        const pool = l.triggerMode === 'some' && l.triggerIds?.length ? l.triggerIds : [...TRIGGERS];
        play.trigger = pool[Math.floor(Math.random() * pool.length)];
        if (l.placement === 'random') {
          const m = l.margin ?? 0, spanX = Math.max(0, sc.width - 2 * m - l.w), spanY = Math.max(0, sc.height - 2 * m - l.h);
          play.at = { x: Math.round(m + Math.random() * spanX), y: Math.round(m + Math.random() * spanY) };
        }
      }
      if (kind === 'poll' || kind === 'prediction') {
        play.stage = 'begin';
        this.later(() => this.setStage(l.id, key, 'progress'), 1400);
        this.later(() => this.setStage(l.id, key, 'result'), 3600);
      }
      this.plays.update(p => ({ ...p, [l.id]: play }));
      this.later(() => this.plays.update(p => { if (p[l.id]?.key !== key) return p; const next = { ...p }; delete next[l.id]; return next; }), duration);
    }
    const obs = this.sendToObs() && this.obsConnected() ? ' ' + this.c.t('test.sentObs') : '';
    this.flash(this.c.t('test.played', { event }) + obs);
  }

  private setStage(id: string, key: number, stage: string): void {
    this.plays.update(p => { const cur = p[id]; return cur?.key === key ? { ...p, [id]: { ...cur, stage } } : p; });
  }

  private chime(kind: TestKind): void {
    if (typeof AudioContext === 'undefined') return;
    try {
      const ctx = this.audio ??= new AudioContext();
      const notes: Record<TestKind, number[]> = {
        follow: [660, 880], sub: [523, 659, 784], bits: [880, 1175], raid: [392, 523, 659, 784],
        trigger: [233, 233], tts: [440], clip: [587, 740], poll: [494, 587], prediction: [494, 659]
      };
      notes[kind].forEach((frequency, index) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain(), t0 = ctx.currentTime + index * 0.11;
        osc.type = kind === 'trigger' ? 'square' : 'sine';
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(0.06, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.36);
      });
    } catch { /* audio is optional */ }
  }

  // ── Popovers, toasts, two-tap confirms ────────────────────
  togglePop(pop: Pop, event?: Event): void {
    if (this.pop() === pop) { this.closePop(); return; }
    this.popTrigger = (event?.currentTarget as HTMLElement | null) ?? null;
    this.pop.set(pop);
    this.disarm();
    setTimeout(() => (document.querySelector('.pop [data-autofocus]') as HTMLElement | null)?.focus(), 0);
  }

  closePop(): void {
    if (!this.pop()) return;
    this.pop.set(null);
    this.popTrigger?.focus();
    this.popTrigger = null;
  }

  flash(text: string, action?: Toast['action']): void {
    const key = ++this.playKey;
    this.toast.set({ text, key, action });
    this.later(() => { if (this.toast()?.key === key) this.toast.set(null); }, action ? 6500 : 3800);
  }

  runToast(): void {
    const action = this.toast()?.action;
    this.toast.set(null);
    action?.run();
  }

  private arm(key: string): void {
    this.confirm.set(key);
    clearTimeout(this.confirmTimer);
    this.confirmTimer = setTimeout(() => this.confirm.set(''), 4000);
  }

  private disarm(): void { clearTimeout(this.confirmTimer); this.confirm.set(''); }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer);
  }

  setTheme(dark: boolean): void { this.theme.setTheme(dark ? 'dark' : 'light'); }

  // ── Keyboard ──────────────────────────────────────────────
  onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing = !!target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
    const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (event.key === 'Escape') {
      if (this.pop()) { event.preventDefault(); this.closePop(); }
      else if (!typing && this.selectedId()) this.select(null);
      return;
    }
    if (typing) return;
    if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && key === 'y') { event.preventDefault(); this.redo(); return; }
    if (mod && key === 'd') { event.preventDefault(); this.duplicate(); return; }
    if (mod || event.altKey) return;
    if (event.key === '+' || event.key === '=') { this.zoomIn(); return; }
    if (event.key === '-') { this.zoomOut(); return; }
    if (event.key === '0') { this.fit(); return; }
    const l = this.selected();
    if (!l) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.remove(l.id); return; }
    const arrows: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const dir = arrows[event.key];
    if (dir && !l.locked) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      this.patch({ x: l.x + dir[0] * step, y: l.y + dir[1] * step }, 'nudge');
    }
  }
}
