/**
 * CodeMirror 6 for the custom widget code editor. Loaded with a dynamic import only when the editor opens, so Studio
 * doesn't carry it. One EditorState per file keeps each tab's undo history, cursor and scroll.
 */
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';

export type CodeLanguage = 'html' | 'css' | 'js' | 'json';
export interface CodeTab { text: string; language: CodeLanguage; label: string }
export interface CodeEditor<K extends string> {
  show(tab: K): void;
  /** Replaces a file's text as one undoable change. */
  setText(tab: K, text: string): void;
  /** Shows a tab and puts the cursor on a line (1-based). */
  reveal(tab: K, line: number): void;
  destroy(): void;
}

// Colours come from CSS variables on the dialog, so dark/light switch without rebuilding the editor.
const theme = EditorView.theme({
  '&': { flex: '1 1 auto', minWidth: '0', height: '100%', color: 'var(--cm-fg)', backgroundColor: 'var(--cm-bg)', fontSize: 'var(--cm-size)' },
  '&.cm-focused': { outline: '2px solid #7c3aed', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace", lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--cm-cursor)', padding: '0.5rem 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cm-cursor)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--cm-selection)' },
  '.cm-gutters': { color: 'var(--cm-gutter)', backgroundColor: 'var(--cm-bg)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--cm-active)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--cm-selection)', outline: '1px solid var(--cm-gutter)' },
  '.cm-searchMatch': { backgroundColor: 'var(--cm-match)' },
  '.cm-tooltip, .cm-panels': { color: 'var(--fg)', backgroundColor: 'var(--tile)', border: '1px solid var(--line)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { color: 'var(--fg)', backgroundColor: 'var(--accent-soft)' },
  '.cm-panel input, .cm-panel button': { fontSize: '16px' },
  '.cm-foldPlaceholder': { color: 'var(--cm-fg)', backgroundColor: 'var(--cm-active)', border: 'none' }
});
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], color: 'var(--cm-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--cm-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: 'var(--cm-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: [tags.tagName, tags.typeName, tags.className, tags.angleBracket], color: 'var(--cm-tag)' },
  { tag: [tags.attributeName, tags.propertyName], color: 'var(--cm-attr)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: 'var(--cm-fn)' },
  { tag: tags.invalid, color: 'var(--danger)' }
]);
const languages: Record<CodeLanguage, () => Extension> = { html: () => html(), css: () => css(), js: () => javascript(), json: () => json() };

export function createCodeEditor<K extends string>(parent: HTMLElement, tabs: Record<K, CodeTab>, first: K, onChange: (tab: K, text: string) => void): CodeEditor<K> {
  const make = (tab: K, text: string) => EditorState.create({ doc: text, extensions: [
    basicSetup, keymap.of([indentWithTab]), EditorView.lineWrapping, theme, syntaxHighlighting(highlight), languages[tabs[tab].language](),
    // tabindex makes the (already focusable) editable area count as the scroll region's focusable content.
    EditorView.contentAttributes.of({ 'aria-label': tabs[tab].label, tabindex: '0' }),
    EditorView.updateListener.of(update => { if (update.docChanged) onChange(tab, update.state.doc.toString()); })
  ] });
  const states = new Map<K, EditorState>((Object.keys(tabs) as K[]).map(tab => [tab, make(tab, tabs[tab].text)]));
  let current = first;
  const view = new EditorView({ state: states.get(first)!, parent });
  const show = (tab: K) => {
    if (tab === current) return;
    states.set(current, view.state); current = tab; view.setState(states.get(tab)!);
  };
  return {
    show,
    setText(tab, text) {
      const state = tab === current ? view.state : states.get(tab)!;
      if (state.doc.toString() === text) return;
      const change = { changes: { from: 0, to: state.doc.length, insert: text } };
      if (tab === current) view.dispatch(change); else { states.set(tab, state.update(change).state); onChange(tab, text); }
    },
    reveal(tab, line) {
      show(tab);
      const doc = view.state.doc, target = doc.line(Math.min(Math.max(1, line), doc.lines));
      view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
      view.focus();
    },
    destroy() { view.destroy(); }
  };
}
