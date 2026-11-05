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
 * Unsaved code-editor work, kept in this browser until it's saved or discarded (per channel and widget; `new` for a
 * widget that doesn't exist yet). `base` is the revision the edits started from.
 */
export interface CodeDraft { files: CodeFiles; base: number; at: number; name?: string }
const key = (channel: string, id: string) => `dimasite.cw-code.v1.${channel}.${id}`;

export function readCodeDraft(channel: string, id: string): CodeDraft | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key(channel, id)) ?? 'null') as Partial<CodeDraft> | null;
    if (!raw || typeof raw !== 'object' || typeof raw.base !== 'number' || typeof raw.at !== 'number' || !raw.files) return null;
    const files = emptyCodeFiles();
    for (const file of CODE_FILES) { const text = (raw.files as Partial<CodeFiles>)[file]; if (typeof text !== 'string') return null; files[file] = text; }
    return { files, base: raw.base, at: raw.at, ...(typeof raw.name === 'string' ? { name: raw.name } : {}) };
  } catch { return null; }
}
/** False when the browser won't store it (private window, full storage). */
export function writeCodeDraft(channel: string, id: string, draft: CodeDraft): boolean {
  try { localStorage.setItem(key(channel, id), JSON.stringify(draft)); return true; } catch { return false; }
}
export function clearCodeDraft(channel: string, id: string): void {
  try { localStorage.removeItem(key(channel, id)); } catch { /* nothing stored */ }
}
