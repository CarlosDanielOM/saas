import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiEnvelope, AuthUser } from './api.types';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  private readonly userState = signal<AuthUser | null>(null);
  private readonly setupState = signal(false);
  private refreshPromise: Promise<void> | null = null;

  readonly user = computed(() => this.userState());
  readonly needsSetup = computed(() => this.setupState());
  readonly isAuthenticated = computed(() => Boolean(this.userState()));

  async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.load();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async setup(username: string, password: string): Promise<void> {
    const response = await firstValueFrom(
      this.http.post<ApiEnvelope<{ user: AuthUser }>>('/api/setup', { username, password }),
    );
    if (response.error || !response.data?.user) {
      throw new Error(response.message || 'Setup failed');
    }
    this.userState.set(response.data.user);
    this.setupState.set(false);
  }

  async login(username: string, password: string): Promise<void> {
    const response = await firstValueFrom(
      this.http.post<ApiEnvelope<{ user: AuthUser }>>('/api/login', { username, password }),
    );
    if (response.error || !response.data?.user) {
      throw new Error(response.message || 'Login failed');
    }
    this.userState.set(response.data.user);
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.http.post<ApiEnvelope<{ ok: boolean }>>('/api/logout', {}));
    this.userState.set(null);
  }

  async users(): Promise<AuthUser[]> {
    const response = await firstValueFrom(this.http.get<ApiEnvelope<AuthUser[]>>('/api/users'));
    if (response.error || !response.data) {
      throw new Error(response.message || 'Failed to load users');
    }
    return response.data;
  }

  async addUser(username: string, password: string): Promise<AuthUser> {
    const response = await firstValueFrom(
      this.http.post<ApiEnvelope<AuthUser>>('/api/users', { username, password, role: 'admin' }),
    );
    if (response.error || !response.data) {
      throw new Error(response.message || 'Failed to add user');
    }
    return response.data;
  }

  private async load(): Promise<void> {
    const status = await firstValueFrom(
      this.http.get<ApiEnvelope<{ needsSetup: boolean }>>('/api/setup/status'),
    );
    this.setupState.set(Boolean(status.data?.needsSetup));

    try {
      const me = await firstValueFrom(this.http.get<ApiEnvelope<{ user: AuthUser }>>('/api/me'));
      this.userState.set(me.data?.user ?? null);
    } catch {
      this.userState.set(null);
    }
  }
}
