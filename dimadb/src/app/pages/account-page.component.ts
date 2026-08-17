import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { extractApiError } from '../services/api-error';
import { AuthUser } from '../services/api.types';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-account-page',
  templateUrl: './account-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountPageComponent {
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  readonly users = signal<AuthUser[]>([]);
  readonly errorMessage = signal<string | null>(null);
  readonly adding = signal(false);

  constructor() {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      this.users.set(await this.auth.users());
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Failed to load users').message);
    }
  }

  async add(event: Event): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    this.adding.set(true);
    try {
      await this.auth.addUser(String(data.get('username') || ''), String(data.get('password') || ''));
      (event.target as HTMLFormElement).reset();
      await this.reload();
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Could not add user').message);
    } finally {
      this.adding.set(false);
    }
  }

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}
