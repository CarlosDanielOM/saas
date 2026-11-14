import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, OnInit, afterNextRender, computed, inject, input, signal
} from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SessionAuthService } from '../../services/session-auth.service';
import { LanguageService } from '../../services/language.service';
import { ThemeService } from '../../services/theme.service';
import { BrandLogoComponent } from '../../shared/brand-logo/brand-logo.component';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { ThrottleClickDirective } from '../../shared/directives/throttle-click.directive';
import { rememberOAuthReturn } from './oauth-return';

export interface OAuthChannel { id: string; name: string; role: 'owner' | 'admin' }
export interface OAuthBrowserSession { user_id: string; channel_id: string; name: string; channels: OAuthChannel[] }
/** `GET /oauth/requests/:request`. The MCP fields are optional so an older API still renders the desktop flow. */
export interface AuthorizationDetails {
  client_id: string; client_name: string; device_name: string; scopes: string[]; redirect_uri: string;
  client_kind?: 'first_party' | 'cimd'; recognized?: boolean; document_host?: string | null; callback_host?: string;
  resource?: string; channel_selection?: boolean;
}
export interface OAuthConnection {
  _id: string; grant_id: string; client_id: string; client_name?: string; channel_id?: string; resource?: string;
  device_name: string; scopes: string[]; last_used_at?: string | null; expires_at?: string; createdAt?: string;
}
type DecisionBody = { approve: boolean; channel_id?: string };

/** The page's only side effects. The dev mock swaps in fixtures so every state renders without network. */
interface OAuthPageApi {
  signedIn(): boolean;
  request(id: string): Promise<AuthorizationDetails>;
  session(): Promise<OAuthBrowserSession>;
  decide(id: string, body: DecisionBody): Promise<{ redirect_uri: string }>;
  connections(): Promise<{ sessions: OAuthConnection[] }>;
  revoke(path: string): Promise<unknown>;
  signIn(returnPath: string): void;
  clearSession(): void;
  navigate(url: string): void;
}

/** Fixture data for `/mocks/dev/oauth-consent`. Errors are API error codes (`{ error: code }`). */
export interface OAuthPagePreview {
  mode: 'consent' | 'connections';
  signedIn: boolean;
  session: OAuthBrowserSession;
  details?: AuthorizationDetails;
  connections?: OAuthConnection[];
  /** HTTP status + code the request lookup (or, for 401, the browser session) answers with. */
  loadError?: { status: number; code: string };
  /** HTTP status + code every decision answers with. */
  decisionError?: { status: number; code: string };
  /** Redirect the decision answers with; defaults to the request's own callback plus a code. */
  decisionRedirect?: string;
  /** Code shown when the page opens, as if the last click had failed (`unsafe_redirect`, `embedded` too). */
  startError?: string;
  /** Channel picked when the page opens (e.g. the one that just failed). */
  startChannel?: string;
}

