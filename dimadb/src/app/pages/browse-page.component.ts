import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { extractApiError } from '../services/api-error';
import { MongoDocRow, RedisKeyType, RedisTreeResult } from '../services/api.types';
import { ConnectionsService } from '../services/connections.service';
import { MongoService } from '../services/mongo.service';
import { RedisService } from '../services/redis.service';

interface MongoBrowseNode {
  folders: { prefix: string; label: string }[];
  docs: MongoDocRow[];
  skip: number;
  total: number;
  more: boolean;
}

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
  private readonly mongo = inject(MongoService);
  private readonly router = inject(Router);
  readonly connections = inject(ConnectionsService);

  readonly query = signal('');
  readonly branches = signal<Record<string, RedisTreeResult>>({});
  readonly mongoNodes = signal<Record<string, MongoBrowseNode>>({});
  readonly expanded = signal<Record<string, boolean>>({});
  readonly loading = signal(false);
  readonly pending = signal<Record<string, boolean>>({});
  readonly errorMessage = signal<string | null>(null);
  readonly createType = signal<RedisKeyType>('string');
  readonly creating = signal(false);
  readonly searchPlaceholder = computed(() =>
    this.connections.engine() === 'mongo' ? 'json filter or name' : 'twitch',
  );

  private debounce: ReturnType<typeof setTimeout> | null = null;
  private tickets = new Map<string, number>();
  private observer: IntersectionObserver | null = null;

  constructor() {
    effect(() => {
      const id = this.connections.selectedId();
      this.connections.engine();
      this.branches.set({});
      this.mongoNodes.set({});
      this.expanded.set({});
      this.tickets.clear();
      if (id) {
        void this.loadCurrent('');
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
    this.creating.set(true);
    try {
      if (this.connections.engine() === 'mongo') {
        const db = String(form.get('db') || '').trim();
        const collection = String(form.get('collection') || '').trim();
        const created = await this.mongo.insert(id, db, collection, parseJson(String(form.get('document') || '{}')));
        this.errorMessage.set(null);
        await this.router.navigate(['/doc'], {
          queryParams: { db: created.db, c: created.collection, id: created.id },
        });
        return;
      }
      const key = String(form.get('key') || '').trim();
      if (!key) {
        this.errorMessage.set('key is required');
        return;
      }
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
      this.mongoNodes.set({});
      this.expanded.set({});
      this.tickets.clear();
      void this.loadCurrent('');
    }, 220);
  }

  async toggle(prefix: string): Promise<void> {
    const next = { ...this.expanded() };
    next[prefix] = !next[prefix];
    this.expanded.set(next);
    if (next[prefix] && !this.hasNode(prefix)) {
      await this.loadCurrent(prefix);
    }
  }

  branch(prefix: string): RedisTreeResult | null {
    return this.branches()[prefix] ?? null;
  }

  mongoBranch(prefix: string): MongoBrowseNode | null {
    return this.mongoNodes()[prefix] ?? null;
  }

  mongoDocParams(prefix: string, id: string): { db: string; c: string; id: string } {
    const parsed = parseMongoPrefix(prefix);
    if (parsed.kind !== 'collection') {
      return { db: '', c: '', id };
    }
    return { db: parsed.db, c: parsed.collection, id };
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
    if (this.connections.engine() === 'mongo') {
      const current = this.mongoNodes()[prefix];
      if (!current || !current.more || this.pending()[prefix]) {
        return;
      }
      await this.loadMongo(prefix, current.skip + current.docs.length, true);
      return;
    }
    const current = this.branches()[prefix];
    if (!current || current.cursor === '0' || this.pending()[prefix]) {
      return;
    }
    await this.loadRedis(prefix, current.cursor, true);
  }

  private hasNode(prefix: string): boolean {
    return this.connections.engine() === 'mongo'
      ? Boolean(this.mongoNodes()[prefix])
      : Boolean(this.branches()[prefix]);
  }

  private loadCurrent(prefix: string): Promise<void> {
    return this.connections.engine() === 'mongo'
      ? this.loadMongo(prefix)
      : this.loadRedis(prefix);
  }

  private async loadRedis(prefix: string, cursor = '0', append = false): Promise<void> {
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
      this.finish(prefix, ticket);
    }
  }

  private async loadMongo(prefix: string, skip = 0, append = false): Promise<void> {
    const id = this.connections.selectedId();
    if (!id) {
      this.mongoNodes.set({});
      return;
    }

    const ticket = (this.tickets.get(prefix) || 0) + 1;
    this.tickets.set(prefix, ticket);
    this.pending.update((current) => ({ ...current, [prefix]: true }));
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const node = await this.fetchMongo(id, prefix, skip);
      if (this.tickets.get(prefix) !== ticket) {
        return;
      }
      const current = this.mongoNodes();
      const merged = append && current[prefix]
        ? {
            ...node,
            docs: uniqueMongoDocs([...current[prefix].docs, ...node.docs]),
            skip: current[prefix].skip,
          }
        : node;
      this.mongoNodes.set({ ...current, [prefix]: merged });
      if (merged.more) {
        setTimeout(() => this.bindSentinel(prefix), 0);
      }
    } catch (error) {
      if (this.tickets.get(prefix) !== ticket) {
        return;
      }
      this.errorMessage.set(extractApiError(error, 'Mongo scan failed').message);
    } finally {
      this.finish(prefix, ticket);
    }
  }

  private async fetchMongo(id: string, prefix: string, skip: number): Promise<MongoBrowseNode> {
    const parsed = parseMongoPrefix(prefix);
    const q = this.query().trim().toLowerCase();
    if (parsed.kind === 'root') {
      const databases = await this.mongo.databases(id);
      return {
        folders: databases
          .filter((item) => !q || item.name.toLowerCase().includes(q))
          .map((item) => ({ prefix: `db:${item.name}`, label: item.name })),
        docs: [],
        skip: 0,
        total: 0,
        more: false,
      };
    }
    if (parsed.kind === 'db') {
      const collections = await this.mongo.collections(id, parsed.db);
      return {
        folders: collections
          .filter((item) => !q || item.name.toLowerCase().includes(q))
          .map((item) => ({ prefix: `db:${parsed.db}/c:${item.name}`, label: item.name })),
        docs: [],
        skip: 0,
        total: 0,
        more: false,
      };
    }
    const filter = looksLikeJson(this.query()) ? this.query().trim() : '{}';
    const result = await this.mongo.docs(id, parsed.db, parsed.collection, skip, filter);
    return {
      folders: [],
      docs: result.docs,
      skip: result.skip,
      total: result.total,
      more: result.skip + result.docs.length < result.total,
    };
  }

  private finish(prefix: string, ticket: number): void {
    if (this.tickets.get(prefix) === ticket) {
      this.pending.update((current) => ({ ...current, [prefix]: false }));
      this.loading.set(!Object.values(this.pending()).some(Boolean));
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

function uniqueMongoDocs(docs: MongoDocRow[]): MongoDocRow[] {
  const seen = new Set<string>();
  return docs.filter((doc) => {
    if (seen.has(doc.id)) {
      return false;
    }
    seen.add(doc.id);
    return true;
  });
}

function parseMongoPrefix(prefix: string):
  | { kind: 'root' }
  | { kind: 'db'; db: string }
  | { kind: 'collection'; db: string; collection: string } {
  if (!prefix) {
    return { kind: 'root' };
  }
  const collection = prefix.match(/^db:([^/]+)\/c:(.+)$/);
  if (collection) {
    return { kind: 'collection', db: collection[1], collection: collection[2] };
  }
  if (prefix.startsWith('db:')) {
    return { kind: 'db', db: prefix.slice(3) };
  }
  return { kind: 'root' };
}

function looksLikeJson(value: string): boolean {
  const text = value.trim();
  return text.startsWith('{') && text.endsWith('}');
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function cssEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
