import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiEnvelope, DbConnection } from './api.types';

@Injectable({ providedIn: 'root' })
export class ConnectionsService {
  private readonly http = inject(HttpClient);
  private readonly itemsState = signal<DbConnection[]>([]);
  private readonly selectedState = signal<string | null>(null);

  readonly items = computed(() => this.itemsState());
  readonly selectedId = computed(() => this.selectedState() ?? this.itemsState()[0]?.id ?? null);
  readonly selected = computed(
    () => this.itemsState().find((item) => item.id === this.selectedId()) ?? null,
  );

  select(id: string): void {
    this.selectedState.set(id);
  }

  async load(): Promise<void> {
    const response = await firstValueFrom(this.http.get<ApiEnvelope<DbConnection[]>>('/api/connections'));
    if (response.error || !response.data) {
      throw new Error(response.message || 'Failed to load connections');
    }
    this.itemsState.set(response.data);
    if (!this.selectedState() && response.data[0]) {
      this.selectedState.set(response.data[0].id);
    }
  }

  async add(name: string, url: string): Promise<void> {
    const response = await firstValueFrom(
      this.http.post<ApiEnvelope<DbConnection>>('/api/connections', { name, url }),
    );
    if (response.error || !response.data) {
      throw new Error(response.message || 'Failed to add connection');
    }
    await this.load();
    this.selectedState.set(response.data.id);
  }

  async remove(id: string): Promise<void> {
    const response = await firstValueFrom(this.http.delete<ApiEnvelope<{ ok: boolean }>>(`/api/connections/${id}`));
    if (response.error) {
      throw new Error(response.message || 'Failed to delete connection');
    }
    if (this.selectedState() === id) {
      this.selectedState.set(null);
    }
    await this.load();
  }

  async ping(id: string): Promise<string> {
    const response = await firstValueFrom(
      this.http.post<ApiEnvelope<{ pong: string }>>(`/api/connections/${id}/ping`, {}),
    );
    if (response.error || !response.data) {
      throw new Error(response.message || 'Ping failed');
    }
    return response.data.pong;
  }
}
