import { Injectable, signal } from '@angular/core';

/** A spot the mascot is pointing at. */
export interface GuideTarget {
  anchor: string;
  label: string;
}

/**
 * Seam for "show me where": the panel calls `point()` after navigating; the mascot overlay
 * reads `target` and flies there. Implementation of the flight lives in the mascot component.
 */
@Injectable({ providedIn: 'root' })
export class AssistantGuideService {
  readonly target = signal<GuideTarget | null>(null);

  point(anchor: string, label: string): void {
    this.target.set({ anchor, label });
  }

  clear(): void {
    this.target.set(null);
  }
}
