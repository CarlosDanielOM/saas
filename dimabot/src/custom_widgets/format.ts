/**
 * Portable custom widget package format, compatible with StreamElements widget exports
 * (widget.ini + html/css/js/fields/data). Keep this file free of server and framework imports:
 * `scripts/sync-overlay-widget-contract.mjs` copies it to dimasite so the API and Studio
 * parse fields and check values the same way.
 */
export const PACKAGE_FILES = ['html', 'css', 'js', 'fields', 'data'] as const;
export type PackageFile = typeof PACKAGE_FILES[number];
export type PackageSource = Record<PackageFile, string>;
/** A package as uploaded: the five StreamElements parts plus our optional `widget.json` manifest. */
export type PackageInput = PackageSource & { manifest?: string };
export const MANIFEST_FILE = 'widget.json';
export const MANIFEST_BYTES = 16_000;

export const CUSTOM_WIDGET_LIMITS = {
  fileBytes: { html: 512_000, css: 512_000, js: 1_000_000, fields: 256_000, data: 128_000 } as Readonly<Record<PackageFile, number>>,
  totalBytes: 2_000_000,
  fields: 500,
  options: 200,
  text: 20_000,
  url: 2048,
  mediaItems: 50,
  valuesBytes: 64_000,
  name: 80,
  label: 200,
  group: 80,
  depth: 6,
  externalMedia: 200
} as const;
/** Custom widgets each channel can keep, by plan. */
export const CUSTOM_WIDGET_PLAN_LIMITS = { free: 1, premium: 5, pro: 25 } as const;
export type CustomWidgetPlan = keyof typeof CUSTOM_WIDGET_PLAN_LIMITS;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type FieldType = 'text' | 'textarea' | 'number' | 'slider' | 'checkbox' | 'colorpicker' | 'dropdown'
  | 'googleFont' | 'image-input' | 'video-input' | 'sound-input' | 'button' | 'hidden';
export const MEDIA_FIELD_TYPES: readonly FieldType[] = ['image-input', 'video-input', 'sound-input'];
export interface FieldOption { value: string; label: string }
export interface WidgetField {
  key: string;
  type: FieldType;
  /** The type written in the fields file when we map it (HTML5 input types, unknown types that StreamElements shows as text). */
  sourceType?: string;
  /** Text-like HTML5 input to render (email, url, date, time...). */
  inputType?: string;
  label: string;
  group?: string;
  /** Default value; for buttons, the value sent with the button event. */
  value?: JsonValue;
  options?: FieldOption[];
  min?: number; max?: number; step?: number;
  multiple?: boolean;
}
export interface FieldIssue { key?: string; code: 'invalid-key' | 'invalid-field' | 'too-many-fields' | 'no-options' | 'invalid-value' | 'invalid-data-key' | 'data-value-dropped' | 'unknown-use'; detail?: string }

/** Which runtime API the widget's code was written for. `streamelements` adds the StreamElements translation layer. */
export type WidgetEngine = 'dima' | 'streamelements';
/** Data a widget can ask for (Dima SDK v1). Studio shows these in plain words; the server streams only these. */
export const WIDGET_USES = ['chat', 'alerts', 'store', 'counters', 'session'] as const;
export type WidgetUse = typeof WIDGET_USES[number];
export interface WidgetManifest {
  engine: WidgetEngine; api: 1; uses: WidgetUse[];
  name?: string; author?: string; version?: string; description?: string;
  /** True when Studio worked it out from StreamElements code instead of reading a widget.json. */
  inferred?: boolean;
}
export class PackageFormatError extends Error { constructor(readonly code: string, message: string) { super(message); } }

