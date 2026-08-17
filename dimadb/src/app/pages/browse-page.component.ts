import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { extractApiError } from '../services/api-error';
import { RedisTreeResult } from '../services/api.types';
import { ConnectionsService } from '../services/connections.service';
import { RedisService } from '../services/redis.service';

@Component({
  selector: 'app-browse-page',
  imports: [NgTemplateOutlet, RouterLink],
  templateUrl: './browse-page.component.html',
  styleUrl: './browse-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowsePageComponent {
  private readonly redis = inject(RedisService);
  readonly connections = inject(ConnectionsService);

  readonly query = signal('');
  readonly branches = signal<Record<string, RedisTreeResult>>({});
  readonly expanded = signal<Record<string, boolean>>({});
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);

  private debounce: ReturnType<typeof setTimeout> | null = null;
  private request = 0;

  constructor() {
    effect(() => {
      const id = this.connections.selectedId();
      if (id) {
        this.branches.set({});
        this.expanded.set({});
        void this.load('');
      }
    });
  }

  onSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      this.branches.set({});
      this.expanded.set({});
      void this.load('');
    }, 220);
  }

  async toggle(prefix: string): Promise<void> {
    const next = { ...this.expanded() };
    next[prefix] = !next[prefix];
    this.expanded.set(next);
    if (next[prefix] && !this.branches()[prefix]) {
      await this.load(prefix);
    }
  }

  branch(prefix: string): RedisTreeResult | null {
    return this.branches()[prefix] ?? null;
  }

  async more(prefix: string): Promise<void> {
    const current = this.branches()[prefix];
    if (!current || current.cursor === '0') {
      return;
    }
    await this.load(prefix, current.cursor, true);
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

  private async load(prefix: string, cursor = '0', append = false): Promise<void> {
    const id = this.connections.selectedId();
    if (!id) {
      this.branches.set({});
      return;
    }

    const ticket = ++this.request;
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const result = await this.redis.tree(id, prefix, this.query(), cursor);
      if (ticket !== this.request) {
        return;
      }
      const current = this.branches();
      if (append && current[prefix]) {
        const mergedFolders = [...current[prefix].folders];
        for (const folder of result.folders) {
          if (!mergedFolders.some((item) => item.prefix === folder.prefix)) {
            mergedFolders.push(folder);
          }
        }
        this.branches.set({
          ...current,
          [prefix]: {
            ...result,
            folders: mergedFolders,
            keys: uniqueKeys([...current[prefix].keys, ...result.keys]),
          },
        });
        return;
      }
      this.branches.set({ ...current, [prefix]: result });
    } catch (error) {
      if (ticket !== this.request) {
        return;
      }
      this.errorMessage.set(extractApiError(error, 'Scan failed').message);
    } finally {
      if (ticket === this.request) {
        this.loading.set(false);
      }
    }
  }
}

function uniqueKeys(keys: RedisTreeResult['keys']): RedisTreeResult['keys'] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    if (seen.has(key.name)) {
      return false;
    }
    seen.add(key.name);
    return true;
  });
}
