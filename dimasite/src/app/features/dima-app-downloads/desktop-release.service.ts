import { HttpBackend, HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, timeout } from 'rxjs';
import { DESKTOP_DOWNLOAD_BASE_URL, DesktopRelease, ReleaseChannel, parseDesktopRelease } from './desktop-release.model';

export type DownloadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly release: DesktopRelease }
  | { readonly status: 'unavailable' | 'invalid' | 'error' };

@Injectable({ providedIn: 'root' })
export class DesktopReleaseService {
  // Public downloads must never inherit API authorization headers or session interceptors.
  private readonly http = new HttpClient(inject(HttpBackend));

  load(channel: ReleaseChannel): Observable<DownloadState> {
    const pointer = channel === 'stable' ? 'latest.json' : 'latest-beta.json';
    return this.http.get<unknown>(`${DESKTOP_DOWNLOAD_BASE_URL}/${pointer}`, {
      transferCache: false
    }).pipe(
      timeout(12_000),
      map((value): DownloadState => {
        try { return { status: 'ready', release: parseDesktopRelease(value, channel) }; }
        catch { return { status: 'invalid' }; }
      }),
      catchError((error: unknown): Observable<DownloadState> => {
        const status = error instanceof HttpErrorResponse ? error.status : 0;
        return of({ status: status === 403 || status === 404 ? 'unavailable' : status === 200 ? 'invalid' : 'error' });
      })
    );
  }
}
