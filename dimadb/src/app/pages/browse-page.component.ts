import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { extractApiError } from '../services/api-error';
import { RedisKeyRow } from '../services/api.types';
import { ConnectionsService } from '../services/connections.service';
import { RedisService } from '../services/redis.service';

@Component({
  selector: 'app-browse-page',
  imports: [RouterLink],
  templateUrl: './browse-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowsePageComponent {
  private readonly redis = inject(RedisService);
  readonly connections = inject(ConnectionsService);

  readonly keys = signal<RedisKeyRow[]>([]);
  readonly cursor = signal('0');
  readonly match = signal('*');
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.connections.selectedId();
      if (id) {
        void this.load(true);
      }
    });
  }

  onSearch(event: Event): void {
    this.match.set((event.target as HTMLInputElement).value || '*');
    void this.load(true);
  }

  async load(reset = false): Promise<void> {
    const id = this.connections.selectedId();
    if (!id) {
      this.keys.set([]);
      return;
    }

    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const result = await this.redis.scan(id, reset ? '0' : this.cursor(), this.match());
      this.keys.set(reset ? result.keys : [...this.keys(), ...result.keys]);
      this.cursor.set(String(result.cursor));
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Scan failed').message);
    } finally {
      this.loading.set(false);
    }
  }

  ttlLabel(ttl: number): string {
    if (ttl < 0) {
      return '—';
    }
    if (ttl < 60) {
      return `${ttl}s`;
    }
    if (ttl < 3600) {
      return `${Math.round(ttl / 60)}m`;
    }
    return `${Math.round(ttl / 3600)}h`;
  }
}
