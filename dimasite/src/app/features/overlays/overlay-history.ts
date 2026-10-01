import { signal } from '@angular/core';
import type { AlertDesign, AlertEvent, OverlayScene } from './overlay.model';

type DraftScene = Omit<OverlayScene, 'publicId' | 'revision' | 'published'>;
type DraftDesign = Omit<AlertDesign, 'revision'>;
export interface OverlayEditSnapshot {
  document: { scenes: DraftScene[]; designs: DraftDesign[]; designDraft: DraftDesign | null };
  sceneId: string;
  designEvent: AlertEvent;
  selectedId: string | null;
}

/** Session history contains draft content only; server revisions and published URLs never rewind. */
export class OverlayHistory {
  readonly undoCount = signal(0);
  readonly redoCount = signal(0);
  private past: string[] = [];
  private future: string[] = [];
  private group: object | string | null = null;
  private readonly maxSteps = 100;
  private readonly maxBytes = 16 * 1024 * 1024;

  record(before: OverlayEditSnapshot, after: OverlayEditSnapshot, group: object | string | null = null): boolean {
    if (JSON.stringify(before.document) === JSON.stringify(after.document)) return false;
    if (!group || group !== this.group || !this.past.length) this.past.push(JSON.stringify(before));
    this.future = [];
    this.group = group;
    this.sync();
    return true;
  }

  undo(current: OverlayEditSnapshot): OverlayEditSnapshot | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(JSON.stringify(current));
    this.endGroup(); this.sync();
    return JSON.parse(previous) as OverlayEditSnapshot;
  }

  redo(current: OverlayEditSnapshot): OverlayEditSnapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(JSON.stringify(current));
    this.endGroup(); this.sync();
    return JSON.parse(next) as OverlayEditSnapshot;
  }

  endGroup(): void { this.group = null; }
  clear(): void { this.past = []; this.future = []; this.endGroup(); this.sync(); }

  private sync(): void {
    let bytes = [...this.past, ...this.future].reduce((total, entry) => total + entry.length * 2, 0);
    while (this.past.length + this.future.length > this.maxSteps || bytes > this.maxBytes) {
      const removed = this.past.length ? this.past.shift() : this.future.shift();
      if (!removed) break;
      bytes -= removed.length * 2;
    }
    this.undoCount.set(this.past.length); this.redoCount.set(this.future.length);
  }
}
