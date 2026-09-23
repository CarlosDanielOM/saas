import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, PLATFORM_ID, afterNextRender, computed, inject, signal
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ArrowLeft, Clapperboard, Copy, Eye, EyeOff, Grip, Layers3, LockKeyhole,
  Moon, Play, Plus, RotateCcw, Save, Sun, Trash2, Volume2, Zap,
  LucideAngularModule
} from 'lucide-angular';

import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';

type WidgetKind = 'tts' | 'trigger' | 'clip';
type Panel = 'library' | 'canvas' | 'properties';
type Dimension = 'x' | 'y' | 'width' | 'height';

interface OverlayWidget {
  id: string;
  kind: WidgetKind;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  locked: boolean;
}

interface PointerSession {
  id: string;
  action: 'move' | 'resize';
  startX: number;
  startY: number;
  original: OverlayWidget;
  canvas: DOMRect;
}

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const STORAGE_KEY = 'domdimabot-overlay-editor-mock-v1';
const STARTER: OverlayWidget[] = [
  { id: 'tts-1', kind: 'tts', x: 670, y: 62, width: 580, height: 160, visible: true, locked: false },
  { id: 'trigger-1', kind: 'trigger', x: 75, y: 755, width: 510, height: 230, visible: true, locked: false },
  { id: 'clip-1', kind: 'clip', x: 1410, y: 775, width: 430, height: 250, visible: true, locked: false }
];

@Component({
  selector: 'app-overlay-editor-mock',
  imports: [RouterLink, LucideAngularModule],
  templateUrl: './overlay-editor-mock.component.html',
  styleUrl: './overlay-editor-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:pointermove)': 'onPointerMove($event)',
    '(window:pointerup)': 'stopPointer()',
    '(window:pointercancel)': 'stopPointer()'
  }
})
export class OverlayEditorMockComponent {
  readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private pointer: PointerSession | null = null;
  private nextId = 2;

  readonly icons = { ArrowLeft, Clapperboard, Copy, Eye, EyeOff, Grip, Layers3, LockKeyhole, Moon, Play, Plus, RotateCcw, Save, Sun, Trash2, Volume2, Zap };
  readonly palette: WidgetKind[] = ['tts', 'trigger', 'clip'];
  readonly widgets = signal<OverlayWidget[]>(STARTER.map((widget) => ({ ...widget })));
  readonly selectedId = signal<string | null>('tts-1');
  readonly panel = signal<Panel>('canvas');
  readonly snap = signal(true);
  readonly preview = signal<WidgetKind | null>(null);
  readonly saved = signal(false);
  readonly selected = computed(() => this.widgets().find((widget) => widget.id === this.selectedId()) ?? null);

  constructor() {
    afterNextRender(() => this.restoreDraft());
  }

  t(key: string, params?: Record<string, string | number>): string {
    this.language.currentLanguage();
    return this.language.translate(`overlayMock.${key}`, params);
  }

  isDark(): boolean { return this.theme.isDarkMode(); }
  toggleTheme(): void { this.theme.toggleTheme(); }
  toggleLanguage(): void { this.language.toggleLanguage(); }
  setPanel(panel: Panel): void { this.panel.set(panel); }
  toggleSnap(): void { this.snap.update((value) => !value); }
  select(id: string): void { this.selectedId.set(id); }

