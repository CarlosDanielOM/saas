import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { extractApiError } from '../services/api-error';
import { RedisKeyDetail } from '../services/api.types';
import { ConnectionsService } from '../services/connections.service';
import { RedisService } from '../services/redis.service';

@Component({
  selector: 'app-key-page',
  imports: [RouterLink],
  templateUrl: './key-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly redis = inject(RedisService);
  private readonly connections = inject(ConnectionsService);

  private readonly query = toSignal(this.route.queryParamMap.pipe(map((q) => q)), {
    initialValue: this.route.snapshot.queryParamMap,
  });

  readonly key = computed(() => this.query().get('k') || '');
  readonly type = computed(() => this.detail()?.type || this.query().get('t') || 'string');
  readonly detail = signal<RedisKeyDetail | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly saving = signal(false);

  constructor() {
    void this.reload();
  }

  pretty(): string {
    const value = this.detail()?.value;
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }

  async reload(): Promise<void> {
    const id = this.connections.selectedId();
    const key = this.key();
    if (!id || !key) {
      return;
    }
    try {
      this.detail.set(await this.redis.inspect(id, key));
      this.errorMessage.set(null);
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Failed to load key').message);
    }
  }

  async save(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.connections.selectedId();
    if (!id || this.type() !== 'string') {
      return;
    }
    const value = String(new FormData(event.target as HTMLFormElement).get('value') || '');
    this.saving.set(true);
    try {
      this.detail.set(await this.redis.saveString(id, this.key(), value));
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Save failed').message);
    } finally {
      this.saving.set(false);
    }
  }

  async remove(): Promise<void> {
    const id = this.connections.selectedId();
    if (!id || !confirm(`Delete ${this.key()}?`)) {
      return;
    }
    try {
      await this.redis.remove(id, this.key());
      await this.router.navigateByUrl('/browse');
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Delete failed').message);
    }
  }
}
