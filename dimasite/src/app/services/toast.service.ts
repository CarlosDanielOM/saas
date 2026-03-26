import { Injectable, computed, signal } from '@angular/core';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  tone: ToastTone;
  title: string;
  message: string;
  durationMs: number;
}

interface ShowToastOptions {
  title: string;
  message: string;
  durationMs?: number;
}

@Injectable({
  providedIn: 'root'
})
export class ToastService {
  private readonly items = signal<ToastItem[]>([]);
  private readonly timeoutHandles = new Map<string, number>();

  readonly toasts = computed(() => this.items());

  success(title: string, message: string, durationMs = 4200): string {
    return this.show('success', { title, message, durationMs });
  }

  error(title: string, message: string, durationMs = 5200): string {
    return this.show('error', { title, message, durationMs });
  }

  warning(title: string, message: string, durationMs = 4800): string {
    return this.show('warning', { title, message, durationMs });
  }

  info(title: string, message: string, durationMs = 4200): string {
    return this.show('info', { title, message, durationMs });
  }

  dismiss(id: string): void {
    const timeoutHandle = this.timeoutHandles.get(id);
    if (timeoutHandle !== undefined) {
      window.clearTimeout(timeoutHandle);
      this.timeoutHandles.delete(id);
    }

    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  clear(): void {
    for (const timeoutHandle of this.timeoutHandles.values()) {
      window.clearTimeout(timeoutHandle);
    }

    this.timeoutHandles.clear();
    this.items.set([]);
  }

  private show(tone: ToastTone, options: ShowToastOptions): string {
    const id = this.createId();
    const toast: ToastItem = {
      id,
      tone,
      title: options.title,
      message: options.message,
      durationMs: options.durationMs ?? 4200
    };

    this.items.update((items) => [...items, toast]);

    const timeoutHandle = window.setTimeout(() => {
      this.dismiss(id);
    }, toast.durationMs);

    this.timeoutHandles.set(id, timeoutHandle);

    return id;
  }

  private createId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
