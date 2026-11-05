import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { LucideAngularModule, RotateCcw, Search, SlidersHorizontal } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { fieldValue, groupFields, resolveFieldData, type JsonObject, type JsonValue, type WidgetField } from './custom-widget-format.generated';
import { CustomWidgetsService } from './custom-widgets.service';
import { EditorWidgetEnv } from './widget-runtime/editor-env';
import type { OverlayWidget } from './overlay.model';
import type { WidgetSettingsContext } from './overlay-widget-module';

/** Popular Google Fonts offered as suggestions; any Google Font name can be typed. */
const FONT_SUGGESTIONS = ['Plus Jakarta Sans', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito', 'Quicksand', 'Comfortaa', 'Raleway',
  'Rubik', 'Work Sans', 'Fredoka', 'Baloo 2', 'Bangers', 'Press Start 2P', 'Silkscreen', 'VT323', 'Pixelify Sans', 'Bebas Neue', 'Oswald', 'Anton',
  'Permanent Marker', 'Caveat', 'Pacifico', 'Dancing Script', 'Lobster', 'Playfair Display', 'Merriweather', 'Source Code Pro', 'JetBrains Mono', 'Space Grotesk', 'M PLUS Rounded 1c', 'Kosugi Maru', 'Noto Sans JP'];
const SEARCH_FROM = 10;
const same = (a: JsonValue | undefined, b: JsonValue | undefined) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Right-panel groups for a custom widget, built from its fields file the way StreamElements does:
 * one collapsible group per `group` name (collapsed by default), hidden fields left out.
 * Changes are stored on the layer as overrides of the widget's starting values.
 */
