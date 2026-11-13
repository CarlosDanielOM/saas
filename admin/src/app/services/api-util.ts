import { HttpErrorResponse, HttpParams } from '@angular/common/http';

/** The API's response wrapper. Services return it as-is; pages read `.data`. */
export interface Envelope<T> {
  error: boolean;
  message: string;
  status?: number;
  data: T;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Query params from an object, leaving out empty values (undefined, null, '', empty arrays). */
export function httpParams(query: object): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) params = params.set(key, value.join(','));
      continue;
    }
    params = params.set(key, String(value));
  }
  return params;
}

/** The API's own message when it sent one, otherwise the fallback. Never a raw HTTP error string. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const message = (error.error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.length > 0 && message.length < 200 && error.status >= 400 && error.status < 500) return message;
  }
  return fallback;
}
