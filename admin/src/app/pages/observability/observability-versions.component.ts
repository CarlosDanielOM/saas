import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';

import {
  ClientVersionsApiService,
  type ClientKind,
  type ClientVersionReport,
  type CompatEntry,
  type CompatState,
} from '../../services/client-versions-api.service';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { clockTime, dateTime, formatNumber, plural, relativeTime } from '../../shared/format';

/** How many version rows the list shows (newest first). */
const VERSIONS_SHOWN = 50;
/** The API returns at most this many version rows. */
const VERSIONS_CAP = 200;
/** A tap on Copy is ignored for this long after the last one. */
const COPY_GUARD_MS = 800;

const CLIENT_LABEL: Record<ClientKind, string> = { overlay: 'OBS overlay', studio: 'Studio editor' };
/** Who needs a piece of code, plural (rows) and singular (the request for an agent). */
const PAGES: Record<ClientKind, { many: string; one: string }> = {
  overlay: { many: 'OBS overlay pages', one: 'OBS overlay page' },
  studio: { many: 'Studio editor tabs', one: 'Studio editor tab' },
};
const STATE: Record<CompatState, { chip: string; tone: 'ok' | 'muted' | 'accent'; order: number }> = {
  removable: { chip: 'Can be removed', tone: 'ok', order: 0 },
  needed: { chip: 'Still needed', tone: 'muted', order: 1 },
  collecting: { chip: 'Collecting data', tone: 'accent', order: 2 },
};
/** Unknown values from a newer API read as the most cautious ones: still needed, OBS overlay pages. */
const stateOf = (state: CompatState) => STATE[state] ?? STATE.needed;
const pagesOf = (client: ClientKind) => PAGES[client] ?? PAGES.overlay;
const BUILD_LABEL: Record<string, string> = {
  'before-protocol': 'From before versions',
  unknown: 'Unknown build',
  dev: 'Development build',
};
/** A plain label for the special builds; null for a real build id. */
const buildLabel = (build: string): string | null => (Object.prototype.hasOwnProperty.call(BUILD_LABEL, build) ? BUILD_LABEL[build] : null);

interface EntryView {
  id: string;
  state: CompatState;
  chip: string;
  tone: 'ok' | 'muted' | 'accent';
  /** The server's summary, split on `backticks` so code reads as code. */
  summary: Array<{ text: string; code: boolean }>;
  who: string;
  lastSeen: string;
  lastSeenTitle: string | null;
  when: string | null;
  code: string[];
  /** Ready-to-paste removal request; only for code that can be removed. */
  request: string | null;
}

interface VersionView {
  key: string;
  client: ClientKind;
  page: string;
  version: string;
  tag: 'current' | 'older' | 'newer';
  build: string;
  /** The build is a raw id (shown in monospace), not a plain label. */
  buildRaw: boolean;
  connected: string;
  first: string;
  firstTitle: string;
  last: string;
  lastTitle: string;
}

