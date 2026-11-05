import type { PackageFile, PackageInput } from './custom-widget-format.generated';

/** The six files the code editor shows; `manifest` is widget.json (empty = none). */
export type CodeFile = PackageFile | 'manifest';
export const CODE_FILES: readonly CodeFile[] = ['html', 'css', 'js', 'fields', 'data', 'manifest'];
export type CodeFiles = Record<CodeFile, string>;
export const emptyCodeFiles = (): CodeFiles => ({ html: '', css: '', js: '', fields: '', data: '', manifest: '' });
export const sameCodeFiles = (a: CodeFiles | null, b: CodeFiles | null) => !!a && !!b && CODE_FILES.every(file => a[file] === b[file]);
/** What the API takes: widget.json only when it has content. */
export function toPackage(files: CodeFiles): PackageInput {
  const { manifest, ...rest } = files;
  return manifest.trim() ? { ...rest, manifest } : rest;
}

/**
 * Unsaved code-editor work, kept in this browser until it's saved or discarded. Each editor session writes its own
 * key (`<channel>.<widgetId|new>.<session>`), so two tabs never overwrite or delete each other's work; opening the
 * editor offers the newest one. A session never deletes another session's draft (that tab may still need it): taking
 * one over or discarding it only dismisses that saved state; if its tab writes again, the newer work shows again.
 * `base` is the revision the edits started from.
 */
export interface CodeDraft { files: CodeFiles; base: number; at: number; name?: string }
export interface StoredCodeDraft extends CodeDraft { key: string }
const PREFIX = 'dimasite.cw-code.v1.';
const MAX_AGE_MS = 30 * 24 * 3600_000;
const DISMISSED = `${PREFIX}dismissed`;
const stamp = (draft: StoredCodeDraft) => `${draft.key}@${draft.at}`;
function dismissed(): Set<string> {
  try { const list: unknown = JSON.parse(localStorage.getItem(DISMISSED) ?? '[]'); return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []); }
  catch { return new Set(); }
}
/** Hides this saved state of a draft (taken over or discarded) without deleting another session's key. */
export function dismissCodeDraft(draft: StoredCodeDraft): void {
  try { localStorage.setItem(DISMISSED, JSON.stringify([...dismissed(), stamp(draft)].slice(-100))); } catch { /* storage unavailable */ }
}
const widgetKey = (channel: string, id: string) => `${PREFIX}${channel}.${id}`;
export const codeDraftKey = (channel: string, id: string, session: string) => `${widgetKey(channel, id)}.${session}`;

function parse(text: string | null): CodeDraft | null {
  try {
    const raw = JSON.parse(text ?? 'null') as Partial<CodeDraft> | null;
    if (!raw || typeof raw !== 'object' || typeof raw.base !== 'number' || typeof raw.at !== 'number' || !raw.files) return null;
    const files = emptyCodeFiles();
    for (const file of CODE_FILES) { const value = (raw.files as Partial<CodeFiles>)[file]; if (typeof value !== 'string') return null; files[file] = value; }
    return { files, base: raw.base, at: raw.at, ...(typeof raw.name === 'string' ? { name: raw.name } : {}) };
  } catch { return null; }
}
/** The newest draft any session kept for this widget (`except`: this session's own key). Drafts older than 30 days are dropped. */
export function latestCodeDraft(channel: string, id: string, except?: string): StoredCodeDraft | null {
  try {
    const base = widgetKey(channel, id), keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key && (key === base || key.startsWith(base + '.'))) keys.push(key); }
    let latest: StoredCodeDraft | null = null;
    const hidden = dismissed();
    for (const key of keys) {
      if (key === except) continue;
      const draft = parse(localStorage.getItem(key));
      // Broken or month-old drafts are abandoned for sure.
      if (!draft || Date.now() - draft.at > MAX_AGE_MS) { localStorage.removeItem(key); continue; }
      if (hidden.has(`${key}@${draft.at}`)) continue;
      if (!latest || draft.at > latest.at) latest = { ...draft, key };
    }
    return latest;
  } catch { return null; }
}
/** False when the browser won't store it (private window, full storage). */
export function writeCodeDraft(key: string, draft: CodeDraft): boolean {
  try { localStorage.setItem(key, JSON.stringify(draft)); return true; } catch { return false; }
}
export function removeCodeDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* nothing stored */ }
}
