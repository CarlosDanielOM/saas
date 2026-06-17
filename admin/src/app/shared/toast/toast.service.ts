import { Injectable, signal, computed } from '@angular/core';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
}

@Injectable({
  providedIn: 'root'
})
export class ToastService {
  private readonly _toasts = signal<Toast[]>([]);
  private idCounter = 0;

  readonly toasts = computed(() => this._toasts());

  show(message: string, type: ToastType = 'info', duration = 5000): void {
    const id = ++this.idCounter;
    const toast: Toast = { id, message, type, duration };

    this._toasts.update(current => [...current, toast]);

    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration);
    }
  }

  success(message: string, duration = 5000): void {
    this.show(message, 'success', duration);
  }

  error(message: string, duration = 8000): void {
    this.show(message, 'error', duration);
  }

  info(message: string, duration = 5000): void {
    this.show(message, 'info', duration);
  }

  warning(message: string, duration = 6000): void {
    this.show(message, 'warning', duration);
  }

  dismiss(id: number): void {
    this._toasts.update(current => current.filter(t => t.id !== id));
  }

  clear(): void {
    this._toasts.set([]);
  }
}