/** StreamElements reserves field names starting with `widget`; these three are documented. */
export const RESERVED_FIELDS = { name: 'widgetName', author: 'widgetAuthor', duration: 'widgetDuration' } as const;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
export const validKey = (key: string) => KEY.test(key) && !FORBIDDEN_KEYS.has(key);
const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?)\([-0-9a-z.,%\s/]*\)|[a-z]{3,30})$/i;
const FONT = /^[A-Za-z0-9 _'-]{1,80}$/;
const TEXT_INPUTS = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'email', 'url', 'tel', 'search', 'password']);
const byteLength = (text: string) => new TextEncoder().encode(text).length;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** JSON-safe copy with valid keys and bounded depth/size, or undefined. */
export function jsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.length <= CUSTOM_WIDGET_LIMITS.text ? value : undefined;
  if (depth >= CUSTOM_WIDGET_LIMITS.depth) return undefined;
  if (Array.isArray(value)) {
    if (value.length > 1000) return undefined;
    const items = value.map(item => jsonValue(item, depth + 1));
    return items.every(item => item !== undefined) ? items as JsonValue[] : undefined;
  }
  if (!isObject(value)) return undefined;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const copy = validKey(key) ? jsonValue(item, depth + 1) : undefined;
    if (copy === undefined) return undefined;
    result[key] = copy;
  }
  return result;
}
function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > CUSTOM_WIDGET_LIMITS.url || !/^https:\/\/[^\s"'<>\\`]+$/i.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
function finite(value: unknown, coerce: boolean): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (coerce && typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function typeDefault(field: WidgetField): JsonValue | undefined {
  switch (field.type) {
    case 'button': return undefined;
    case 'checkbox': return false;
    case 'number': return field.min ?? 0;
    case 'slider': return field.min ?? 0;
    case 'dropdown': return field.options?.[0]?.value ?? '';
    case 'image-input': case 'video-input': case 'sound-input': return field.multiple ? [] : '';
    default: return '';
  }
}

export type ValueMode = 'import' | 'strict';
/**
 * Checks one setting value against its field. `import` repairs what StreamElements exports tolerate
 * (numbers as strings, out-of-range sliders); `strict` is for values edited in Studio.
 */
export function fieldValue(field: WidgetField, raw: unknown, mode: ValueMode): { ok: true; value: JsonValue } | { ok: false } {
  const fix = mode === 'import';
  const ok = (value: JsonValue) => ({ ok: true as const, value }), bad = { ok: false as const };
  switch (field.type) {
    case 'button': return bad;
    case 'hidden': { const value = jsonValue(raw); return value === undefined ? bad : ok(value); }
    case 'text': case 'textarea': {
      if (typeof raw === 'string') return raw.length <= CUSTOM_WIDGET_LIMITS.text ? ok(raw) : bad;
      if (fix && (typeof raw === 'number' && Number.isFinite(raw) || typeof raw === 'boolean')) return ok(String(raw));
      if (fix && raw === null) return ok('');
      return bad;
    }
    case 'number': { const value = finite(raw, fix); return value === undefined ? bad : ok(value); }
    case 'slider': {
      const value = finite(raw, fix); if (value === undefined) return bad;
      const min = field.min ?? -Infinity, max = field.max ?? Infinity;
      if (value >= min && value <= max) return ok(value);
      return fix ? ok(Math.min(max, Math.max(min, value))) : bad;
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return ok(raw);
      if (fix && (raw === 'true' || raw === 1 || raw === '1')) return ok(true);
      if (fix && (raw === 'false' || raw === 0 || raw === '0' || raw === '' || raw === null)) return ok(false);
      return bad;
    }
    case 'colorpicker': return typeof raw === 'string' && raw.length <= 64 && (raw === '' || COLOR.test(raw.trim())) ? ok(raw) : bad;
    case 'googleFont': return typeof raw === 'string' && (raw === '' || FONT.test(raw)) ? ok(raw) : bad;
    case 'dropdown': {
      const value = typeof raw === 'string' ? raw : fix && (typeof raw === 'number' || typeof raw === 'boolean') ? String(raw) : undefined;
      return value !== undefined && field.options?.some(option => option.value === value) ? ok(value) : bad;
    }
    case 'image-input': case 'video-input': case 'sound-input': {
      if (field.multiple) {
        const list = Array.isArray(raw) ? raw : fix && (raw === null || raw === '') ? [] : fix && typeof raw === 'string' ? [raw] : undefined;
        return list && list.length <= CUSTOM_WIDGET_LIMITS.mediaItems && list.every(httpsUrl) ? ok(list as string[]) : bad;
      }
      if (raw === '' || raw === null) return ok(raw);
      if (fix && Array.isArray(raw) && raw.length === 1) return httpsUrl(raw[0]) ? ok(raw[0]) : bad;
      return httpsUrl(raw) ? ok(raw) : bad;
    }
  }
}

function fieldType(raw: unknown): { type: FieldType; sourceType?: string; inputType?: string } {
  const type = typeof raw === 'string' ? raw.trim() : '';
  const known: FieldType[] = ['text', 'textarea', 'number', 'slider', 'checkbox', 'colorpicker', 'dropdown', 'googleFont', 'image-input', 'video-input', 'sound-input', 'button', 'hidden'];
  if ((known as string[]).includes(type)) return { type: type as FieldType };
  if (type === 'range') return { type: 'slider', sourceType: type };
  if (type === 'color') return { type: 'colorpicker', sourceType: type };
  if (TEXT_INPUTS.has(type)) return { type: 'text', sourceType: type, inputType: type };
  // StreamElements shows any other type as a text input.
  return { type: 'text', ...(type ? { sourceType: type.slice(0, 40) } : {}) };
}

/** Parses a fields file (a JSON object of field definitions) in file order. */
export function parseFields(text: string): { fields: WidgetField[]; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  const raw = parseJsonObject(text, 'fields');
  const fields: WidgetField[] = [];
  for (const [key, definition] of Object.entries(raw)) {
    if (!validKey(key)) { issues.push({ key: key.slice(0, 64), code: 'invalid-key' }); continue; }
    if (!isObject(definition)) { issues.push({ key, code: 'invalid-field' }); continue; }
    if (fields.length >= CUSTOM_WIDGET_LIMITS.fields) { issues.push({ code: 'too-many-fields', detail: String(CUSTOM_WIDGET_LIMITS.fields) }); break; }
    const field: WidgetField = { key, ...fieldType(definition['type']), label: key };
    if (typeof definition['label'] === 'string') field.label = definition['label'].slice(0, CUSTOM_WIDGET_LIMITS.label);
    if (typeof definition['group'] === 'string' && definition['group'].trim()) field.group = definition['group'].trim().slice(0, CUSTOM_WIDGET_LIMITS.group);
    for (const bound of ['min', 'max', 'step'] as const) { const value = finite(definition[bound], true); if (value !== undefined) field[bound] = value; }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) { delete field.min; delete field.max; }
    if (field.step !== undefined && field.step <= 0) delete field.step;
    if (MEDIA_FIELD_TYPES.includes(field.type) && definition['multiple'] === true) field.multiple = true;
    if (field.type === 'dropdown') {
      const options = isObject(definition['options']) ? Object.entries(definition['options']).slice(0, CUSTOM_WIDGET_LIMITS.options)
        .filter(([value]) => value.length <= 200).map(([value, label]) => ({ value, label: typeof label === 'string' || typeof label === 'number' ? String(label).slice(0, CUSTOM_WIDGET_LIMITS.label) : value })) : [];
      if (options.length) field.options = options;
      else { issues.push({ key, code: 'no-options' }); field.type = 'text'; field.sourceType = 'dropdown'; }
    }
    if (field.type === 'button') {
      const value = jsonValue(definition['value']); if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') field.value = value;
    } else if (definition['value'] !== undefined) {
      const checked = fieldValue(field, definition['value'], 'import');
      if (checked.ok) field.value = checked.value; else issues.push({ key, code: 'invalid-value' });
    }
    fields.push(field);
  }
  return { fields, issues };
}

function parseJsonObject(text: string, file: 'fields' | 'data'): Record<string, unknown> {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch (error) { throw new PackageFormatError(`invalid-${file}`, `The ${file} file isn't valid JSON: ${(error as Error).message}`); }
  if (!isObject(parsed)) throw new PackageFormatError(`invalid-${file}`, `The ${file} file must be a JSON object ({ ... })`);
  return parsed;
}

/**
 * Parses a data file (saved setting values). Values for known fields are checked against their field
 * and repaired or dropped; other keys are kept when JSON-safe, because widget code can still read them.
 */
export function parseData(text: string, fields: readonly WidgetField[]): { data: JsonObject; issues: FieldIssue[] } {
  const raw = parseJsonObject(text, 'data'), issues: FieldIssue[] = [], data: JsonObject = {};
  const byKey = new Map(fields.map(field => [field.key, field]));
  for (const [key, value] of Object.entries(raw)) {
    if (!validKey(key)) { issues.push({ key: key.slice(0, 64), code: 'invalid-data-key' }); continue; }
    const field = byKey.get(key);
    if (field?.type === 'button') continue;
    const checked = field ? fieldValue(field, value, 'import') : (() => { const copy = jsonValue(value); return copy === undefined ? { ok: false as const } : { ok: true as const, value: copy }; })();
    if (checked.ok) data[key] = checked.value; else issues.push({ key, code: 'data-value-dropped' });
  }
  if (byteLength(JSON.stringify(data)) > CUSTOM_WIDGET_LIMITS.fileBytes.data) throw new PackageFormatError('data-too-large', 'The saved settings are too large');
  return { data, issues };
}

/** Every value the widget sees: field defaults, then the package's saved data, then the layer's own changes. */
export function resolveFieldData(fields: readonly WidgetField[], data: Readonly<JsonObject>, overrides: Readonly<JsonObject> = {}): JsonObject {
  const result: JsonObject = {};
  for (const field of fields) {
    if (field.type === 'button') continue;
    const value = field.value !== undefined ? field.value : typeDefault(field);
    if (value !== undefined) result[field.key] = structuredClone(value);
  }
  for (const [key, value] of Object.entries(data)) result[key] = structuredClone(value);
  for (const [key, value] of Object.entries(overrides)) result[key] = structuredClone(value);
  return result;
}

/**
 * Checks a layer's changed settings. Keys that no longer exist (the widget files were replaced) are
 * dropped; a wrong value for an existing setting is an error. Returns the cleaned overrides.
 */
export function checkOverrides(fields: readonly WidgetField[], raw: unknown): { values: JsonObject } | { error: string; key?: string } {
  if (raw === undefined) return { values: {} };
  if (!isObject(raw)) return { error: 'Widget settings must be an object' };
  const byKey = new Map(fields.map(field => [field.key, field])), values: JsonObject = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = validKey(key) ? byKey.get(key) : undefined;
    if (!field || field.type === 'button') continue;
    const checked = fieldValue(field, value, 'strict');
    if (!checked.ok) return { error: `Invalid value for "${field.label}"`, key };
    values[key] = checked.value;
  }
  if (byteLength(JSON.stringify(values)) > CUSTOM_WIDGET_LIMITS.valuesBytes) return { error: 'Widget settings are too large' };
  return { values };
}

