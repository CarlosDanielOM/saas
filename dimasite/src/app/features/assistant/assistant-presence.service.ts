import { Injectable, signal } from '@angular/core';

/** What the mascot shows. Same states as the docs mascot. */
export type MascotMood = 'idle' | 'thinking' | 'reading' | 'speaking' | 'happy' | 'error';

/**
 * Small shared seam between the panel (which knows what the assistant is doing) and the
 * mascot (which only draws it). The panel store writes; the mascot reads.
 */
@Injectable({ providedIn: 'root' })
export class AssistantPresenceService {
  /** Assistant available for this channel (GET /status enabled). */
  readonly enabled = signal(false);
  /** Panel open. */
  readonly open = signal(false);
  readonly mood = signal<MascotMood>('idle');
  /** Short bubble text next to the docked mascot (e.g. "Ask", "Thinking…"). Null = default label. */
  readonly bubble = signal<string | null>(null);
  /** Unread finished answer while the panel is closed. */
  readonly unread = signal(false);
  /**
   * Per area ('commands', 'timers', 'moderation', …): a number that grows each time the assistant
   * changes (or undoes a change to) that area's data on the channel. Kept per area, so a later change
   * somewhere else does not hide an earlier one from the page that shows it.
   */
  private readonly dataRevisions = signal<Readonly<Record<string, number>>>({});
  private revision = 0;

  notifyDataChanged(area: string): void {
    const next = ++this.revision;
    this.dataRevisions.update((map) => ({ ...map, [area]: next }));
  }

  /**
   * Latest change among these areas (0 = none since the app loaded). A page that shows them keeps
   * the number it last loaded and reloads past its cache when this one is higher: the change then
   * shows without a reload, and a list cached before it is not shown again.
   */
  changedAt(...areas: string[]): number {
    const map = this.dataRevisions();
    return Math.max(0, ...areas.map((area) => map[area] ?? 0));
  }

  toggle(): void {
    this.open.update((value) => !value);
    if (this.open()) this.unread.set(false);
  }

  show(): void {
    this.open.set(true);
    this.unread.set(false);
  }

  hide(): void {
    this.open.set(false);
  }
}
