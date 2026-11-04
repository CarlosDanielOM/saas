import { Injectable, signal } from '@angular/core';

/**
 * Full-screen pages (Overlay Studio) ask the signed-in layout to hide its navbar while
 * they are open. Loading, error and permission screens keep the normal navbar.
 */
@Injectable({ providedIn: 'root' })
export class LayoutFocusService {
  readonly active = signal(false);
}