export interface FieldGroup { name: string | null; fields: WidgetField[] }
/** Fields shown in the editor, grouped in file order; hidden fields stay out (as in StreamElements). */
export function groupFields(fields: readonly WidgetField[]): FieldGroup[] {
  const groups = new Map<string | null, WidgetField[]>();
  for (const field of fields) {
    if (field.type === 'hidden') continue;
    const name = field.group ?? null;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(field);
  }
  return [...groups].map(([name, items]) => ({ name, fields: items }));
}

/** Setting names referenced as `{name}` or `{{name}}` in widget code. */
export function placeholderKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(/\{\{?\s*([A-Za-z0-9_-]{1,64})\s*\}?\}/g)) keys.add(match[1]);
  return [...keys];
}

export type ExternalMediaKind = 'image' | 'video' | 'audio' | 'font' | 'script' | 'style' | 'other';
export interface ExternalMedia { url: string; host: string; kind: ExternalMediaKind; in: (PackageFile)[] }
const EXTENSIONS: [RegExp, ExternalMediaKind][] = [
  [/\.(png|jpe?g|gif|webp|avif|svg|apng|bmp|ico)$/i, 'image'], [/\.(webm|mp4|mov|m4v|ogv)$/i, 'video'],
  [/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i, 'audio'], [/\.(woff2?|ttf|otf|eot)$/i, 'font'], [/\.m?js$/i, 'script'], [/\.css$/i, 'style']
];
/** Remote files the widget loads (for example StreamElements uploads), found in its code and saved values. */
export function externalMedia(source: PackageSource, data: Readonly<JsonObject> = {}): ExternalMedia[] {
  const found = new Map<string, ExternalMedia>();
  const scan = (text: string, file: PackageFile) => {
    for (const [raw] of text.matchAll(/https?:\/\/[^\s"'`()<>\\{}]+/gi)) {
      const url = raw.replace(/[.,;:!?]+$/, '');
      // Longer "URLs" aren't media links; skipping them also bounds what each revision stores.
      if (url.length > CUSTOM_WIDGET_LIMITS.url) continue;
      let parsed: URL; try { parsed = new URL(url); } catch { continue; }
      const entry = found.get(url) ?? { url, host: parsed.hostname.toLowerCase(), kind: mediaKind(parsed), in: [] };
      if (!entry.in.includes(file)) entry.in.push(file);
      if (found.size < CUSTOM_WIDGET_LIMITS.externalMedia || found.has(url)) found.set(url, entry);
    }
  };
  for (const file of ['html', 'css', 'js'] as const) scan(source[file], file);
  const strings = (value: JsonValue): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  for (const value of Object.values(data)) for (const text of strings(value)) scan(text, 'data');
  return [...found.values()];
}
function mediaKind(url: URL): ExternalMediaKind {
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return 'font';
  return EXTENSIONS.find(([pattern]) => pattern.test(url.pathname))?.[1] ?? 'other';
}
export const isStreamElementsHost = (host: string) => host === 'streamelements.com' || host.endsWith('.streamelements.com');

/** Reads widget.ini (`[HTML]` / `path = "html.txt"`), mapping each part to its file name. */
export function parseWidgetIni(text: string): Partial<Record<PackageFile, string>> {
  const result: Partial<Record<PackageFile, string>> = {};
  let section: PackageFile | null = null;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const header = /^\s*\[([A-Za-z]+)\]\s*$/.exec(line);
    if (header) { const name = header[1].toLowerCase(); section = (PACKAGE_FILES as readonly string[]).includes(name) ? name as PackageFile : null; continue; }
    const path = /^\s*path\s*=\s*"?([^"\r\n]+?)"?\s*$/i.exec(line);
    if (section && path) result[section] = path[1].trim();
  }
  return result;
}
export const EXPORT_FILE_NAMES: Readonly<Record<PackageFile, string>> = { html: 'html.txt', css: 'css.txt', js: 'js.txt', fields: 'fields.txt', data: 'data.txt' };
export function buildWidgetIni(): string {
  return PACKAGE_FILES.map(file => `[${file.toUpperCase()}]\npath = "${EXPORT_FILE_NAMES[file]}"\n`).join('\n');
}
/** Matches dropped or zipped file names to package parts; widget.ini wins when present. */
export function matchPackageFiles(names: readonly string[], ini?: Partial<Record<PackageFile, string>>): Partial<Record<PackageFile, string>> {
  const result: Partial<Record<PackageFile, string>> = {};
  const base = (name: string) => name.split('/').pop()!.toLowerCase();
  for (const file of PACKAGE_FILES) {
    const wanted = ini?.[file]?.toLowerCase();
    const byIni = wanted ? names.find(name => base(name) === base(wanted)) : undefined;
    const exact = names.find(name => base(name) === EXPORT_FILE_NAMES[file]);
    const loose = names.filter(name => {
      const n = base(name);
      switch (file) {
        case 'html': return /\.html?$/.test(n) || n === 'html.txt';
        case 'css': return /\.css$/.test(n);
        case 'js': return /\.js$/.test(n) && !/\.min\.js$/.test(n);
        case 'fields': return n === 'fields.json';
        case 'data': return n === 'data.json';
      }
    });
    const pick = byIni ?? exact ?? (loose.length === 1 ? loose[0] : undefined);
    if (pick) result[file] = pick;
  }
  return result;
}

