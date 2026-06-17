import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { LanguageService } from './language.service';
import { ToastService, type ToastTone } from './toast.service';
import type { PendingAction, ToastAction } from '../models/pending-action.model';

/**
 * Service that manages a queue of post-login actions persisted in sessionStorage.
 * The queue survives page reloads and is drained once after the user has a valid session.
 *
 * Supported actions (extensible):
 * - toast: show a toast (supports raw strings or i18n keys)
 * - redirect: SPA navigate via router.navigateByUrl (optional delay)
 *
 * Storage key: 'dimasite.pendingActionsQueue'
 * Legacy migration: automatically converts the old single-string 'dimasite.pendingEmailAction'
 */
@Injectable({ providedIn: 'root' })
export class PendingActionsQueueService {
  private readonly storageKey = 'dimasite.pendingActionsQueue';
  private readonly legacyKey = 'dimasite.pendingEmailAction';

  private readonly _queueLength = signal(0);
  /** Reactive queue length (useful for debugging or future UI indicators) */
  readonly queueLength = computed(() => this._queueLength());

  constructor() {
    this.syncLength();
  }

  private syncLength(): void {
    const len = this.readQueue().length;
    this._queueLength.set(len);
  }

  private readQueue(): PendingAction[] {
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeQueue(actions: PendingAction[]): void {
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(actions));
    } catch {
      // storage may be unavailable or full; ignore
    }
    this.syncLength();
  }

  /**
   * Returns a copy of the current pending actions queue.
   */
  getQueue(): PendingAction[] {
    return [...this.readQueue()];
  }

  /**
   * Append a new action to the end of the queue.
   */
  pushAction(action: PendingAction): void {
    const current = this.readQueue();
    current.push(action);
    this.writeQueue(current);
  }

  /**
   * Remove all pending actions.
   */
  clearQueue(): void {
    try {
      sessionStorage.removeItem(this.storageKey);
    } catch {}
    this._queueLength.set(0);
  }

  /**
   * Migrate the legacy single-string email action key (if present) into the new queue.
   * Safe to call multiple times; only migrates once.
   */
  private migrateLegacyIfNeeded(): void {
    try {
      const legacy = sessionStorage.getItem(this.legacyKey);
      if (legacy === 'alreadyActivated') {
        this.pushAction({
          type: 'toast',
          tone: 'success',
          titleKey: 'login.toast.alreadyActivatedTitle',
          messageKey: 'login.toast.alreadyActivatedMessage'
        });
        sessionStorage.removeItem(this.legacyKey);
      }
    } catch {
      // ignore storage issues
    }
  }

  /**
   * Small helper that resolves display text for a toast action.
   * Precedence: raw string > i18n key.
   */
  resolveToastText(
    action: ToastAction,
    translate: (key: string, params?: Record<string, string | number>) => string
  ): { title: string; message: string } {
    const title = action.title
      ? action.title
      : action.titleKey
        ? translate(action.titleKey, action.titleParams)
        : '';

    const message = action.message
      ? action.message
      : action.messageKey
        ? translate(action.messageKey, action.messageParams)
        : '';

    return { title, message };
  }

  /**
   * Process (and clear) the entire queue.
   * Should be called once after a valid user session is established.
   *
   * - toasts are shown immediately using the provided services.
   * - redirects use Angular SPA navigation (router.navigateByUrl).
   *   If delayMs is provided, the redirect is scheduled.
   *   If delayMs is absent, navigation happens immediately (no dashboard shell is shown first).
   */
  processQueue(
    router: Router,
    toastService: ToastService,
    languageService: LanguageService
  ): void {
    this.migrateLegacyIfNeeded();

    const actions = this.readQueue();
    if (!actions.length) return;

    const translate = (key: string, params?: Record<string, string | number>) =>
      languageService.translate(key, params);

    for (const action of actions) {
      if (action.type === 'toast') {
        const { title, message } = this.resolveToastText(action, translate);
        if (title || message) {
          const dur = action.durationMs ?? 4200;
          switch (action.tone) {
            case 'success':
              toastService.success(title, message, dur);
              break;
            case 'error':
              toastService.error(title, message, dur);
              break;
            case 'warning':
              toastService.warning(title, message, dur);
              break;
            case 'info':
            default:
              toastService.info(title, message, dur);
              break;
          }
        }
      } else if (action.type === 'redirect') {
        const doRedirect = () => {
          // SPA-friendly navigation – no full page reload
          void router.navigateByUrl(action.to);
        };

        if (typeof action.delayMs === 'number' && action.delayMs > 0) {
          setTimeout(doRedirect, action.delayMs);
        } else {
          // Immediate redirect: subsequent actions in the queue (e.g. toasts)
          // will run on the destination route because we process the whole queue now.
          doRedirect();
        }
      }
      // Unknown action types are ignored (forward compatible)
    }

    // We have processed everything – clear the persisted queue
    this.clearQueue();
  }
}
