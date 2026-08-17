import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { extractApiError } from '../services/api-error';
import { ConnectionsService } from '../services/connections.service';

@Component({
  selector: 'app-connections-page',
  templateUrl: './connections-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectionsPageComponent {
  readonly connections = inject(ConnectionsService);
  readonly errorMessage = signal<string | null>(null);
  readonly adding = signal(false);
  readonly pings = signal<Record<string, string>>({});

  async add(event: Event): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const name = String(data.get('name') || '').trim();
    const url = String(data.get('url') || '').trim();
    this.adding.set(true);
    this.errorMessage.set(null);
    try {
      await this.connections.add(name, url);
      (event.target as HTMLFormElement).reset();
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Could not add connection').message);
    } finally {
      this.adding.set(false);
    }
  }

  async ping(id: string): Promise<void> {
    try {
      const pong = await this.connections.ping(id);
      this.pings.update((current) => ({ ...current, [id]: pong }));
    } catch (error) {
      this.pings.update((current) => ({ ...current, [id]: extractApiError(error, 'down').message }));
    }
  }

  async remove(id: string): Promise<void> {
    if (!confirm('Remove this connection?')) {
      return;
    }
    try {
      await this.connections.remove(id);
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Delete failed').message);
    }
  }
}
