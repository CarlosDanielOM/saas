/**
 * Suggestions and hover docs for the custom widget code editor (loaded with CodeMirror only).
 * Level 1: Dima / SE_API members, event and listener names, settings (`Dima.fields.`, `fieldData.`, `{key}`),
 * widget.json and fields.txt keys/values. Level 2: the first parameter of a handler passed to `Dima.on('event', …)`,
 * `Dima.ready().then(…)` or `addEventListener('onEventReceived', …)` gets that event's type, so `message.user.` works.
 * Everything comes from widget-runtime/sdk-reference.ts.
 */
import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { cssLanguage } from '@codemirror/lang-css';
import { htmlLanguage } from '@codemirror/lang-html';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { jsonLanguage } from '@codemirror/lang-json';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { hoverTooltip, type EditorView, type Tooltip } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { WidgetEngine, WidgetField } from './custom-widget-format.generated';
import type { CodeFile } from './custom-widget-code-drafts';
import { DIMA_EVENTS, FIELD_PROPS, FIELD_TYPES, MANIFEST_KEYS, SE_EVENTS, SE_LISTENERS, SIGNAL_EVENT, STATE_REFS, TYPES, USES_DOCS, fieldValueType, isIdentifier, typeName, type RefProp } from './widget-runtime/sdk-reference';

/** What the suggestions know about the widget being edited (from its last parsed files). */
export interface HintContext { engine: WidgetEngine; uses: readonly string[]; fields: readonly WidgetField[]; dataKeys: readonly string[]; signals?: readonly string[] }
export type Hints = () => HintContext;

const FIELDS = 'WidgetFields';
const EVENT = /^CustomEvent<(\w+)>$/;
const word = /^[\w$]*$/, eventWord = /^[\w.:-]*$/;

// ---- Types of expressions ------------------------------------------------------------------------------------------
const nodeText = (state: EditorState, node: SyntaxNode | null) => node ? state.sliceDoc(node.from, node.to) : '';
const unquote = (text: string) => /^(['"`])(.*)\1$/s.exec(text)?.[2] ?? null;
/** The name of a function's first parameter (`m => …`, `(m, i) => …`, `function (m) {…}`). */
function firstParam(state: EditorState, fn: SyntaxNode): string | null {
  for (let child = fn.firstChild; child; child = child.nextSibling) {
    if (child.name === 'VariableDefinition') return nodeText(state, child);
    if (child.name === 'ParamList') {
      const first = child.getChild('VariableDefinition');
      // Only a plain first parameter (not destructured).
      return first && state.sliceDoc(child.from, first.from).replace(/[\s(]/g, '') === '' ? nodeText(state, first) : null;
    }
  }
  return null;
}
/** The type of `name` when it is the first parameter of a handler we know, looking outward from `pos`. */
function paramType(state: EditorState, pos: number, name: string, engine: WidgetEngine): string | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name !== 'ArrowFunction' && node.name !== 'FunctionExpression') continue;
    if (firstParam(state, node) !== name) continue;
    const call = node.parent?.name === 'ArgList' ? node.parent.parent : null;
    if (!call || call.name !== 'CallExpression') return null; // the name is this function's own parameter: nothing known
    const callee = nodeText(state, call.firstChild).replace(/\s+/g, '');
    const args = call.getChild('ArgList'), first = args?.firstChild?.nextSibling ?? null; // skip "("
    const event = first ? unquote(nodeText(state, first)) : null;
    if (callee === 'Dima.on' || callee === 'Dima.off') return DIMA_EVENTS.find(e => e.name === event)?.type ?? (event && SIGNAL_EVENT.test(event) ? 'DimaSignal' : null);
    if (callee === 'Dima.ready().then') return 'DimaContext';
    if (callee === 'Dima.state') return typeName(STATE_REFS.find(ref => ref.name === event)?.type ?? '');
    if (engine === 'streamelements' && /(^|\.)addEventListener$/.test(callee)) { const known = SE_EVENTS.find(e => e.name === event); return known ? `CustomEvent<${known.type}>` : null; }
    return null;
  }
  return null;
}
/** The members a type offers: documented props, settings for WidgetFields, `detail` for CustomEvent<T>. */
function propsOf(type: string, hints: HintContext): Record<string, RefProp> {
  const event = EVENT.exec(type);
  if (event) return { detail: { type: event[1], doc: 'The event\'s data.' } };
  if (type === FIELDS) return Object.fromEntries(settings(hints).map(f => [f.key, { type: f.valueType, doc: f.label }]));
  return Object.hasOwn(TYPES, type) ? TYPES[type].props : {};
}
/** A member by its own name only (`toString`, `constructor`… are not members). */
const member = (props: Record<string, RefProp>, name: string) => Object.hasOwn(props, name) ? props[name] : undefined;
/** Resolves `Dima.storage`, `message.user`, `obj.detail.event`… to a type name. */
function resolvePath(path: string[], state: EditorState, pos: number, hints: HintContext): string | null {
  const [root, ...rest] = path;
  let type = root === 'Dima' ? 'DimaSDK' : root === 'SE_API' && hints.engine === 'streamelements' ? 'SEApi' : paramType(state, pos, root, hints.engine);
  for (const raw of rest) {
    if (!type) return null;
    const call = raw.endsWith('()'), name = call ? raw.slice(0, -2) : raw;
    const prop = member(propsOf(type, hints), name);
    if (!prop) return null;
    // Calls aren't followed (`Dima.ready()` is a Promise; its handler parameter is typed instead).
    type = call ? null : EVENT.test(prop.type) ? prop.type : prop.type === FIELDS ? FIELDS : typeName(prop.type);
  }
  return type;
}
const CHAIN = /[A-Za-z_$][\w$]*(?:\(\))?(?:\s*\.\s*[A-Za-z_$][\w$]*(?:\(\))?)*\s*\.\s*[\w$]*$/;
const splitChain = (text: string) => text.replace(/\s+/g, '').split('.');

