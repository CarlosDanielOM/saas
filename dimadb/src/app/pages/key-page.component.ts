import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { extractApiError } from '../services/api-error';
import { RedisKeyDetail, RedisMutateOp, RedisMutateRequest } from '../services/api.types';
import { ConnectionsService } from '../services/connections.service';
import { RedisService } from '../services/redis.service';

@Component({
  selector: 'app-key-page',
  imports: [RouterLink],
  templateUrl: './key-page.component.html',
  styleUrl: './key-page.component.css',
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
  readonly busy = signal(false);

  readonly hashEntries = computed(() => {
    const value = this.detail()?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [];
    }
    return Object.entries(value as Record<string, unknown>).map(([field, item]) => ({
      field,
      value: String(item ?? ''),
    }));
  });

  readonly listItems = computed(() => {
    const value = this.detail()?.value;
    return Array.isArray(value) && this.type() === 'list'
      ? value.map((item) => String(item ?? ''))
      : [];
  });

  readonly setMembers = computed(() => {
    const value = this.detail()?.value;
    return Array.isArray(value) && this.type() === 'set'
      ? value.map((item) => String(item ?? ''))
      : [];
  });

  readonly zsetEntries = computed(() => {
    const value = this.detail()?.value;
    if (!Array.isArray(value) || this.type() !== 'zset') {
      return [];
    }
    return value.map((row) => {
      if (row && typeof row === 'object' && 'value' in row) {
        const item = row as { value?: unknown; score?: unknown };
        return { member: String(item.value ?? ''), score: Number(item.score) || 0 };
      }
      return { member: String(row), score: 0 };
    });
  });

  constructor() {
    void this.reload();
  }

  pretty(): string {
    const value = this.detail()?.value;
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }

  ttlLabel(): string {
    const ttl = this.detail()?.ttl;
    if (ttl == null) {
      return '—';
    }
    if (ttl < 0) {
      return 'none';
    }
    return String(ttl);
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

  async saveString(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.connections.selectedId();
    if (!id || this.type() !== 'string') {
      return;
    }
    const value = String(new FormData(event.target as HTMLFormElement).get('value') || '');
    this.busy.set(true);
    try {
      this.detail.set(await this.redis.saveString(id, this.key(), value));
      this.errorMessage.set(null);
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Save failed').message);
    } finally {
      this.busy.set(false);
    }
  }

  async saveTtl(event: Event): Promise<void> {
    event.preventDefault();
    const raw = String(new FormData(event.target as HTMLFormElement).get('ttl') || '').trim();
    const ttl = Number(raw);
    if (!Number.isInteger(ttl) || ttl < 1) {
      this.errorMessage.set('TTL must be a positive number of seconds');
      return;
    }
    await this.apply('ttl', { ttl });
  }

  persist(): Promise<void> {
    return this.apply('ttl', { ttl: -1 });
  }

  async saveHash(event: Event, currentField: string): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const field = String(form.get('field') || '').trim();
    if (!field) {
      this.errorMessage.set('field is required');
      return;
    }
    await this.apply('hset', {
      field,
      value: String(form.get('value') || ''),
      renameFrom: currentField,
    });
  }

  addHash(event: Event): Promise<void> {
    return this.saveHash(event, '');
  }

  deleteHash(field: string): Promise<void> {
    if (!confirm(`Delete field ${field}?`)) {
      return Promise.resolve();
    }
    return this.apply('hdel', { field });
  }

  async saveList(event: Event, index: number): Promise<void> {
    event.preventDefault();
    const value = String(new FormData(event.target as HTMLFormElement).get('value') || '');
    await this.apply('lset', { index, value });
  }

  async pushList(form: HTMLFormElement, op: 'lpush' | 'rpush'): Promise<void> {
    const value = String(new FormData(form).get('value') || '');
    await this.apply(op, { value });
    form.reset();
  }

  deleteList(index: number): Promise<void> {
    if (!confirm(`Delete index ${index}?`)) {
      return Promise.resolve();
    }
    return this.apply('ldel', { index });
  }

  async addSet(event: Event): Promise<void> {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const member = String(new FormData(form).get('member') || '');
    if (!member) {
      this.errorMessage.set('member is required');
      return;
    }
    await this.apply('sadd', { member });
    form.reset();
  }

  deleteSet(member: string): Promise<void> {
    if (!confirm(`Remove ${member}?`)) {
      return Promise.resolve();
    }
    return this.apply('srem', { member });
  }

  async saveZset(event: Event, currentMember: string): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const member = String(form.get('member') || '').trim();
    if (!member) {
      this.errorMessage.set('member is required');
      return;
    }
    await this.apply('zadd', { member, score: Number(form.get('score')) || 0 });
    if (currentMember && currentMember !== member) {
      await this.apply('zrem', { member: currentMember });
    }
  }

  addZset(event: Event): Promise<void> {
    return this.saveZset(event, '');
  }

  deleteZset(member: string): Promise<void> {
    if (!confirm(`Remove ${member}?`)) {
      return Promise.resolve();
    }
    return this.apply('zrem', { member });
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

  private async apply(op: RedisMutateOp, extra: Omit<RedisMutateRequest, 'key' | 'op'>): Promise<void> {
    const id = this.connections.selectedId();
    if (!id) {
      return;
    }
    this.busy.set(true);
    try {
      const next = await this.redis.mutate(id, { key: this.key(), op, ...extra });
      if (next.type === 'none') {
        await this.router.navigateByUrl('/browse');
        return;
      }
      this.detail.set(next);
      this.errorMessage.set(null);
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Edit failed').message);
    } finally {
      this.busy.set(false);
    }
  }
}
