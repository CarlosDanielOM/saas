import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  ApiEnvelope,
  MongoCollectionRow,
  MongoDatabaseRow,
  MongoDocDetail,
  MongoDocsResult,
} from './api.types';

@Injectable({ providedIn: 'root' })
export class MongoService {
  private readonly http = inject(HttpClient);

  databases(connectionId: string): Promise<MongoDatabaseRow[]> {
    return this.unwrap(
      this.http.get<ApiEnvelope<MongoDatabaseRow[]>>(`/api/mongo/${connectionId}/dbs`),
      'Failed to list databases',
    );
  }

  collections(connectionId: string, db: string): Promise<MongoCollectionRow[]> {
    return this.unwrap(
      this.http.get<ApiEnvelope<MongoCollectionRow[]>>(`/api/mongo/${connectionId}/collections`, {
        params: { db },
      }),
      'Failed to list collections',
    );
  }

  docs(
    connectionId: string,
    db: string,
    collection: string,
    skip = 0,
    filter = '{}',
  ): Promise<MongoDocsResult> {
    return this.unwrap(
      this.http.get<ApiEnvelope<MongoDocsResult>>(`/api/mongo/${connectionId}/docs`, {
        params: { db, collection, skip, limit: 50, filter },
      }),
      'Failed to list documents',
    );
  }

  inspect(connectionId: string, db: string, collection: string, id: string): Promise<MongoDocDetail> {
    return this.unwrap(
      this.http.get<ApiEnvelope<MongoDocDetail>>(`/api/mongo/${connectionId}/doc`, {
        params: { db, collection, id },
      }),
      'Failed to load document',
    );
  }

  save(
    connectionId: string,
    db: string,
    collection: string,
    docId: string,
    document: unknown,
  ): Promise<MongoDocDetail> {
    return this.unwrap(
      this.http.put<ApiEnvelope<MongoDocDetail>>(`/api/mongo/${connectionId}/doc`, {
        db,
        collection,
        docId,
        document,
      }),
      'Save failed',
    );
  }

  insert(connectionId: string, db: string, collection: string, document: unknown): Promise<MongoDocDetail> {
    return this.unwrap(
      this.http.post<ApiEnvelope<MongoDocDetail>>(`/api/mongo/${connectionId}/doc`, {
        db,
        collection,
        document,
      }),
      'Insert failed',
    );
  }

  remove(connectionId: string, db: string, collection: string, id: string): Promise<{ deleted: number }> {
    return this.unwrap(
      this.http.delete<ApiEnvelope<{ deleted: number }>>(`/api/mongo/${connectionId}/doc`, {
        params: { db, collection, id },
      }),
      'Delete failed',
    );
  }

  private async unwrap<T>(source: Parameters<typeof firstValueFrom>[0], fallback: string): Promise<T> {
    const response = await firstValueFrom(source) as ApiEnvelope<T>;
    if (response.error || response.data === undefined) {
      throw Object.assign(new Error(response.message || fallback), { status: response.status });
    }
    return response.data;
  }
}
