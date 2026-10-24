import type { RootNode } from './blocks.model';

/**
 * Unsaved command edits kept in this browser, so a refresh or a trip to the
 * upgrade checkout doesn't lose work. One draft per channel + command (or per
 * new command / new keyword). Drafts expire after a week.
 */
export interface CommandDraft {
  v: 1;
  savedAt: number;
  authoring: 'text' | 'blocks';
  root: RootNode | null;
  form: Record<string, unknown>;
  access?: unknown;
}

const PREFIX = 'dimasite.commandDraft.v1';
const RESUME = 'dimasite.commandDraft.resume';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type DraftTarget = { channelID: string; commandId: string | null; activation: 'command' | 'keyword' };

export function draftKey(target: DraftTarget): string {
  return `${PREFIX}.${target.channelID}.${target.commandId ?? `new-${target.activation}`}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readDraft(key: string): CommandDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as CommandDraft;
    if (draft?.v !== 1 || Date.now() - draft.savedAt > MAX_AGE_MS) {
      store.removeItem(key);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/** Returns false when the browser refuses (private mode, full storage). */
export function writeDraft(key: string, draft: Omit<CommandDraft, 'v' | 'savedAt'>): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify({ ...draft, v: 1, savedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(key: string): void {
  storage()?.removeItem(key);
}

/** Before leaving for checkout: remember which draft to reopen when the streamer comes back. */
export function markResume(channelID: string, key: string): void {
  try {
    storage()?.setItem(`${RESUME}.${channelID}`, JSON.stringify({ key, at: Date.now() }));
  } catch {
    // Without storage there is nothing to resume.
  }
}

/** The draft to reopen for this channel, once. */
export function takeResume(channelID: string): string | null {
  const store = storage();
  if (!store) return null;
  const id = `${RESUME}.${channelID}`;
  try {
    const raw = store.getItem(id);
    store.removeItem(id);
    if (!raw) return null;
    const { key, at } = JSON.parse(raw) as { key?: string; at?: number };
    return key && at && Date.now() - at < RESUME_MAX_AGE_MS && readDraft(key) ? key : null;
  } catch {
    return null;
  }
}
