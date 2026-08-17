import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { extractApiError } from '../services/api-error';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-login-page',
  imports: [RouterLink],
  templateUrl: './login-page.component.html',
  styleUrl: './auth-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPageComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly submitting = signal(false);
  readonly errorMessage = signal<string | null>(null);

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    const username = String(data.get('username') || '').trim();
    const password = String(data.get('password') || '');

    this.submitting.set(true);
    this.errorMessage.set(null);
    try {
      await this.auth.login(username, password);
      await this.router.navigateByUrl('/browse');
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Login failed').message);
    } finally {
      this.submitting.set(false);
    }
  }
}
