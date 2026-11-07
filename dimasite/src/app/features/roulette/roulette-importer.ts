import { HttpErrorResponse } from '@angular/common/http';
import { computed, signal } from '@angular/core';
import { FormControl } from '@angular/forms';
import type { Roulette, RouletteApi } from './roulette-api.service';
import {
  ImportFileError,
  ImportFormat,
  PlannedRow,
  decodeText,
  detectFormat,
  parseImport,
  planImport,
  toCsv,
} from './roulette-import';

export interface ImporterHost {
  api: RouletteApi;
  channel: () => string;
  roulette: () => Roulette | null;
  revision: () => number | undefined;
  capacity: () => number;
  spinning: () => boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Pauses the page's polling while the import is sent. */
  setBusy: (busy: boolean) => void;
  refresh: () => Promise<void>;
  notice: (message: string) => void;
  focus: (selector: string) => void;
}

const MAX_FILE = 2 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** A hung request becomes an unknown outcome (status 0); the retry reuses its key. */
function withTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpErrorResponse({ status: 0, statusText: 'Timeout' })), TIMEOUT_MS);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}
const PAGE = 50;

/** State and actions of the "Import prizes" dialog; the markup lives in the roulette page. */
export class RouletteImporter {
  readonly open = signal(false);
  readonly text = signal('');
  readonly format = signal<ImportFormat>('list');
  readonly replace = signal(false);
  /**
   * "Import without the skipped lines". A form control (not a [checked] binding) so a reset
   * always reaches the checkbox, even when the text changes right after the click.
   */
  readonly ackControl = new FormControl(false, { nonNullable: true });
  readonly acceptSkips = signal(false);
  readonly sending = signal(false);
  readonly error = signal('');
  readonly fileNote = signal('');
  readonly fileError = signal('');
  readonly dragging = signal(false);
  readonly shown = signal(PAGE);

  readonly result = computed(() => parseImport(this.text(), this.format()));
  readonly plan = computed(() => {
    const r = this.host.roulette();
    return planImport(this.result().rows, r?.items ?? [], r?.settings.duplicate ?? 'separate', this.replace());
  });
  readonly visibleRows = computed(() => this.plan().rows.slice(0, this.shown()));
  readonly over = computed(() => this.plan().slots > this.host.capacity());
  readonly needsAck = computed(() => this.replace() && this.result().issues.length > 0);
  /** What would be sent, built from the text alone so a retry stays identical after a refresh. */
  readonly payload = computed(() => {
    const r = this.host.roulette();
    if (!r) return null;
    const body = {
      items: this.result().rows.map((row) => ({
        label: row.label,
        weight: row.weight,
        multiplier: row.count,
        ...(row.action !== undefined ? { action: row.action } : {}),
      })),
      ...(this.replace() ? { replace: true } : {}),
    };
    return { id: r.id, body, json: JSON.stringify([r.id, body]) };
  });
  /** Frozen payload + idempotency key: a retry after an unknown outcome cannot add twice. */
  private readonly pending = signal<{ json: string; key: string; revision?: number } | null>(null);
  /**
   * The same list was sent and the outcome is unknown. It may already be saved, so the
   * refreshed preview (which now counts it) must not block the retry; the server replays it.
   */
  readonly retrying = computed(() => {
    const pending = this.pending();
    return !!pending && pending.json === this.payload()?.json;
  });
  /** Why the import button is off, as an i18n key; '' when it can be sent. */
  readonly blocker = computed(() => {
    if (!this.result().rows.length || this.retrying()) return '';
    if (this.over()) return 'over';
    if (this.plan().clashes) return 'import.blockClashes';
    if (this.replace() && this.host.spinning()) return 'import.err.spinning';
    if (this.needsAck() && !this.acceptSkips()) return 'import.blockSkips';
    return '';
  });
  readonly canSend = computed(() => !this.sending() && !!this.result().rows.length && !this.blocker());

  constructor(private readonly host: ImporterHost) {
    this.ackControl.valueChanges.subscribe((on) => this.acceptSkips.set(on));
  }
  private resetAck(): void {
    this.ackControl.setValue(false);
  }

  start(): void {
    this.text.set('');
    this.format.set('list');
    this.replace.set(false);
    this.resetAck();
    this.error.set('');
    this.fileNote.set('');
    this.fileError.set('');
    this.dragging.set(false);
    this.shown.set(PAGE);
    // `pending` survives closing: re-sending the same list after an unknown outcome replays it.
    this.open.set(true);
    this.host.focus('#rl-import-text');
  }
  close(): void {
    if (!this.sending()) this.open.set(false);
  }
  setText(text: string): void {
    this.text.set(text);
    this.format.set(detectFormat(text));
    this.shown.set(PAGE);
    this.resetAck();
    this.error.set('');
  }
  setFormat(format: ImportFormat): void {
    this.format.set(format);
    this.resetAck();
    this.error.set('');
  }
  setReplace(on: boolean): void {
    this.replace.set(on);
    this.resetAck();
    this.error.set('');
  }
  more(): void {
    this.shown.update((n) => n + 200);
  }

