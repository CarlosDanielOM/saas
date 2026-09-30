import type { CanDeactivateFn } from '@angular/router';
import type { OverlayEditorComponent } from './overlay-editor.component';

export const overlayDraftGuard: CanDeactivateFn<OverlayEditorComponent> = component => component.canLeave();
