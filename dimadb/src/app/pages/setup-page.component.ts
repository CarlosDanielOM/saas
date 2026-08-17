import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { extractApiError } from '../services/api-error';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-setup-page',
  imports: [RouterLink],
  templateUrl: './setup-page.component.html',
  styleUrl: './auth-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupPageComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly submitting = signal(false);
  readonly errorMessage = signal<string | null>(null);

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const username = String(data.get('username') || '').trim();
    const password = String(data.get('password') || '');
    const confirm = String(data.get('confirm') || '');

    if (password !== confirm) {
      this.errorMessage.set('Passwords do not match');
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    try {
      await this.auth.setup(username, password);
      await this.router.navigateByUrl('/browse');
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Setup failed').message);
    } finally {
      this.submitting.set(false);
    }
  }
}