export interface ConnectionGrant {
  grantId: string; channelId: string; channelName: string; role: OAuthChannel['role'] | null;
  sessions: OAuthConnection[]; scopes: string[];
}
export interface ConnectionApp {
  key: string; name: string; resource: 'desktop' | 'mcp' | 'other'; resourceHost: string;
  grants: ConnectionGrant[]; sessionCount: number; lastUsed: number;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{43}$/;
const PREVIEW_REQUEST = 'preview_request_0123456789abcdefghijklmnopq';
/** API error code → message key. `invalid_request` also covers a used or expired request. */
const ERROR_KEYS: Record<string, string> = {
  invalid_request: 'oauth.expired',
  invalid_client: 'oauth.errors.blocked',
  invalid_scope: 'oauth.errors.unsupported',
  invalid_target: 'oauth.errors.unsupported',
  channel_access_required: 'oauth.errors.channelAccess',
  account_required: 'oauth.errors.accountRequired',
  slow_down: 'oauth.errors.slowDown',
  unsafe_redirect: 'oauth.errors.unsafeRedirect',
  embedded: 'oauth.embedded'
};
/** These end the request: nothing on the page can fix them, so the choice is hidden. */
const TERMINAL = new Set([
  'oauth.expired', 'oauth.errors.blocked', 'oauth.errors.unsupported', 'oauth.errors.accountRequired',
  'oauth.errors.unsafeRedirect', 'oauth.embedded'
]);

/**
 * The decision may only add query parameters to the request's own callback: same origin and path as
 * `expected`, http(s) only, no credentials or fragment. Anything else is refused without navigating.
 */
export function safeRedirect(returned: unknown, expected: string): URL | null {
  if (typeof returned !== 'string') return null;
  let url: URL;
  let base: URL;
  try { url = new URL(returned); base = new URL(expected); } catch { return null; }
  const web = (item: URL) => item.protocol === 'https:' || item.protocol === 'http:';
  if (!web(url) || !web(base) || url.username || url.password || url.hash) return null;
  return url.origin === base.origin && url.pathname === base.pathname ? url : null;
}

/** Audience URI → label key. Paths, not hosts, so a staging API still reads right. */
export function resourceKind(resource: string | undefined): ConnectionApp['resource'] {
  if (!resource) return 'desktop';
  try {
    const path = new URL(resource).pathname.replace(/\/+$/, '');
    return path === '/v1' ? 'desktop' : path === '/mcp' ? 'mcp' : 'other';
  } catch { return 'other'; }
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

@Component({
  selector: 'app-oauth-page',
  imports: [RouterLink, BrandLogoComponent, LfIconComponent, ThrottleClickDirective],
  templateUrl: './oauth-page.component.html',
  styleUrl: './oauth-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OAuthPageComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(SessionAuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  readonly language = inject(LanguageService);
  readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly abort = new AbortController();

  /** Dev mock only: render from fixtures, never touch the network, the session or the location. */
  readonly preview = input<OAuthPagePreview | null>(null);

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly signedIn = signal(false);
  /** A site token exists: when the session lookup fails for another reason, offer Retry, not Sign in. */
  readonly hasToken = signal(false);
  readonly session = signal<OAuthBrowserSession | null>(null);
  readonly details = signal<AuthorizationDetails | null>(null);
  readonly connections = signal<OAuthConnection[]>([]);
  readonly completed = signal<'' | 'allowed' | 'denied'>('');
  readonly selectedChannel = signal('');
  /** The channel the last approval was refused for (`channel_access_required`), marked in the picker. */
  readonly failedChannel = signal('');
  readonly confirmGrant = signal('');
  readonly notice = signal('');
  readonly now = signal(0);

  readonly management = computed(() => {
    const preview = this.preview();
    return preview ? preview.mode === 'connections' : this.route.snapshot.routeConfig?.path === 'oauth/connections';
  });
  readonly accountName = computed(() => this.session()?.name ?? '');
  readonly channels = computed(() => this.session()?.channels ?? []);
  /** Desktop keeps its original flow; an API without `client_kind` is a desktop API. */
  readonly cimd = computed(() => this.details()?.client_kind === 'cimd');
  readonly channelSelection = computed(() => this.details()?.channel_selection === true);
  readonly mcp = computed(() => resourceKind(this.details()?.resource) === 'mcp');
  readonly terminal = computed(() => TERMINAL.has(this.error()));
  readonly appInitial = computed(() => this.initial(this.details()?.client_name ?? ''));
  readonly publisher = computed(() => {
    const details = this.details();
    if (!details) return '';
    if (details.document_host) return details.document_host;
    try { return new URL(details.client_id).host; } catch { return ''; }
  });
  readonly callbackHost = computed(() => {
    const details = this.details();
    if (!details) return '';
    if (details.callback_host) return details.callback_host;
    try { return new URL(details.redirect_uri).host; } catch { return ''; }
  });
  readonly callbackLocal = computed(() => LOOPBACK.test(this.callbackHost()));
  readonly chosenChannel = computed(() => this.channels().find(channel => channel.id === this.selectedChannel()) ?? null);
  readonly canAllow = computed(() => !this.channelSelection() || this.chosenChannel() !== null);
  readonly apps = computed(() => this.groupConnections(this.connections(), this.session()));

  private api!: OAuthPageApi;
  private requestID: string | null = null;
  /** Rows move after a revoke: a double-click's second press must not land on the next row's button. */
  private actionGuardUntil = 0;
  private confirmOpenedAt = 0;

  constructor() { this.destroyRef.onDestroy(() => this.abort.abort()); }

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate(key, params); }
  /** Scope label/description; unknown scopes show their raw name instead of a missing key. */
  scopeText(group: 'scopes' | 'descriptions', scope: string): string {
    const key = `oauth.${group}.${scope}`;
    const value = this.t(key);
    return value === key ? (group === 'scopes' ? scope : '') : value;
  }
  roleLabel(role: OAuthChannel['role'] | null): string { return role ? this.t(`oauth.roles.${role}`) : ''; }
  initial(name: string): string { return Array.from(name.trim())[0]?.toUpperCase() ?? '?'; }
  scopeIcon(scope: string): 'preview' | 'settings' | 'zap' | 'check' {
    return scope === 'channel:read' ? 'preview' : scope === 'channel:write' ? 'settings' : scope === 'stream:act' ? 'zap' : 'check';
  }
  /** The resource chip only when it adds something (not "Dima Desktop" under the Dima Desktop app). */
  resourceLabel(app: ConnectionApp): string {
    const label = app.resource === 'other' ? app.resourceHost : this.t(`oauth.resources.${app.resource}`);
    return label && label !== app.name ? label : '';
  }
  private locale(): string { return this.language.currentLanguage() === 'es' ? 'es-MX' : 'en'; }
  relativeTime(value: string | null | undefined): string {
    const at = value ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) return this.t('oauth.connections.neverUsed');
    const seconds = Math.round((at - (this.now() || at)) / 1000);
    const abs = Math.abs(seconds);
    const format = new Intl.RelativeTimeFormat(this.locale(), { numeric: 'auto' });
    const when = abs < 45 ? format.format(0, 'second') : abs < 3600 ? format.format(Math.round(seconds / 60), 'minute') :
      abs < 86_400 ? format.format(Math.round(seconds / 3600), 'hour') : format.format(Math.round(seconds / 86_400), 'day');
    return this.t('oauth.connections.lastUsed', { time: when });
  }
  date(value: string | undefined): string {
    const at = value ? Date.parse(value) : NaN;
    return Number.isFinite(at) ? new Intl.DateTimeFormat(this.locale(), { dateStyle: 'medium' }).format(at) : '';
  }
  sessionCount(count: number): string {
    return this.t(count === 1 ? 'oauth.connections.countOne' : 'oauth.connections.countOther', { count });
  }
  deviceLabel(app: ConnectionApp, session: OAuthConnection): string {
    const name = session.device_name?.trim();
    return name && name !== app.name ? name : this.t(app.resource === 'desktop' ? 'oauth.connections.computer' : 'oauth.connections.connection');
  }

  async ngOnInit(): Promise<void> {
    const preview = this.preview();
    this.api = preview ? this.previewApi(preview) : this.httpApi();
    this.requestID = preview ? PREVIEW_REQUEST : this.route.snapshot.queryParamMap.get('request');
    const embedded = preview ? preview.startError === 'embedded' : typeof window !== 'undefined' && window.top !== window.self;
    if (embedded) {
      this.error.set('oauth.embedded');
      this.loading.set(false);
      return;
    }
    await this.load();
    if (preview?.startError && !this.abort.signal.aborted) {
      if (preview.startChannel) this.selectedChannel.set(preview.startChannel);
      if (preview.startError === 'channel_access_required') this.failedChannel.set(this.selectedChannel());
      this.handleError(new Error(preview.startError));
    }
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      if (!this.management()) {
        if (!this.requestID || !REQUEST_ID.test(this.requestID)) throw new Error('invalid_request');
        this.details.set(await this.api.request(this.requestID));
      }
      this.hasToken.set(this.api.signedIn());
      if (!this.hasToken()) return;
      await this.loadSession();
      this.signedIn.set(true);
      if (this.management()) await this.loadConnections();
    } catch (error) { this.handleError(error); }
    finally { if (!this.abort.signal.aborted) this.loading.set(false); }
  }

