import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import { Envelope } from './api-util';

/**
 * Which versions of the OBS overlay pages and the Overlay Studio editor are in use, and which "compatibility code"
 * the API keeps for older ones. A piece of that code can go once no page that needs it has been seen for
 * `quietDays` (14). Nothing is ever removed automatically: the owner asks an agent to remove it.
 *
 * Backend: `dimabot/src/overlays/client-versions.ts` (mirror of these types) and the code list in
 * `dimabot/src/overlays/compat.ts`; route `dimabot/src/server/routes/admin_site/client_versions.route.ts`.
 */

/** `overlay` = OBS overlay pages, `studio` = Overlay Studio editor tabs. */
export type ClientKind = 'overlay' | 'studio';

/**
 * - needed: a page that needs it was seen in the last `quietDays`.
 * - removable: no page that needs it has been seen for `quietDays`.
 * - collecting: versions have been tracked for less than `quietDays`, so it is too early to tell.
 */
export type CompatState = 'needed' | 'removable' | 'collecting';

export interface CompatEntry {
  /** Stable id, e.g. `overlay-legacy-sound`. */
  id: string;
  client: ClientKind;
  /** Pages with a lower protocol (overlay) or writer (studio) number need this code. */
  before: number;
  /** What the code does, in plain words (from the server). */
  summary: string;
  /** Where the code lives, for the agent that removes it. */
  code: string[];
  state: CompatState;
  /** Last time a page that needs it was seen (ISO); null when none was seen since tracking began. */
  olderLastSeenAt: string | null;
  /** The earliest it can become removable (ISO): tracking start or the last old page, plus `quietDays`. */
  removableFrom: string | null;
}

export interface ClientVersionRow {
  client: ClientKind;
  /** 0 for pages from before versions were reported. */
  protocol: number;
  /** `main-<hash>` (site bundle), `dev`, `unknown`, or `before-protocol` (protocol 0). */
  build: string;
  /** ISO times. */
  firstSeenAt: string;
  lastSeenAt: string;
  /** Overlay pages connected to the answering API server right now; null for Studio tabs. */
  connectedNow: number | null;
  /** Older than the current protocol. */
  outdated: boolean;
}

export interface ClientVersionReport {
  checkedAt: string;
  /** Days without an old page before its code can go (14). */
  quietDays: number;
  /** Current protocol per client: overlay 1, studio (editor "writer") 2. */
  current: Record<ClientKind, number>;
  /** First time any version of that client was recorded (ISO); missing until one is. */
  trackingSince: Partial<Record<ClientKind, string>>;
  entries: CompatEntry[];
  /** Newest first (by last seen), at most 200. */
  versions: ClientVersionRow[];
}

@Injectable({ providedIn: 'root' })
export class ClientVersionsApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);

  /** `GET /admin-site/client-versions` (owner only). Read-only: nothing is removed from here. */
  report(): Observable<Envelope<ClientVersionReport>> {
    return this.http.get<Envelope<ClientVersionReport>>(`${this.links.getApiUrl()}/admin-site/client-versions`);
  }
}
