import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { extractApiError } from '../services/api-error';
import { RedisKeyType, RedisTreeResult } from '../services/api.types';
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
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly redis = inject(RedisService);
  private readonly router = inject(Router);
  readonly connections = inject(ConnectionsService);

  readonly query = signal('');
  readonly branches = signal<Record<string, RedisTreeResult>>({});
  readonly expanded = signal<Record<string, boolean>>({});
  readonly loading = signal(false);
  readonly pending = signal<Record<string, boolean>>({});
  readonly errorMessage = signal<string | null>(null);
  readonly createType = signal<RedisKeyType>('string');
  readonly creating = signal(false);

  private debounce: ReturnType<typeof setTimeout> | null = null;
  private tickets = new Map<string, number>();
  private observer: IntersectionObserver | null = null;

  constructor() {
    effect(() => {
      const id = this.connections.selectedId();
      if (id) {
        this.branches.set({});
        this.expanded.set({});
        this.tickets.clear();
        void this.load('');
      }
    });
  }

  onCreateType(event: Event): void {
    this.createType.set((event.target as HTMLSelectElement).value as RedisKeyType);
  }

  async create(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.connections.selectedId();
    if (!id) {
      return;
    }
    const form = new FormData(event.target as HTMLFormElement);
    const key = String(form.get('key') || '').trim();
    if (!key) {
      this.errorMessage.set('key is required');
      return;
    }
    this.creating.set(true);
    try {
      const created = await this.redis.create(id, {
        key,
        type: this.createType(),
        value: String(form.get('value') || ''),
        field: String(form.get('field') || ''),
        score: Number(form.get('score')) || 0,
      });
      this.errorMessage.set(null);
      await this.router.navigate(['/key'], { queryParams: { k: created.key } });
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Create failed').message);
    } finally {
      this.creating.set(false);
    }
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
      this.tickets.clear();
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

  leafLabel(name: string, prefix: string): string {
    return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  }

  watchMore(prefix: string, node: HTMLElement): void {
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void this.more(prefix);
      }
    }, { rootMargin: '160px' });
    this.observer.observe(node);
  }

  async more(prefix: string): Promise<void> {
    const current = this.branches()[prefix];
    if (!current || current.cursor === '0' || this.pending()[prefix]) {
      return;
    }
    await this.load(prefix, current.cursor, true);
  }

  private async load(prefix: string, cursor = '0', append = false): Promise<void> {
    const id = this.connections.selectedId();
    if (!id) {
      this.branches.set({});
      return;
    }

    const ticket = (this.tickets.get(prefix) || 0) + 1;
    this.tickets.set(prefix, ticket);
    this.pending.update((current) => ({ ...current, [prefix]: true }));
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const result = await this.redis.tree(id, prefix, this.query(), cursor);
      if (this.tickets.get(prefix) !== ticket) {
        return;
      }
      const current = this.branches();
      const merged = append && current[prefix]
        ? {
            ...result,
            folders: mergeFolders(current[prefix].folders, result.folders),
            keys: uniqueKeys([...current[prefix].keys, ...result.keys]),
          }
        : result;
      this.branches.set({ ...current, [prefix]: merged });
      if (merged.cursor !== '0') {
        setTimeout(() => this.bindSentinel(prefix), 0);
      }
    } catch (error) {
      if (this.tickets.get(prefix) !== ticket) {
        return;
      }
      this.errorMessage.set(extractApiError(error, 'Scan failed').message);
    } finally {
      if (this.tickets.get(prefix) === ticket) {
        this.pending.update((current) => ({ ...current, [prefix]: false }));
        this.loading.set(!Object.values(this.pending()).some(Boolean));
      }
    }
  }

  private bindSentinel(prefix: string): void {
    const node = this.host.nativeElement.querySelector(`[data-more="${cssEscape(prefix)}"]`);
    if (node instanceof HTMLElement) {
      this.watchMore(prefix, node);
    }
  }
}

function mergeFolders(
  current: RedisTreeResult['folders'],
  incoming: RedisTreeResult['folders'],
): RedisTreeResult['folders'] {
  const map = new Map(current.map((folder) => [folder.prefix, folder]));
  for (const folder of incoming) {
    const existing = map.get(folder.prefix);
    map.set(folder.prefix, existing
      ? { ...existing, seen: existing.seen + folder.seen }
      : folder);
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
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

function cssEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