  private async loadSession(): Promise<void> {
    const session = await this.api.session();
    this.session.set(session);
    // Keep a still-allowed choice; otherwise the account's own channel (listed first), else the first one.
    const channels = session.channels ?? [];
    if (!channels.some(channel => channel.id === this.selectedChannel())) {
      this.selectedChannel.set((channels.find(channel => channel.id === session.channel_id) ?? channels[0])?.id ?? '');
    }
  }

  signIn(): void {
    this.api.signIn(this.management() ? '/oauth/connections' : `/oauth/authorize?request=${this.requestID}`);
  }
  signOut(): void {
    this.api.clearSession();
    this.signedIn.set(false);
    this.hasToken.set(false);
    this.session.set(null);
  }
  selectChannel(id: string): void {
    this.selectedChannel.set(id);
    if (this.error() === 'oauth.errors.channelAccess' && id !== this.failedChannel()) this.error.set('');
  }

  async decide(approve: boolean): Promise<void> {
    const details = this.details();
    if (!details || this.busy() || this.completed() || !this.signedIn() || this.terminal()) return;
    if (approve && !this.canAllow()) return;
    this.busy.set(true);
    this.error.set('');
    this.failedChannel.set('');
    try {
      // channel_id only on approval and only for channel-selection clients; the server refuses it otherwise.
      const body: DecisionBody = approve && this.channelSelection() ? { approve, channel_id: this.selectedChannel() } : { approve };
      const result = await this.api.decide(this.requestID!, body);
      const url = safeRedirect(result?.redirect_uri, details.redirect_uri);
      if (!url) throw new Error('unsafe_redirect');
      this.completed.set(approve ? 'allowed' : 'denied');
      this.api.navigate(url.href);
    } catch (error) {
      this.handleError(error);
      // The request is still open: refresh the list so a channel the account lost drops out of the picker.
      if (this.error() === 'oauth.errors.channelAccess') {
        this.failedChannel.set(this.selectedChannel());
        await this.loadSession().catch(() => undefined);
      }
    } finally { if (!this.abort.signal.aborted) this.busy.set(false); }
  }

