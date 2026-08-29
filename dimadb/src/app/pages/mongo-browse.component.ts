import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { extractApiError } from '../services/api-error';
import { MongoCollectionRow, MongoDatabaseRow, MongoDocRow } from '../services/api.types';
import { ConnectionsService } from '../services/connections.service';
import { MongoService } from '../services/mongo.service';

@Component({
  selector: 'app-mongo-browse',
  imports: [RouterLink],
  templateUrl: './mongo-browse.component.html',
  styleUrl: './mongo-browse.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MongoBrowseComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mongo = inject(MongoService);
  readonly connections = inject(ConnectionsService);

  private readonly query = toSignal(this.route.queryParamMap.pipe(map((q) => q)), {
    initialValue: this.route.snapshot.queryParamMap,
  });

  readonly db = computed(() => this.query().get('db') || '');
  readonly collection = computed(() => this.query().get('c') || '');
  readonly view = computed<'databases' | 'collections' | 'documents'>(() => {
    if (this.db() && this.collection()) {
      return 'documents';
    }
    if (this.db()) {
      return 'collections';
    }
    return 'databases';
  });

  readonly databases = signal<MongoDatabaseRow[]>([]);
  readonly collections = signal<MongoCollectionRow[]>([]);
  readonly docs = signal<MongoDocRow[]>([]);
  readonly total = signal(0);
  readonly filter = signal('{}');
  readonly loading = signal(false);
  readonly creating = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly rootParams = {};
  readonly dbParams = computed(() => ({ db: this.db() }));

  constructor() {
    effect(() => {
      const id = this.connections.selectedId();
      const view = this.view();
      this.db();
      this.collection();
      if (!id) {
        return;
      }
      if (view === 'databases') {
        void this.loadDatabases();
      } else if (view === 'collections') {
        void this.loadCollections();
      } else {
        this.docs.set([]);
        this.total.set(0);
        void this.loadDocs(false);
      }
    });
  }

  openDb(name: string): void {
    void this.router.navigate(['/browse'], { queryParams: { db: name } });
  }

  openCollection(name: string): void {
    void this.router.navigate(['/browse'], { queryParams: { db: this.db(), c: name } });
  }

  onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value || '{}');
  }

  applyFilter(): void {
    this.docs.set([]);
    void this.loadDocs(false);
  }

  loadMore(): void {
    void this.loadDocs(true);
  }

  docParams(id: string): { db: string; c: string; id: string } {
    return { db: this.db(), c: this.collection(), id };
  }

  pretty(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  size(bytes?: number): string {
    if (!bytes) {
      return '';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async insert(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.connections.selectedId();
    if (!id) {
      return;
    }
    const raw = String(new FormData(event.target as HTMLFormElement).get('document') || '{}');
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      this.errorMessage.set('Invalid JSON');
      return;
    }
    this.creating.set(true);
    try {
      const created = await this.mongo.insert(id, this.db(), this.collection(), document);
      this.errorMessage.set(null);
      await this.router.navigate(['/doc'], {
        queryParams: { db: created.db, c: created.collection, id: created.id },
      });
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Insert failed').message);
    } finally {
      this.creating.set(false);
    }
  }

  private async loadDatabases(): Promise<void> {
    const id = this.connections.selectedId();
    if (!id) {
      return;
    }
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      this.databases.set(await this.mongo.databases(id));
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Failed to list databases').message);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadCollections(): Promise<void> {
    const id = this.connections.selectedId();
    if (!id) {
      return;
    }
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      this.collections.set(await this.mongo.collections(id, this.db()));
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Failed to list collections').message);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadDocs(append: boolean): Promise<void> {
    const id = this.connections.selectedId();
    if (!id) {
      return;
    }
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const skip = append ? this.docs().length : 0;
      const result = await this.mongo.docs(id, this.db(), this.collection(), skip, this.filter() || '{}');
      this.total.set(result.total);
      this.docs.set(append ? uniqueDocs([...this.docs(), ...result.docs]) : result.docs);
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Failed to list documents').message);
    } finally {
      this.loading.set(false);
    }
  }
}

function uniqueDocs(docs: MongoDocRow[]): MongoDocRow[] {
  const seen = new Set<string>();
  return docs.filter((doc) => {
    if (seen.has(doc.id)) {
      return false;
    }
    seen.add(doc.id);
    return true;
  });
}