  async pick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await this.load(file);
  }
  dragOver(event: DragEvent): void {
    if (this.sending() || !event.dataTransfer?.types.some((t) => t === 'Files' || t === 'text/plain')) return;
    event.preventDefault();
    this.dragging.set(true);
  }
  dragLeave(event: DragEvent): void {
    const to = event.relatedTarget as Node | null;
    if (!to || !(event.currentTarget as Node).contains(to)) this.dragging.set(false);
  }
  async drop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragging.set(false);
    if (this.sending()) return;
    const file = event.dataTransfer?.files?.[0];
    if (file) await this.load(file);
    else {
      const text = event.dataTransfer?.getData('text/plain');
      if (text) this.setText(text);
    }
  }
  private async load(file: File): Promise<void> {
    this.fileError.set('');
    this.fileNote.set('');
    if (file.size > MAX_FILE) {
      this.fileError.set(this.host.t('import.fileTooBig'));
      return;
    }
    try {
      const { text, encoding } = decodeText(new Uint8Array(await file.arrayBuffer()));
      this.setText(text);
      this.fileNote.set(
        this.host.t(encoding === 'windows-1252' ? 'import.fileReadLatin' : 'import.fileRead', { name: file.name }),
      );
    } catch (e) {
      const reason = e instanceof ImportFileError ? e.reason : 'encoding';
      this.fileError.set(
        this.host.t(reason === 'spreadsheet' ? 'import.fileSpreadsheet' : reason === 'binary' ? 'import.fileBinary' : 'import.fileError'),
      );
    }
  }

  /** Current prizes as a CSV the import reads back (UTF-8 BOM so Excel keeps accents). */
  download(): void {
    const r = this.host.roulette();
    if (!r?.items.length) return;
    const blob = new Blob(['﻿' + toCsv(r.items)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.alias || 'roulette'}-prizes.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async send(): Promise<void> {
    const payload = this.payload();
    if (!payload || !this.canSend()) return;
    const rows = this.plan().rows;
    // Only a replace needs the exact state the streamer saw; appends follow the server's rules.
    if (!this.retrying())
      this.pending.set({ json: payload.json, key: crypto.randomUUID(), revision: this.replace() ? this.host.revision() : undefined });
    const { key, revision } = this.pending()!;
    this.sending.set(true);
    this.error.set('');
    this.host.setBusy(true);
    try {
      await withTimeout(this.host.api.write(this.host.channel(), 'POST', `/roulettes/${payload.id}/import`, payload.body, revision, key));
      this.pending.set(null);
      this.open.set(false);
      this.host.notice(this.host.t('import.done', { count: payload.body.items.length, slots: this.result().copies }));
    } catch (e) {
      const status = e instanceof HttpErrorResponse ? e.status : 0;
      const err = e instanceof HttpErrorResponse ? (e.error as { code?: string; row?: number } | null) : null;
      // Offline, timeout or server error: the outcome is unknown, so keep the key for the retry.
      if (status >= 400 && status < 500 && err?.code !== 'busy') this.pending.set(null);
      this.error.set(this.describe(status, err?.code ?? '', err?.row, rows));
    } finally {
      this.sending.set(false);
      this.host.setBusy(false);
      await this.host.refresh();
    }
  }

  private describe(status: number, code: string, row: number | undefined, rows: PlannedRow[]): string {
    const t = this.host.t;
    const at = row ? rows[row - 1]?.row : undefined;
    const line = at?.line ?? row ?? 0;
    if (status === 0 || status >= 500) return t('import.err.network');
    if (status === 413) return t('import.err.tooBig');
    if (status === 403) return t('accessError');
    switch (code) {
      case 'revision_conflict':
        return t('import.err.changed');
      case 'spinning':
        return t('import.err.spinning');
      case 'capacity':
        return t('import.err.capacity');
      case 'weight':
        return t('import.err.weightTotal');
      case 'busy':
        return t('import.err.busy');
      case 'not_found':
        return t('import.err.gone');
      case 'invalid_action':
        return t('import.err.action', { line, name: at?.label ?? '' });
      case 'weight_conflict':
      case 'action_conflict':
        return t('import.err.clash', { line, name: at?.label ?? '' });
      default:
        return row ? t('import.err.row', { line, name: at?.label ?? '' }) : t('import.err.generic');
    }
  }
}
