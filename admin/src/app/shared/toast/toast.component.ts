import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService, type Toast } from './toast.service';

@Component({
  selector: 'app-toast',
  template: `
    <div class="toast-container">
      @for (toast of toastService.toasts(); track toast.id) {
        <div class="toast toast--{{ toast.type }}" role="alert">
          <div class="toast__icon">
            @switch (toast.type) {
              @case ('success') {
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                </svg>
              }
              @case ('error') {
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              }
              @case ('warning') {
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                </svg>
              }
              @default {
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
              }
            }
          </div>
          <span class="toast__message">{{ toast.message }}</span>
          <button type="button" class="toast__close" (click)="dismiss(toast.id)">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    .toast-container {
      position: fixed;
      bottom: 1rem;
      right: 1rem;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-width: 90vw;
      width: 350px;
    }

    @media (max-width: 480px) {
      .toast-container {
        left: 1rem;
        right: 1rem;
        width: auto;
      }
    }

    .toast {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      border-radius: 0.5rem;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.2);
      animation: slideIn 0.3s ease-out;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(100%);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .toast--success {
      background: rgba(34, 197, 94, 0.95);
      color: white;
    }

    .toast--error {
      background: rgba(239, 68, 68, 0.95);
      color: white;
    }

    .toast--warning {
      background: rgba(245, 158, 11, 0.95);
      color: white;
    }

    .toast--info {
      background: rgba(59, 130, 246, 0.95);
      color: white;
    }

    .toast__icon {
      flex-shrink: 0;
    }

    .toast__message {
      flex: 1;
      font-size: 0.875rem;
      line-height: 1.4;
    }

    .toast__close {
      flex-shrink: 0;
      padding: 0.25rem;
      border-radius: 0.25rem;
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.2s;
    }

    .toast__close:hover {
      opacity: 1;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ToastComponent {
  protected readonly toastService = inject(ToastService);

  dismiss(id: number): void {
    this.toastService.dismiss(id);
  }
}