  private async loadConnections(): Promise<void> {
    const result = await this.api.connections();
    this.now.set(Date.now());
    this.connections.set(Array.isArray(result?.sessions) ? result.sessions : []);
  }

  askRevokeGrant(grant: ConnectionGrant): void {
    this.confirmGrant.set(grant.grantId);
    this.confirmOpenedAt = performance.now();
    this.notice.set('');
    afterNextRender(() => {
      this.host.nativeElement.querySelector<HTMLButtonElement>(`[data-confirm-grant="${grant.grantId}"]`)?.focus();
    }, { injector: this.injector });
  }
  cancelRevokeGrant(grant: ConnectionGrant): void {
    this.confirmGrant.set('');
    afterNextRender(() => {
      this.host.nativeElement.querySelector<HTMLButtonElement>(`[data-ask-grant="${grant.grantId}"]`)?.focus();
    }, { injector: this.injector });
  }

  /** One session (`connections/:id`) or the app on one channel (`grants/:id`, every session of that grant). */
  async revoke(app: ConnectionApp, grant: ConnectionGrant, session?: OAuthConnection): Promise<void> {
    const now = performance.now();
    if (this.busy() || now < this.actionGuardUntil || (!session && now - this.confirmOpenedAt < 500)) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const path = session ? `connections/${encodeURIComponent(session._id)}` : `grants/${encodeURIComponent(grant.grantId)}`;
      try { await this.api.revoke(path); } catch (error) {
        // Already gone (another tab, expiry): the refreshed list shows the truth.
        if (!(error instanceof HttpErrorResponse && error.status === 404)) throw error;
      }
      this.confirmGrant.set('');
      await this.loadConnections();
      this.notice.set(session ?
        this.t('oauth.connections.disconnectedOne', { device: this.deviceLabel(app, session), channel: grant.channelName }) :
        this.t('oauth.connections.disconnectedApp', { app: app.name, channel: grant.channelName }));
    } catch (error) { this.handleError(error); }
    finally {
      this.actionGuardUntil = performance.now() + 600;
      if (!this.abort.signal.aborted) this.busy.set(false);
    }
  }

  private handleError(error: unknown): void {
    if (this.abort.signal.aborted) return;
    const http = error instanceof HttpErrorResponse ? error : null;
    const body = http?.error as { error?: unknown } | null | undefined;
    const code = http ? (typeof body?.error === 'string' ? body.error : '') : error instanceof Error ? error.message : '';
    if (http?.status === 401 || code === 'login_required') {
      this.api.clearSession();
      this.signedIn.set(false);
      this.hasToken.set(false);
      this.session.set(null);
      this.error.set('oauth.loginExpired');
      return;
    }
    this.error.set(Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : 'oauth.failed');
  }

  /** Apps by client and audience, then the channel each grant is bound to, then its sessions; newest first. */
  private groupConnections(sessions: OAuthConnection[], session: OAuthBrowserSession | null): ConnectionApp[] {
    const channels = new Map((session?.channels ?? []).map(channel => [channel.id, channel]));
    const stamp = (item: OAuthConnection) => Date.parse(item.last_used_at || item.createdAt || '') || 0;
    const apps = new Map<string, ConnectionApp>();
    for (const item of sessions) {
      const kind = resourceKind(item.resource);
      const key = `${item.client_id}\u0000${item.resource ?? ''}`;
      let app = apps.get(key);
      if (!app) {
        let resourceHost = '';
        try { resourceHost = item.resource ? new URL(item.resource).host : ''; } catch { /* label only */ }
        app = { key, name: item.client_name || item.client_id, resource: kind, resourceHost, grants: [], sessionCount: 0, lastUsed: 0 };
        apps.set(key, app);
      }
      // Sessions from before MCP v1 have no channel: they belong to the account's own channel.
      const channelId = item.channel_id || session?.channel_id || '';
      let grant = app.grants.find(entry => entry.grantId === item.grant_id);
      if (!grant) {
        const known = channels.get(channelId);
        grant = { grantId: item.grant_id, channelId, channelName: known?.name || channelId,
          role: known?.role ?? (channelId && channelId === session?.channel_id ? 'owner' : null), sessions: [], scopes: [] };
        app.grants.push(grant);
      }
      grant.sessions.push(item);
      for (const scope of item.scopes ?? []) if (!grant.scopes.includes(scope)) grant.scopes.push(scope);
      app.sessionCount += 1;
      app.lastUsed = Math.max(app.lastUsed, stamp(item));
    }
    const result = [...apps.values()];
    for (const app of result) {
      for (const grant of app.grants) grant.sessions.sort((a, b) => stamp(b) - stamp(a));
      app.grants.sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner') || a.channelName.localeCompare(b.channelName));
    }
    return result.sort((a, b) => b.lastUsed - a.lastUsed);
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.auth.token() || ''}` });
  }

  private httpApi(): OAuthPageApi {
    const base = `${environment.DIMA_API}/oauth`;
    return {
      signedIn: () => Boolean(this.auth.token()),
      request: id => firstValueFrom(this.http.get<AuthorizationDetails>(`${base}/requests/${id}`)),
      session: () => firstValueFrom(this.http.get<OAuthBrowserSession>(`${base}/browser-session`, { headers: this.headers() })),
      decide: (id, body) => firstValueFrom(this.http.post<{ redirect_uri: string }>(`${base}/requests/${id}/decision`, body,
        { headers: this.headers() })),
      connections: () => firstValueFrom(this.http.get<{ sessions: OAuthConnection[] }>(`${base}/connections`, { headers: this.headers() })),
      revoke: path => firstValueFrom(this.http.delete(`${base}/${path}`, { headers: this.headers() })),
      signIn: path => { rememberOAuthReturn(path); window.location.assign('/login'); },
      clearSession: () => this.auth.clearSession(),
      navigate: url => window.location.assign(url)
    };
  }

  private previewApi(preview: OAuthPagePreview): OAuthPageApi {
    let signedIn = preview.signedIn;
    let sessions = [...(preview.connections ?? [])];
    const fail = (error: { status: number; code: string }) =>
      new HttpErrorResponse({ status: error.status, error: { error: error.code } });
    const later = <T>(value: () => T) => new Promise<T>((resolve, reject) => setTimeout(() => {
      try { resolve(value()); } catch (error) { reject(error); }
    }, 120));
    return {
      signedIn: () => signedIn,
      request: () => later(() => {
        if (preview.loadError && preview.loadError.status !== 401) throw fail(preview.loadError);
        if (!preview.details) throw fail({ status: 400, code: 'invalid_request' });
        return preview.details;
      }),
      session: () => later(() => {
        if (preview.loadError?.status === 401) throw fail(preview.loadError);
        return preview.session;
      }),
      decide: (_id, body) => later(() => {
        // A refused channel fails only for that channel, so picking another one can be tried in the mock.
        const refused = preview.decisionError?.code === 'channel_access_required';
        if (preview.decisionError && (!refused || body.channel_id === preview.startChannel)) throw fail(preview.decisionError);
        if (preview.decisionRedirect) return { redirect_uri: preview.decisionRedirect };
        const url = new URL(preview.details!.redirect_uri);
        url.searchParams.set(body.approve ? 'code' : 'error', body.approve ? 'preview-code' : 'access_denied');
        return { redirect_uri: url.href };
      }),
      connections: () => later(() => ({ sessions })),
      revoke: path => later(() => {
        const [kind, id] = path.split('/');
        sessions = sessions.filter(item => (kind === 'grants' ? item.grant_id : item._id) !== decodeURIComponent(id));
        return { revoked: true };
      }),
      signIn: () => { signedIn = true; preview = { ...preview, loadError: undefined }; void this.load(); },
      clearSession: () => { signedIn = false; },
      navigate: () => undefined
    };
  }
}