/** Reads widget.json. Unknown `uses` entries become issues; an unknown engine or API version is refused. */
export function parseManifest(text: string): { manifest: WidgetManifest; issues: FieldIssue[] } {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  let raw: unknown;
  try { raw = JSON.parse(trimmed); } catch (error) { throw new PackageFormatError('invalid-manifest', `widget.json isn't valid JSON: ${(error as Error).message}`); }
  if (!isObject(raw)) throw new PackageFormatError('invalid-manifest', 'widget.json must be a JSON object ({ ... })');
  const engine = raw['engine'] === undefined ? 'dima' : raw['engine'];
  if (engine !== 'dima' && engine !== 'streamelements') throw new PackageFormatError('invalid-manifest', 'widget.json: "engine" must be "dima" or "streamelements"');
  if ((raw['api'] ?? 1) !== 1) throw new PackageFormatError('unsupported-api', 'widget.json: this widget needs a newer widget engine ("api" must be 1)');
  const issues: FieldIssue[] = [], uses: WidgetUse[] = [];
  for (const use of Array.isArray(raw['uses']) ? raw['uses'] : []) {
    if ((WIDGET_USES as readonly unknown[]).includes(use)) { if (!uses.includes(use as WidgetUse)) uses.push(use as WidgetUse); }
    else issues.push({ code: 'unknown-use', detail: String(use).slice(0, 40) });
  }
  const manifest: WidgetManifest = { engine, api: 1, uses };
  for (const [key, max] of [['name', CUSTOM_WIDGET_LIMITS.name], ['author', 80], ['version', 40], ['description', 300]] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) manifest[key] = value.trim().slice(0, max);
  }
  return { manifest, issues };
}
/** What a StreamElements widget reads, worked out from the listeners and APIs its code mentions. */
export function inferManifest(source: Pick<PackageSource, 'html' | 'js'>): WidgetManifest {
  const code = source.js + '\n' + source.html, uses: WidgetUse[] = [];
  // Listener names are often built indirectly, so any onEventReceived handler gets chat and alerts.
  const events = /onEventReceived/.test(code);
  if (events || /["'`](?:message|delete-message|delete-messages)["'`]/.test(code)) uses.push('chat');
  if (events || /-latest["'`]|["'`]event:test["'`]/.test(code)) uses.push('alerts');
  if (/SE_API\s*\.\s*store|kvstore:update/.test(code)) uses.push('store');
  if (/SE_API\s*\.\s*counters|bot:counter/.test(code)) uses.push('counters');
  if (/onSessionUpdate|\.session\b|-recent["'`]|-goal["'`]|-session["'`]|-total["'`]/.test(code)) uses.push('session');
  return { engine: 'streamelements', api: 1, uses, inferred: true };
}

/** Size check for a whole package before it is stored. */
export function checkPackageSize(source: PackageInput): string | null {
  if (source.manifest !== undefined && (typeof source.manifest !== 'string' || byteLength(source.manifest) > MANIFEST_BYTES)) return 'widget.json is too large (max 16 KB)';
  let total = 0;
  for (const file of PACKAGE_FILES) {
    if (typeof source[file] !== 'string') return `The ${file} file is missing`;
    const bytes = byteLength(source[file]); total += bytes;
    if (bytes > CUSTOM_WIDGET_LIMITS.fileBytes[file]) return `The ${file} file is too large (max ${Math.round(CUSTOM_WIDGET_LIMITS.fileBytes[file] / 1000)} KB)`;
  }
  return total > CUSTOM_WIDGET_LIMITS.totalBytes ? 'The widget files are too large together (max 2 MB)' : null;
}

export interface PackageSummary { fields: WidgetField[]; data: JsonObject; issues: FieldIssue[]; externalMedia: ExternalMedia[]; manifest: WidgetManifest; name?: string; author?: string }
/** Everything the API stores about a package besides its files. Throws PackageFormatError. */
export function readPackage(source: PackageInput): PackageSummary {
  const size = checkPackageSize(source); if (size) throw new PackageFormatError('too-large', size);
  const parsedManifest = source.manifest !== undefined && source.manifest.trim() ? parseManifest(source.manifest) : { manifest: inferManifest(source), issues: [] };
  const parsedFields = parseFields(source.fields);
  const parsedData = parseData(source.data, parsedFields.fields);
  const values = resolveFieldData(parsedFields.fields, parsedData.data);
  const text = (key: string) => typeof values[key] === 'string' && (values[key] as string).trim() ? (values[key] as string).trim().slice(0, CUSTOM_WIDGET_LIMITS.name) : undefined;
  const manifest = parsedManifest.manifest;
  return { fields: parsedFields.fields, data: parsedData.data, issues: [...parsedManifest.issues, ...parsedFields.issues, ...parsedData.issues],
    externalMedia: externalMedia(source, parsedData.data), manifest,
    name: manifest.name ?? text(RESERVED_FIELDS.name), author: manifest.author ?? text(RESERVED_FIELDS.author) };
}
