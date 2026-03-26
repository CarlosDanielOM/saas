import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ToastItem, ToastService } from '../../services/toast.service';
import { Toast3DCardComponent } from './toast-3d-card.component';

@Component({
  selector: 'app-toast-container',
  imports: [Toast3DCardComponent],
  template: `
    @if (toastService.toasts().length > 0) {
      <section class="toast-3d-stack" aria-live="polite" aria-atomic="true">
        @for (toast of toastService.toasts(); track toast.id) {
          <app-toast-3d-card
            [toast]="toast"
            (dismiss)="toastService.dismiss($event)"
          />
        }
      </section>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ToastContainerComponent {
  protected readonly toastService = inject(ToastService);

  protected trackById(index: number, toast: ToastItem): string {
    return toast.id;
  }
}
