import { ToastTone } from '../services/toast.service';

export interface ToastAction {
  type: 'toast';
  tone: ToastTone;
  title?: string;
  message?: string;
  titleKey?: string;
  titleParams?: Record<string, string | number>;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  durationMs?: number;
}

export interface RedirectAction {
  type: 'redirect';
  to: string;           // Angular route path compatible with router.navigateByUrl (SPA navigation)
  delayMs?: number;     // optional – if absent, navigate immediately (skip showing dashboard shell)
}

export type PendingAction = ToastAction | RedirectAction;
