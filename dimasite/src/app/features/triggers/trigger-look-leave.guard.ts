import type { CanDeactivateFn } from '@angular/router';
import type { TriggersPageComponent } from './triggers-page.component';

/**
 * Leaving the Triggers page inside the app (Back, a navbar link) while the look editor is open: unsaved look changes
 * ask first, and a save in progress finishes before leaving. Only the open look dialog is consulted.
 */
export const triggerLookLeaveGuard: CanDeactivateFn<TriggersPageComponent> = component => component.canLeave();
