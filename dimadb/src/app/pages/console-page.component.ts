import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { extractApiError } from '../services/api-error';
import { ConnectionsService } from '../services/connections.service';
import { MongoService } from '../services/mongo.service';
import { RedisService } from '../services/redis.service';

@Component({
  selector: 'app-console-page',
  templateUrl: './console-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsolePageComponent {
  private readonly redis = inject(RedisService);
  private readonly mongo = inject(MongoService);
  readonly connections = inject(ConnectionsService);

  readonly output = signal('Ready.');
  readonly running = signal(false);

  async run(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.connections.selectedId();
    if (!id) {
      return;
    }
    const data = new FormData(event.target as HTMLFormElement);
    this.running.set(true);
    try {
      if (this.connections.engine() === 'mongo') {
        const result = await this.mongo.docs(
          id,
          String(data.get('db') || ''),
          String(data.get('collection') || ''),
          0,
          String(data.get('filter') || '{}'),
        );
        this.output.set(JSON.stringify(result, null, 2));
        return;
      }
      const command = String(data.get('command') || '').trim();
      if (!command) {
        return;
      }
      const result = await this.redis.command(id, command);
      this.output.set(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    } catch (error) {
      const err = error as { status?: number; message?: string };
      if (err.status === 409 && this.connections.engine() !== 'mongo') {
        if (confirm(`${err.message}\nRun it anyway?`)) {
          try {
            const command = String(data.get('command') || '').trim();
            const result = await this.redis.command(id, command, true);
            this.output.set(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
            return;
          } catch (confirmed) {
            this.output.set(extractApiError(confirmed, 'Command failed').message);
          }
        } else {
          this.output.set('Cancelled.');
        }
      } else {
        this.output.set(extractApiError(error, 'Command failed').message);
      }
    } finally {
      this.running.set(false);
    }
  }

  clear(): void {
    this.output.set('Ready.');
  }
}