  onWidgetKeydown(event: KeyboardEvent, widget: OverlayWidget): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.select(widget.id);
      return;
    }
    if (widget.locked) return;
    const step = this.snap() ? 10 : 1;
    const moves: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step }
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    this.select(widget.id);
    this.patch(widget.id, {
      x: this.clamp(widget.x + move.x, 0, CANVAS_WIDTH - widget.width),
      y: this.clamp(widget.y + move.y, 0, CANVAS_HEIGHT - widget.height)
    });
  }

  widgetIcon(kind: WidgetKind) {
    return kind === 'tts' ? Volume2 : kind === 'trigger' ? Zap : Clapperboard;
  }

  addWidget(kind: WidgetKind, position?: { x: number; y: number }): void {
    const size = kind === 'tts' ? { width: 580, height: 160 } : kind === 'trigger'
      ? { width: 510, height: 230 } : { width: 430, height: 250 };
    const count = this.widgets().length;
    const widget: OverlayWidget = {
      id: `${kind}-${this.nextId++}`, kind,
      x: this.clamp(position?.x ?? 160 + count * 70, 0, CANVAS_WIDTH - size.width),
      y: this.clamp(position?.y ?? 150 + count * 55, 0, CANVAS_HEIGHT - size.height),
      ...size, visible: true, locked: false
    };
    this.widgets.update((widgets) => [...widgets, widget]);
    this.selectedId.set(widget.id);
    this.panel.set('canvas');
    this.markDirty();
  }

  onPaletteDrag(event: DragEvent, kind: WidgetKind): void {
    event.dataTransfer?.setData('application/x-overlay-widget', kind);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
  }

  onCanvasDragOver(event: DragEvent): void { event.preventDefault(); }

  onCanvasDrop(event: DragEvent): void {
    event.preventDefault();
    const kind = event.dataTransfer?.getData('application/x-overlay-widget');
    if (kind !== 'tts' && kind !== 'trigger' && kind !== 'clip') return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT;
    this.addWidget(kind, { x: this.round(x), y: this.round(y) });
  }

  startPointer(event: PointerEvent, widget: OverlayWidget, action: 'move' | 'resize'): void {
    if (widget.locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = (event.currentTarget as HTMLElement).closest('.stage')?.getBoundingClientRect();
    if (!canvas) return;
    this.selectedId.set(widget.id);
    this.pointer = { id: widget.id, action, startX: event.clientX, startY: event.clientY, original: { ...widget }, canvas };
  }

  onPointerMove(event: PointerEvent): void {
    const session = this.pointer;
    if (!session) return;
    const dx = ((event.clientX - session.startX) / session.canvas.width) * CANVAS_WIDTH;
    const dy = ((event.clientY - session.startY) / session.canvas.height) * CANVAS_HEIGHT;
    const original = session.original;
    this.widgets.update((widgets) => widgets.map((widget) => {
      if (widget.id !== session.id) return widget;
      if (session.action === 'move') {
        return { ...widget,
          x: this.clamp(this.round(original.x + dx), 0, CANVAS_WIDTH - original.width),
          y: this.clamp(this.round(original.y + dy), 0, CANVAS_HEIGHT - original.height)
        };
      }
      return { ...widget,
        width: this.clamp(this.round(original.width + dx), 160, CANVAS_WIDTH - original.x),
        height: this.clamp(this.round(original.height + dy), 90, CANVAS_HEIGHT - original.y)
      };
    }));
    this.markDirty();
  }

  stopPointer(): void { this.pointer = null; }

  updateDimension(field: Dimension, event: Event): void {
    const widget = this.selected();
    const raw = Number((event.target as HTMLInputElement).value);
    if (!widget || !Number.isFinite(raw)) return;
    const min = field === 'width' ? 160 : field === 'height' ? 90 : 0;
    const max = field === 'x' ? CANVAS_WIDTH - widget.width : field === 'y'
      ? CANVAS_HEIGHT - widget.height : field === 'width' ? CANVAS_WIDTH - widget.x : CANVAS_HEIGHT - widget.y;
    this.patch(widget.id, { [field]: this.clamp(Math.round(raw), min, max) });
  }

  toggleVisibility(id: string): void {
    const widget = this.widgets().find((item) => item.id === id);
    if (widget) this.patch(id, { visible: !widget.visible });
  }

  toggleLock(id: string): void {
    const widget = this.widgets().find((item) => item.id === id);
    if (widget) this.patch(id, { locked: !widget.locked });
  }

  duplicateSelected(): void {
    const widget = this.selected();
    if (!widget) return;
    const copy: OverlayWidget = { ...widget, id: `${widget.kind}-${this.nextId++}`,
      x: Math.min(widget.x + 50, CANVAS_WIDTH - widget.width),
      y: Math.min(widget.y + 50, CANVAS_HEIGHT - widget.height), locked: false };
    this.widgets.update((widgets) => [...widgets, copy]);
    this.selectedId.set(copy.id);
    this.markDirty();
  }

  deleteSelected(): void {
    const id = this.selectedId();
    if (!id) return;
    this.widgets.update((widgets) => widgets.filter((widget) => widget.id !== id));
    this.selectedId.set(this.widgets().at(-1)?.id ?? null);
    this.markDirty();
  }

  moveLayer(direction: -1 | 1): void {
    const id = this.selectedId();
    const widgets = [...this.widgets()];
    const index = widgets.findIndex((widget) => widget.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= widgets.length) return;
    [widgets[index], widgets[next]] = [widgets[next], widgets[index]];
    this.widgets.set(widgets);
    this.markDirty();
  }

  previewWidget(kind: WidgetKind): void {
    this.preview.set(kind);
    if (this.isBrowser) window.setTimeout(() => this.preview.update((current) => current === kind ? null : current), 3500);
  }

  saveDraft(): void {
    if (!this.isBrowser) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.widgets()));
    this.saved.set(true);
  }

  resetDraft(): void {
    this.widgets.set(STARTER.map((widget) => ({ ...widget })));
    this.selectedId.set('tts-1');
    this.nextId = 2;
    if (this.isBrowser) localStorage.removeItem(STORAGE_KEY);
    this.saved.set(false);
  }

  private restoreDraft(): void {
    if (!this.isBrowser) return;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return;
      const value: unknown = JSON.parse(stored);
      if (!Array.isArray(value) || !value.every((item) => this.isWidget(item))) return;
      this.widgets.set(value);
      this.selectedId.set(value[0]?.id ?? null);
      this.nextId = Math.max(2, ...value.map((item) => Number(item.id.split('-').at(-1)) || 0)) + 1;
      this.saved.set(true);
    } catch { /* An invalid browser draft should never block the mock. */ }
  }

  private isWidget(value: unknown): value is OverlayWidget {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    return typeof item['id'] === 'string' && ['tts', 'trigger', 'clip'].includes(String(item['kind'])) &&
      ['x', 'y', 'width', 'height'].every((key) => typeof item[key] === 'number' && Number.isFinite(item[key])) &&
      typeof item['visible'] === 'boolean' && typeof item['locked'] === 'boolean';
  }

  private patch(id: string, changes: Partial<OverlayWidget>): void {
    this.widgets.update((widgets) => widgets.map((widget) => widget.id === id ? { ...widget, ...changes } : widget));
    this.markDirty();
  }

  private markDirty(): void { this.saved.set(false); }
  private clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(value, max)); }
  private round(value: number): number { return this.snap() ? Math.round(value / 10) * 10 : Math.round(value); }
}
