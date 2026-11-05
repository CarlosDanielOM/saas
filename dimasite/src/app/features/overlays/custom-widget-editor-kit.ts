/**
 * "Download for your code editor": the widget's files with real names (so VS Code and others treat them as HTML,
 * CSS, JavaScript and JSON), typings for the Dima SDK / StreamElements layer and this widget's settings, and JSON
 * schemas for fields.json and widget.json. widget.ini maps the names, so the folder or zip imports straight back.
 */
import { SIGNAL_DECLARATION_LIMITS, WIDGET_USES, type WidgetEngine, type WidgetField } from './custom-widget-format.generated';
import type { CodeFiles } from './custom-widget-code-drafts';
import { ALIASES, DIMA_EVENTS, FIELD_PROPS, FIELD_TYPES, MANIFEST_KEYS, TYPES, USES_DOCS, fieldValueType, isIdentifier } from './widget-runtime/sdk-reference';

export const KIT_NAMES = { html: 'widget.html', css: 'widget.css', js: 'widget.js', fields: 'fields.json', data: 'data.json' } as const;
export interface KitFile { name: string; text: string }

/** Text that can't end a JSDoc comment or break the line. */
const docText = (text: string) => text.replace(/\*\//g, '*\\/').replace(/\s+/g, ' ').trim();
const key = (name: string) => isIdentifier(name) ? name : JSON.stringify(name);
const SE_TYPES = new Set(['SEApi', 'SEStore', 'SECounters', 'SEWidgetLoad', 'SEChannel', 'SEEventReceived', 'SEEvent', 'SEMessageData', 'SESessionUpdate']);

/** Global typings for widget.js: the Dima SDK, this widget's settings and (StreamElements widgets) SE_API, jQuery and events. */
export function widgetTypings(fields: readonly WidgetField[], dataKeys: readonly string[], engine: WidgetEngine): string {
  const out: string[] = [
    '// Types for widget.js, made by DomDimaBot Overlay Studio for this widget. Keep it next to widget.js; jsconfig.json',
    '// includes it, so editors like VS Code suggest Dima SDK calls, event fields and your settings. Not needed in Studio.',
    ''
  ];
  const settings = fields.filter(field => field.type !== 'button');
  out.push('/** This widget\'s settings (fields.json; data.json values without a field too). */', 'interface WidgetFields {');
  for (const field of settings) out.push(`  /** ${docText(`${field.label || field.key} (${field.type})`)} */`, `  ${key(field.key)}: ${fieldValueType(field)};`);
  for (const name of dataKeys.filter(name => !settings.some(field => field.key === name))) out.push(`  /** data.json value */`, `  ${key(name)}: any;`);
  out.push('}', '');
  out.push('/** Events for Dima.on(type, handler) and the data each handler gets. */', 'interface DimaEvents {');
  for (const event of DIMA_EVENTS) out.push(`  /** ${docText(event.doc + (event.uses ? ` Needs "${event.uses}" in widget.json uses.` : ''))} */`, `  ${key(event.name)}: ${event.type};`);
  out.push('  /** One signal by name, e.g. Dima.on(\'signal:feed\', …). Needs "signals" in widget.json uses. */', '  [name: `signal:${string}`]: DimaSignal;');
  out.push('}', '');
  for (const [name, type] of Object.entries(ALIASES)) if (engine === 'streamelements' || !name.startsWith('SE')) out.push(`type ${name} = ${type};`);
  out.push('');
  for (const [name, ref] of Object.entries(TYPES)) {
    if (SE_TYPES.has(name) && engine !== 'streamelements') continue;
    // StreamElements event fields depend on the listener, so all are optional.
    const optional = name === 'SEEvent' ? '?' : '';
    out.push(`/** ${docText(ref.doc)} */`, `interface ${name} {`);
    for (const [prop, info] of Object.entries(ref.props)) out.push(`  /** ${docText(info.doc)} */`, `  ${key(prop)}${optional}: ${info.type};`);
    out.push('}', '');
  }
  out.push('/** The Dima SDK. */', 'declare const Dima: DimaSDK;', 'interface Window { Dima: DimaSDK; }');
  if (engine === 'streamelements') {
    out.push('', '/** StreamElements API (StreamElements layer). */', 'declare const SE_API: SEApi;', 'interface Window { SE_API: SEApi; }',
      '/** jQuery 3.7 is loaded for StreamElements widgets. */', 'declare const $: any;', 'declare const jQuery: any;',
      'interface WindowEventMap {', '  onWidgetLoad: CustomEvent<SEWidgetLoad>;', '  onEventReceived: CustomEvent<SEEventReceived>;', '  onSessionUpdate: CustomEvent<SESessionUpdate>;', '}');
  }
  return out.join('\n') + '\n';
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
/** JSON schema for fields.json (StreamElements fields format). */
export function fieldsSchema(): string {
  return json({
    $schema: 'http://json-schema.org/draft-07/schema#', title: 'Widget settings (fields.json)', type: 'object',
    additionalProperties: { type: 'object', required: ['type'], properties: {
      ...Object.fromEntries(FIELD_PROPS.map(prop => [prop.name, { description: prop.doc }])),
      // Suggest the standard types; other names the importer accepts (color, range, email…) stay valid.
      type: { description: 'Field type.', anyOf: [{ enum: FIELD_TYPES.map(type => type.name), markdownEnumDescriptions: FIELD_TYPES.map(type => type.doc) }, { type: 'string' }] },
      label: { type: 'string', description: 'Label in the settings panel.' }, group: { type: 'string', description: 'Settings group.' },
      options: { type: 'object', additionalProperties: { type: ['string', 'number'] }, description: 'dropdown: { "value": "Label" }.' },
      min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' }, multiple: { type: 'boolean' }
    } }
  });
}
/** JSON schema for widget.json. */
export function manifestSchema(): string {
  const doc = (name: string) => MANIFEST_KEYS.find(k => k.name === name)?.doc;
  return json({
    $schema: 'http://json-schema.org/draft-07/schema#', title: 'Widget manifest (widget.json)', type: 'object', additionalProperties: false,
    properties: {
      engine: { enum: ['dima', 'streamelements'], description: doc('engine') }, api: { const: 1, description: doc('api') },
      name: { type: 'string', maxLength: 80, description: doc('name') }, author: { type: 'string', description: doc('author') },
      version: { type: 'string', description: doc('version') }, description: { type: 'string', description: doc('description') },
      uses: { type: 'array', uniqueItems: true, description: doc('uses'), items: { enum: [...WIDGET_USES], markdownEnumDescriptions: WIDGET_USES.map(use => USES_DOCS[use]) } },
      signals: { type: 'array', maxItems: SIGNAL_DECLARATION_LIMITS.count, description: doc('signals'), items: { type: 'object', required: ['name'], additionalProperties: false, properties: {
        name: { type: 'string', pattern: '^[a-z0-9_]{1,40}$', description: 'Signal name: lowercase letters, digits and _.' },
        description: { type: 'string', maxLength: SIGNAL_DECLARATION_LIMITS.description, description: 'What it does, shown in Studio.' },
        values: { type: 'array', maxItems: SIGNAL_DECLARATION_LIMITS.values, items: { type: 'string', maxLength: SIGNAL_DECLARATION_LIMITS.value }, description: 'Example values, shown in Studio.' }
      } } }
    }
  });
}
export const KIT_INI = (['html', 'css', 'js', 'fields', 'data'] as const).map(file => `[${file.toUpperCase()}]\npath = "${KIT_NAMES[file]}"\n`).join('\n');

/** Every file of the kit (inside a folder named after the widget when zipped). */
export function editorKit(files: CodeFiles, fields: readonly WidgetField[], dataKeys: readonly string[], engine: WidgetEngine, readme: string): KitFile[] {
  return [
    { name: 'widget.ini', text: KIT_INI },
    ...(['html', 'css', 'js', 'fields', 'data'] as const).map(file => ({ name: KIT_NAMES[file], text: files[file] })),
    ...(files.manifest.trim() ? [{ name: 'widget.json', text: files.manifest }] : []),
    { name: 'dima.d.ts', text: widgetTypings(fields, dataKeys, engine) },
    { name: 'jsconfig.json', text: json({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [], moduleDetection: 'force', allowJs: true, checkJs: true, strict: false, noEmit: true }, include: ['widget.js', 'dima.d.ts'] }) },
    { name: '.vscode/settings.json', text: json({ 'json.schemas': [{ fileMatch: ['fields.json'], url: './.vscode/fields.schema.json' }, { fileMatch: ['widget.json'], url: './.vscode/widget.schema.json' }] }) },
    { name: '.vscode/fields.schema.json', text: fieldsSchema() },
    { name: '.vscode/widget.schema.json', text: manifestSchema() },
    { name: 'README.md', text: readme }
  ];
}
