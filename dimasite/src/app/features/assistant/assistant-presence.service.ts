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