@Component({
  selector: 'app-overlay-custom-widget-fields',
  imports: [LucideAngularModule, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overlay-custom-widget-fields.component.html',
  styleUrl: './overlay-custom-widget-fields.component.css'
})
export class OverlayCustomWidgetFieldsComponent {
  readonly context = input.required<WidgetSettingsContext>();
  readonly configChange = output<Partial<OverlayWidget>>();
  readonly previewChange = output<string>();
  private readonly widgets = inject(CustomWidgetsService);
  private readonly language = inject(LanguageService);
  private readonly env = inject(EditorWidgetEnv, { optional: true });
  readonly icons = { RotateCcw, Search, SlidersHorizontal };
  readonly fonts = FONT_SUGGESTIONS;

  readonly layer = computed(() => this.context().widget);
  readonly source = computed(() => this.widgets.widget(this.layer().config?.['widgetId']));
  readonly listLoaded = computed(() => this.widgets.list() !== null);
  /** The layer's changed settings. Updated locally right away so quick edits made before Studio re-renders build on each other. */
  readonly overrides = linkedSignal<JsonObject>(() => {
    const values = this.layer().config?.['values'];
    return values && typeof values === 'object' && !Array.isArray(values) ? values as JsonObject : {};
  });
  /** What each setting is before this layer changes it: field defaults plus the widget's saved data. */
  readonly base = computed<JsonObject>(() => { const source = this.source(); return source ? resolveFieldData(source.fields, source.data) : {}; });
  readonly groups = computed(() => {
    const source = this.source(); if (!source) return [];
    return groupFields(source.fields).map((group, index) => ({ ...group, id: group.name ?? `general-${index}` }));
  });
  readonly fieldCount = computed(() => this.groups().reduce((sum, group) => sum + group.fields.length, 0));
  readonly showSearch = computed(() => this.fieldCount() >= SEARCH_FROM);
  /** Search text and inline errors belong to one layer; switching layers clears them. */
  readonly query = linkedSignal<string, string>({ source: () => this.layer().id, computation: () => '' });
  readonly visibleGroups = computed(() => {
    const query = this.query().trim().toLowerCase();
    if (!query) return this.groups();
    return this.groups().map(group => ({ ...group, fields: group.fields.filter(field => field.label.toLowerCase().includes(query) || field.key.toLowerCase().includes(query)) }))
      .filter(group => group.fields.length);
  });
  /** Only settings the widget still has (new files can remove some; the next save drops those). */
  readonly changedCount = computed(() => { const keys = new Set(this.source()?.fields.map(field => field.key)); return Object.keys(this.overrides()).filter(key => keys.has(key)).length; });
  private readonly open = signal<Record<string, boolean>>({});
  readonly errors = linkedSignal<string, Record<string, string>>({ source: () => this.layer().id, computation: () => ({}) });

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('overlayStudio.' + key, params); }
  /** Counted strings have a `…One` variant for 1. */
  n(key: string, count: number, params: Record<string, string | number> = {}): string { return this.t(count === 1 ? key + 'One' : key, { count, ...params }); }

  groupName(group: { name: string | null }): string { return group.name ?? this.t('customGroupGeneral'); }
  isOpen(id: string): boolean { return this.query().trim() ? true : this.open()[id] === true; }
  toggle(id: string, event: Event): void {
    if (this.query().trim()) return;
    const open = (event.target as HTMLDetailsElement).open;
    if (this.open()[id] !== open) this.open.update(state => ({ ...state, [id]: open }));
  }
  inputId(field: WidgetField): string { return `cw-${this.layer().id}-${field.key}`; }
  changedIn(fields: WidgetField[]): number { return fields.filter(field => this.isChanged(field)).length; }
  hasButtons(fields: WidgetField[]): boolean { return fields.some(field => field.type === 'button'); }

  value(field: WidgetField): JsonValue | undefined { const overrides = this.overrides(); return Object.hasOwn(overrides, field.key) ? overrides[field.key] : this.base()[field.key]; }
  text(field: WidgetField): string { const value = this.value(field); return value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value); }
  number(field: WidgetField): number { const value = this.value(field); return typeof value === 'number' ? value : Number(value) || 0; }
  checked(field: WidgetField): boolean { return this.value(field) === true; }
  lines(field: WidgetField): string { const value = this.value(field); return Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : ''; }
  sliderMin(field: WidgetField): number { return field.min ?? 0; }
  sliderMax(field: WidgetField): number { return field.max ?? Math.max(100, this.number(field)); }
  sliderPct(field: WidgetField): number { const min = this.sliderMin(field), max = this.sliderMax(field); return max > min ? (this.number(field) - min) / (max - min) : 0; }
  /** The colour input only understands #rrggbb; other CSS colours stay editable as text. */
  hex(field: WidgetField): string {
    const value = this.text(field).trim();
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return value.slice(0, 7).toLowerCase();
    if (/^#[0-9a-f]{3,4}$/i.test(value)) return '#' + [...value.slice(1, 4)].map(c => c + c).join('').toLowerCase();
    return '#000000';
  }
  imagePreview(field: WidgetField): string { const value = this.value(field); return field.type === 'image-input' && typeof value === 'string' && /^https:\/\//.test(value) ? value : ''; }
  isChanged(field: WidgetField): boolean { return Object.hasOwn(this.overrides(), field.key); }

  setText(field: WidgetField, event: Event): void { this.set(field, (event.target as HTMLInputElement).value); }
  setNumber(field: WidgetField, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    if (raw.trim() === '') { this.fail(field, 'customErrorNumber'); return; }
    this.set(field, Number(raw));
  }
  setChecked(field: WidgetField, event: Event): void { this.set(field, (event.target as HTMLInputElement).checked); }
  setMedia(field: WidgetField, event: Event): void {
    const raw = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.set(field, field.multiple ? raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : raw.trim());
  }
  /** Setting buttons send a `widget-button` event to this layer's preview (StreamElements behaviour). */
  press(field: WidgetField): void { this.env?.pressButton(this.layer().id, field.key, field.value ?? field.key); }
  readonly canPress = !!this.env;
  reset(field: WidgetField): void { this.write(field.key, undefined); this.clearError(field.key); }
  resetAll(): void { this.errors.set({}); this.emit({}); }

  private set(field: WidgetField, raw: unknown): void {
    const checked = fieldValue(field, raw, 'strict');
    if (!checked.ok) { this.fail(field, this.errorKey(field)); return; }
    this.clearError(field.key);
    this.write(field.key, same(checked.value, this.base()[field.key]) ? undefined : checked.value);
  }
  private write(key: string, value: JsonValue | undefined): void {
    const next = { ...this.overrides() };
    if (value === undefined) delete next[key]; else next[key] = value;
    this.emit(next);
  }
  private emit(values: JsonObject): void {
    this.overrides.set(values);
    const { values: _old, ...rest } = this.layer().config ?? {};
    this.configChange.emit({ config: { ...rest, ...(Object.keys(values).length ? { values } : {}) } });
  }
  private errorKey(field: WidgetField): string {
    switch (field.type) {
      case 'colorpicker': return 'customErrorColor';
      case 'googleFont': return 'customErrorFont';
      case 'number': case 'slider': return 'customErrorNumber';
      case 'image-input': case 'video-input': case 'sound-input': return 'customErrorUrl';
      default: return 'customErrorValue';
    }
  }
  private fail(field: WidgetField, key: string): void { this.errors.update(errors => ({ ...errors, [field.key]: this.t(key) })); }
  private clearError(key: string): void { if (this.errors()[key]) this.errors.update(({ [key]: _gone, ...rest }) => rest); }
}