/** "Nov 30" (with the year when it is not this year) or "today", in the viewer's time zone. */
function onDay(value: string, now: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return 'today';
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** The text the owner pastes to an agent to remove one piece of compatibility code. */
export function removalRequest(entry: CompatEntry, quietDays: number, now: number): string {
  const last = entry.olderLastSeenAt ? `last one ${onDay(entry.olderLastSeenAt, now)}` : 'none since tracking began';
  return [
    `Remove the compatibility code "${entry.id}" (dimabot/src/overlays/compat.ts): ${entry.summary}`,
    `No ${pagesOf(entry.client).one} older than version ${entry.before} has been seen for ${quietDays} days (${last}).`,
    'Code:',
    ...entry.code.map((line) => `- ${line}`),
    'Then delete its entry from COMPAT_ENTRIES and follow the usual release workflow.',
  ].join('\n');
}

/**
 * System → Versions: which OBS overlay and Studio editor versions are in use, and which old-version
 * (compatibility) code the API can drop. Owner only; it loads its own report and never changes anything.
 */
@Component({
  selector: 'app-observability-versions',
  imports: [IconComponent, SkeletonComponent],
  templateUrl: './observability-versions.component.html',
  styleUrl: './observability-versions.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ObservabilityVersionsComponent implements OnInit {
  private readonly api = inject(ClientVersionsApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly report = signal<ClientVersionReport | null>(null);
  readonly loading = signal(false);
  /** What went wrong on the last load, in plain words; null when it worked. */
  readonly failure = signal<{ text: string; retry: boolean } | null>(null);
  /** When the shown report arrived; relative times are measured from here. */
  readonly loadedAt = signal(Date.now());
  /** The entry whose request was just copied ("Copied" for 2 s). */
  readonly copied = signal<string | null>(null);
  /** The entry whose request could not be copied: its text is shown to copy by hand. */
  readonly manual = signal<string | null>(null);

  private request?: Subscription;
  private copiedTimer?: ReturnType<typeof setTimeout>;
  private lastCopyAt = 0;

  readonly entries = computed<EntryView[]>(() => {
    const report = this.report();
    if (!report) return [];
    const now = this.loadedAt();
    return [...report.entries]
      .sort((a, b) => stateOf(a.state).order - stateOf(b.state).order)
      .map((entry): EntryView => {
        const tracked = report.trackingSince[entry.client];
        const lastSeen = entry.olderLastSeenAt
          ? `Old page last seen ${relativeTime(entry.olderLastSeenAt, now)}`
          : tracked
            ? `None seen since tracking began (${onDay(tracked, now)})`
            : 'No page has reported its version yet';
        let when: string | null = null;
        if (entry.removableFrom && entry.state === 'removable') when = `Can go since ${onDay(entry.removableFrom, now)}`;
        else if (entry.removableFrom && tracked) when = `Can go on ${onDay(entry.removableFrom, now)} at the earliest`;
        return {
          id: entry.id,
          state: entry.state,
          chip: stateOf(entry.state).chip,
          tone: stateOf(entry.state).tone,
          summary: entry.summary.split('`').map((text, index) => ({ text, code: index % 2 === 1 })).filter((part) => part.text),
          who: `For ${pagesOf(entry.client).many} older than version ${entry.before}`,
          lastSeen,
          lastSeenTitle: entry.olderLastSeenAt ? dateTime(entry.olderLastSeenAt, now) : null,
          when,
          code: entry.code,
          request: entry.state === 'removable' ? removalRequest(entry, report.quietDays, now) : null,
        };
      });
  });

  readonly allVersions = computed(() =>
    [...(this.report()?.versions ?? [])].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)),
  );

  readonly versions = computed<VersionView[]>(() => {
    const report = this.report();
    if (!report) return [];
    const now = this.loadedAt();
    return this.allVersions()
      .slice(0, VERSIONS_SHOWN)
      .map((row): VersionView => ({
        key: `${row.client}|${row.protocol}|${row.build}`,
        client: row.client,
        page: CLIENT_LABEL[row.client] ?? row.client,
        version: row.protocol > 0 ? `Version ${row.protocol}` : 'No version',
        tag: row.outdated ? 'older' : row.protocol > (report.current[row.client] ?? row.protocol) ? 'newer' : 'current',
        build: buildLabel(row.build) ?? row.build,
        buildRaw: buildLabel(row.build) === null,
        connected: row.client === 'overlay' ? formatNumber(row.connectedNow ?? 0) : '—',
        first: relativeTime(row.firstSeenAt, now),
        firstTitle: dateTime(row.firstSeenAt, now),
        last: relativeTime(row.lastSeenAt, now),
        lastTitle: dateTime(row.lastSeenAt, now),
      }));
  });

  /** "Showing the 50 most recently seen of 74." when the list is cut. */
  readonly versionsCut = computed(() => {
    const total = this.allVersions().length;
    if (total <= VERSIONS_SHOWN) return null;
    return `Showing the ${VERSIONS_SHOWN} most recently seen of ${total >= VERSIONS_CAP ? `${VERSIONS_CAP}+` : formatNumber(total)} versions.`;
  });

  /** The page's answer: can any old-version code go now? */
  readonly answer = computed(() => {
    const report = this.report();
    if (!report) return null;
    const count = (state: CompatState) => report.entries.filter((entry) => entry.state === state).length;
    const removable = count('removable');
    const needed = count('needed');
    const now = this.loadedAt();
    // The earliest date a piece can go, among pieces whose client has started reporting.
    const dates = report.entries
      .filter((entry) => entry.state !== 'removable' && entry.removableFrom && report.trackingSince[entry.client])
      .map((entry) => Date.parse(entry.removableFrom!))
      .filter(Number.isFinite);
    const earliest = dates.length ? onDay(new Date(Math.min(...dates)).toISOString(), now) : null;
    if (!report.entries.length) {
      return { tone: 'ok' as const, icon: 'ok', title: 'No old-version code is kept', text: 'The API has no code for older pages right now. New pieces show up here when they are added.' };
    }
    if (removable) {
      return {
        tone: 'warn' as const,
        icon: 'tag',
        title: `${plural(removable, 'piece')} of old-version code can be removed`,
        text: `No page that needs ${removable === 1 ? 'it' : 'them'} has been seen for ${report.quietDays} days. Open "Where the code is" and copy the request for an agent.`,
      };
    }
    if (needed) {
      return {
        tone: 'muted' as const,
        icon: 'info',
        title: 'Nothing can be removed yet',
        text: `Older pages were seen in the last ${report.quietDays} days.${earliest ? ` The first piece can go on ${earliest} at the earliest.` : ''}`,
      };
    }
    return {
      tone: 'muted' as const,
      icon: 'clock',
      title: 'Still collecting data',
      text: earliest
        ? `Versions are tracked for ${report.quietDays} days before any code can go. The first check is on ${earliest}.`
        : 'No page has reported its version yet. Open an OBS overlay or Studio to start.',
    };
  });

  readonly checkedAt = computed(() => {
    const report = this.report();
    return report ? clockTime(report.checkedAt) : null;
  });

  ngOnInit(): void {
    this.load();
    this.destroyRef.onDestroy(() => {
      this.request?.unsubscribe();
      clearTimeout(this.copiedTimer);
    });
  }

  /** Loads the report. A tap while one is on its way waits for that one. */
  load(): void {
    if (this.request && !this.request.closed) return;
    this.loading.set(true);
    this.request = this.api.report().subscribe({
      next: (response) => {
        const data = response?.data;
        if (!data || !Array.isArray(data.entries) || !Array.isArray(data.versions)) {
          this.failure.set({ text: "The version report didn't load.", retry: true });
        } else {
          this.report.set({ ...data, current: data.current ?? { overlay: 0, studio: 0 }, trackingSince: data.trackingSince ?? {} });
          this.loadedAt.set(Date.now());
          this.failure.set(null);
        }
        this.loading.set(false);
      },
      error: (error: unknown) => {
        const status = error instanceof HttpErrorResponse ? error.status : 0;
        this.failure.set(
          status === 403
            ? { text: 'Only the site owner can see page versions.', retry: false }
            : status === 401
              ? { text: 'Your session expired. Sign in again to see page versions.', retry: false }
              : { text: "The version report didn't load.", retry: true },
        );
        this.loading.set(false);
      },
    });
  }

  async copy(entry: EntryView): Promise<void> {
    if (!entry.request) return;
    // Short click guard: a double tap copies once.
    const now = Date.now();
    if (now - this.lastCopyAt < COPY_GUARD_MS) return;
    this.lastCopyAt = now;
    try {
      if (!navigator.clipboard) throw new Error('No clipboard');
      await navigator.clipboard.writeText(entry.request);
      this.manual.set(null);
      this.copied.set(entry.id);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(null), 2000);
    } catch {
      this.copied.set(null);
      this.manual.set(entry.id);
    }
  }
}
