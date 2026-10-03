import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { ToastService } from './toast.service';

const ICONS = { success: 'ok', error: 'alert', warning: 'alert', info: 'info' } as const;

@Component({
  selector: 'app-toast',
  imports: [IconComponent],
  template: `
    <div class="toasts">
      @for (toast of toastService.toasts(); track toast.id) {
        <div
          class="toast toast--{{ toast.type }}"
          [attr.role]="toast.type === 'error' ? 'alert' : 'status'"
        >
          <app-icon [name]="icons[toast.type]" />
          <span class="toast__message">{{ toast.message }}</span>
          <button
            type="button"
            class="toast__close"
            aria-label="Dismiss notification"
            (click)="toastService.dismiss(toast.id)"
          >
            <app-icon name="x" />
          </button>
        </div>
      }
    </div>
  `,
  styleUrl: './toast.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastComponent {
  protected readonly toastService = inject(ToastService);
  protected readonly icons = ICONS;
}
