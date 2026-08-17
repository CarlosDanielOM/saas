import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { extractApiError } from '../services/api-error';
import { ConnectionsService } from '../services/connections.service';
import { RedisService } from '../services/redis.service';

@Component({
  selector: 'app-console-page',
  templateUrl: './console-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsolePageComponent {
  private readonly redis = inject(RedisService);
  readonly connections = inject(ConnectionsService);

  readonly output = signal('Ready.');
  readonly running = signal(false);

  async run(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.connections.selectedId();
    const command = String(new FormData(event.target as HTMLFormElement).get('command') || '').trim();
    if (!id || !command) {
      return;
    }

    this.running.set(true);
    try {
      const result = await this.redis.command(id, command);
      this.output.set(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    } catch (error) {
      const err = error as { status?: number; message?: string };
      if (err.status === 409) {
        if (confirm(`${err.message}\nRun it anyway?`)) {
          try {
            const result = await this.redis.command(id, command, true);
            this.output.set(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
            this.running.set(false);
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
