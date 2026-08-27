import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { extractApiError } from '../services/api-error';
import { MongoDocDetail } from '../services/api.types';
import { ConnectionsService } from '../services/connections.service';
import { MongoService } from '../services/mongo.service';

@Component({
  selector: 'app-doc-page',
  imports: [RouterLink],
  templateUrl: './doc-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DocPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mongo = inject(MongoService);
  private readonly connections = inject(ConnectionsService);

  private readonly query = toSignal(this.route.queryParamMap.pipe(map((q) => q)), {
    initialValue: this.route.snapshot.queryParamMap,
  });

  readonly db = computed(() => this.query().get('db') || '');
  readonly collection = computed(() => this.query().get('c') || '');
  readonly id = computed(() => this.query().get('id') || '');
  readonly detail = signal<MongoDocDetail | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly busy = signal(false);

  constructor() {
    void this.reload();
  }

  pretty(): string {
    return JSON.stringify(this.detail()?.document ?? {}, null, 2);
  }

  async reload(): Promise<void> {
    const connectionId = this.connections.selectedId();
    if (!connectionId || !this.db() || !this.collection() || !this.id()) {
      return;
    }
    try {
      this.detail.set(await this.mongo.inspect(connectionId, this.db(), this.collection(), this.id()));
      this.errorMessage.set(null);
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Failed to load document').message);
    }
  }

  async save(event: Event): Promise<void> {
    event.preventDefault();
    const connectionId = this.connections.selectedId();
    if (!connectionId) {
      return;
    }
    let document: unknown;
    try {
      document = JSON.parse(String(new FormData(event.target as HTMLFormElement).get('document') || '{}'));
    } catch {
      this.errorMessage.set('Invalid JSON');
      return;
    }
    this.busy.set(true);
    try {
      this.detail.set(await this.mongo.save(connectionId, this.db(), this.collection(), this.id(), document));
      this.errorMessage.set(null);
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Save failed').message);
    } finally {
      this.busy.set(false);
    }
  }

  async remove(): Promise<void> {
    const connectionId = this.connections.selectedId();
    if (!connectionId || !confirm(`Delete ${this.id()}?`)) {
      return;
    }
    try {
      await this.mongo.remove(connectionId, this.db(), this.collection(), this.id());
      await this.router.navigateByUrl('/browse');
    } catch (error) {
      this.errorMessage.set(extractApiError(error, 'Delete failed').message);
    }
  }
}