// ---- Suggestions ---------------------------------------------------------------------------------------------------
interface Setting { key: string; label: string; valueType: string; from: 'field' | 'data' }
function settings(hints: HintContext): Setting[] {
  const fields = hints.fields.filter(f => f.type !== 'button').map(f => ({ key: f.key, label: `${f.label || f.key} (${f.type})`, valueType: fieldValueType(f), from: 'field' as const }));
  const known = new Set(fields.map(f => f.key));
  return [...fields, ...hints.dataKeys.filter(key => !known.has(key)).map(key => ({ key, label: 'data.txt value', valueType: 'any', from: 'data' as const }))];
}
const DIMA_ON_SNIPPET = snippetCompletion("on('${chat}', ${message} => {\n\t${}\n})", { label: 'on', type: 'method', detail: "on('event', handler)", info: TYPES['DimaSDK'].props['on'].doc, boost: 1 });
/** `.accent-color` isn't valid JavaScript: such setting names become `["accent-color"]` (replacing the dot). */
const bracketAccess = (name: string) => (view: EditorView, _completion: Completion, from: number, to: number) => {
  const dot = view.state.sliceDoc(0, from).search(/\s*\.\s*$/), insert = `[${JSON.stringify(name)}]`;
  view.dispatch({ changes: { from: dot, to, insert }, selection: { anchor: dot + insert.length } });
};
function members(type: string, hints: HintContext, callFollows = false): Completion[] {
  const props = propsOf(type, hints);
  const options: Completion[] = Object.entries(props).filter(([name]) => isIdentifier(name) || type === FIELDS).map(([name, prop]) => ({
    label: name, type: prop.call ? 'method' : 'property', detail: prop.call ?? prop.type, info: prop.doc, ...(isIdentifier(name) ? {} : { apply: bracketAccess(name) })
  }));
  // `Dima.on` fills in a ready-to-edit handler, unless the call is already written.
  return type === 'DimaSDK' && !callFollows ? options.map(option => option.label === 'on' ? DIMA_ON_SNIPPET : option) : options;
}
const eventOptions = (hints: HintContext): Completion[] => {
  const options: Completion[] = DIMA_EVENTS.map(event => {
    const missing = event.uses !== null && !hints.uses.includes(event.uses);
    return { label: event.name, type: 'enum', detail: missing ? `needs "${event.uses}" in widget.json uses` : event.type, info: event.doc, boost: missing ? -1 : 0 };
  });
  // Signals declared in widget.json: `signal:feed` for one name.
  const missing = !hints.uses.includes('signals');
  for (const name of hints.signals ?? []) options.push({ label: `signal:${name}`, type: 'enum', detail: missing ? 'needs "signals" in widget.json uses' : 'DimaSignal',
    info: `The "${name}" signal declared in widget.json.`, boost: missing ? -1 : 0 });
  return options;
};
/** `{key}` / `{{key}}` placeholders (HTML, CSS, and JS of StreamElements widgets). */
function placeholderResult(context: CompletionContext, hints: HintContext, css: boolean): CompletionResult | null {
  // In CSS, `.row {` opens a rule: placeholders are only offered right after the brace ({key}, no space).
  const match = context.matchBefore(css ? /\{\{?[\w-]*$/ : /\{\{?\s*[\w-]*$/);
  if (!match) return null;
  const typed = /[\w-]*$/.exec(match.text)![0];
  if (css && !typed && !context.explicit) return null;
  return { from: context.pos - typed.length, options: settings(hints).map(s => ({ label: s.key, type: 'variable', detail: s.valueType, info: s.label })), validFor: /^[\w-]*$/ };
}

export function jsCompletions(hints: Hints): CompletionSource {
  return context => {
    const h = hints();
    // Inside a string: event names, StreamElements events and listener names.
    const str = context.matchBefore(/(['"`])[\w.:-]*$/);
    if (str) {
      const before = context.state.sliceDoc(Math.max(0, str.from - 120), str.from), from = str.from + 1;
      if (/\bDima\s*\.\s*(?:on|off)\s*\(\s*$/.test(before)) return { from, options: eventOptions(h), validFor: eventWord };
      if (/\bDima\s*\.\s*state\s*\(\s*$/.test(before)) return { from, options: STATE_REFS.map(ref => ({ label: ref.name, type: 'enum', detail: h.uses.includes(ref.name) ? ref.type : `needs "${ref.name}" in widget.json uses`, info: ref.doc, boost: h.uses.includes(ref.name) ? 0 : -1 })), validFor: eventWord };
      if (h.engine === 'streamelements' && /addEventListener\s*\(\s*$/.test(before)) return { from, options: SE_EVENTS.map(e => ({ label: e.name, type: 'enum', detail: e.type, info: e.doc })), validFor: eventWord };
      if (h.engine === 'streamelements' && /(?:listener\s*[!=]==?\s*|case\s+)$/.test(before)) return { from, options: SE_LISTENERS.map(l => ({ label: l.name, type: 'enum', info: l.doc })), validFor: eventWord };
      return null;
    }
    if (h.engine === 'streamelements') { const placeholder = placeholderResult(context, h, false); if (placeholder) return placeholder; }
    const chain = context.matchBefore(CHAIN);
    if (!chain) return null;
    const path = splitChain(chain.text), typed = path.pop()!;
    const type = resolvePath(path, context.state, context.pos, h);
    if (!type) return null;
    // Accepting in the middle of a name replaces the whole name.
    const rest = /^[\w$]*/.exec(context.state.sliceDoc(context.pos, context.state.doc.lineAt(context.pos).to))![0];
    const callFollows = /^\s*\(/.test(context.state.sliceDoc(context.pos + rest.length, context.pos + rest.length + 20));
    return { from: context.pos - typed.length, to: context.pos + rest.length, options: members(type, h, callFollows), validFor: word };
  };
}
export function placeholderCompletions(hints: Hints, css: boolean): CompletionSource {
  return context => placeholderResult(context, hints(), css);
}

/** Depth of `{` nesting at the end of `text`, ignoring strings. */
function jsonDepth(text: string): number {
  let depth = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; }
    else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return depth;
}
export function jsonCompletions(file: CodeFile, hints: Hints): CompletionSource {
  return context => {
    const str = context.matchBefore(/"[^"\\\n]*$/);
    if (!str) return null;
    const h = hints(), from = str.from + 1, upTo = context.state.sliceDoc(0, str.from);
    const value = /"([^"\\]+)"\s*:\s*$/.exec(upTo.slice(-200))?.[1] ?? null, depth = jsonDepth(upTo);
    const result = (options: Completion[]): CompletionResult => ({ from, options, validFor: /^[^"\\\n]*$/ });
    if (file === 'manifest') {
      if (value === 'engine') return result(['dima', 'streamelements'].map(engine => ({ label: engine, type: 'enum', info: MANIFEST_KEYS[0].doc })));
      if (/"uses"\s*:\s*\[[^\]]*$/.test(upTo)) return result(Object.entries(USES_DOCS).map(([use, doc]) => ({ label: use, type: 'enum', info: doc })));
      if (value === null && depth === 1 && !/:\s*$/.test(upTo)) {
        const present = new Set([...upTo.matchAll(/"(\w+)"\s*:/g)].map(match => match[1]));
        return result(MANIFEST_KEYS.filter(key => !present.has(key.name)).map(key => ({ label: key.name, type: 'property', info: key.doc })));
      }
    }
    if (file === 'fields' && depth === 2) {
      if (value === 'type') return result(FIELD_TYPES.map(type => ({ label: type.name, type: 'enum', info: type.doc })));
      if (value === 'group') return result([...new Set(h.fields.map(f => f.group).filter((g): g is string => !!g))].map(group => ({ label: group, type: 'text', apply: JSON.stringify(group).slice(1, -1) })));
      if (value === null && !/:\s*$/.test(upTo)) return result(FIELD_PROPS.map(prop => ({ label: prop.name, type: 'property', info: prop.doc })));
    }
    if (file === 'data' && depth === 1 && value === null && !/:\s*$/.test(upTo)) {
      return result(h.fields.filter(f => f.type !== 'button').map(f => ({ label: f.key, type: 'property', detail: fieldValueType(f), info: f.label || f.key })));
    }
    return null;
  };
}

// ---- Hover docs ----------------------------------------------------------------------------------------------------
export function hoverDoc(state: EditorState, pos: number, hints: HintContext): { from: number; to: number; title: string; doc: string } | null {
  const range = state.wordAt(pos); if (!range) return null;
  const name = state.sliceDoc(range.from, range.to), line = state.doc.lineAt(pos);
  const before = state.sliceDoc(line.from, range.from), after = state.sliceDoc(range.to, Math.min(line.to, range.to + 2));
  if (name === 'Dima' && !/\.\s*$/.test(before)) return { from: range.from, to: range.to, title: 'Dima', doc: TYPES['DimaSDK'].doc };
  if (name === 'SE_API' && hints.engine === 'streamelements') return { from: range.from, to: range.to, title: 'SE_API', doc: TYPES['SEApi'].doc };
  const quoted = /(['"`])$/.test(before) && /^['"`]/.test(after);
  if (quoted) {
    const event = /\bDima\s*\.\s*(?:on|off)\s*\(\s*['"`]$/.test(before) ? DIMA_EVENTS.find(e => e.name === name) : undefined;
    if (event) return { from: range.from, to: range.to, title: `${event.name} → ${event.type}`, doc: event.doc + (event.uses ? ` Needs "${event.uses}" in widget.json uses.` : '') };
    const state = /\bDima\s*\.\s*state\s*\(\s*['"`]$/.test(before) ? STATE_REFS.find(ref => ref.name === name) : undefined;
    if (state) return { from: range.from, to: range.to, title: `${state.name} → ${state.type}`, doc: state.doc };
    const listener = hints.engine === 'streamelements' ? SE_LISTENERS.find(l => l.name === name) : undefined;
    if (listener) return { from: range.from, to: range.to, title: listener.name, doc: listener.doc };
    return null;
  }
  const chain = /([A-Za-z_$][\w$]*(?:\(\))?(?:\s*\.\s*[A-Za-z_$][\w$]*(?:\(\))?)*)\s*\.\s*$/.exec(before);
  if (!chain) return null;
  const type = resolvePath(splitChain(chain[1]), state, range.from, hints);
  const prop = type ? member(propsOf(type, hints), name) : undefined;
  return prop ? { from: range.from, to: range.to, title: `${name}${prop.call ? ` — ${prop.call}` : `: ${prop.type}`}`, doc: prop.doc } : null;
}

/** All suggestion sources for the code editor (language data keeps CodeMirror's own JS/CSS/HTML suggestions). */
export function codeHints(file: CodeFile, hints: Hints): Extension[] {
  if (file === 'fields' || file === 'data' || file === 'manifest') return [jsonLanguage.data.of({ autocomplete: jsonCompletions(file, hints) })];
  return [
    javascriptLanguage.data.of({ autocomplete: jsCompletions(hints) }),
    htmlLanguage.data.of({ autocomplete: placeholderCompletions(hints, false) }),
    cssLanguage.data.of({ autocomplete: placeholderCompletions(hints, true) }),
    hoverTooltip((view, pos): Tooltip | null => {
      const found = hoverDoc(view.state, pos, hints());
      if (!found) return null;
      return { pos: found.from, end: found.to, above: true, create: () => {
        // Text only (no HTML): docs and setting labels are shown as typed.
        const dom = document.createElement('div'), title = document.createElement('code'), doc = document.createElement('p');
        dom.className = 'cm-dima-hover'; title.textContent = found.title; doc.textContent = found.doc;
        dom.append(title, doc);
        return { dom };
      } };
    })
  ];
}
