import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SessionAuthService } from '../../services/session-auth.service';
import { LanguageService } from '../../services/language.service';
import { ThemeService } from '../../services/theme.service';
import { BrandLogoComponent } from '../../shared/brand-logo/brand-logo.component';
import { rememberOAuthReturn } from './oauth-return';

interface AuthorizationDetails {
  client_id: string; client_name: string; device_name: string; scopes: string[]; redirect_uri: string;
}
interface Connection {
  _id: string; grant_id: string; client_id: string; device_name: string; scopes: string[];
}

@Component({
  selector: 'app-oauth-page',
  imports: [RouterLink, BrandLogoComponent],
  templateUrl: './oauth-page.component.html',
  styleUrl: './oauth-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OAuthPageComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(SessionAuthService);
  readonly language = inject(LanguageService);
  readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly abort = new AbortController();
  readonly management = this.route.snapshot.routeConfig?.path === 'oauth/connections';
  private readonly requestID = this.route.snapshot.queryParamMap.get('request');
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly signedIn = signal(false);
  readonly accountName = signal('');
  readonly details = signal<AuthorizationDetails | null>(null);
  readonly connections = signal<Connection[]>([]);
  readonly completed = signal(false);

  constructor() { this.destroyRef.onDestroy(() => this.abort.abort()); }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate(key, params); }
  private headers(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.auth.token() || ''}` });
  }
  async ngOnInit(): Promise<void> {
    if (typeof window !== 'undefined' && window.top !== window.self) {
      this.error.set('oauth.embedded');
      this.loading.set(false);
      return;
    }
    await this.load();
  }
  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      if (!this.management) {
        if (!this.requestID || !/^[A-Za-z0-9_-]{43}$/.test(this.requestID)) throw new Error('invalid_request');
        this.details.set(await firstValueFrom(this.http.get<AuthorizationDetails>(
          `${environment.DIMA_API}/oauth/requests/${this.requestID}`)));
      }
      if (!this.auth.token()) return;
      const user = await firstValueFrom(this.http.get<{ name: string }>(`${environment.DIMA_API}/oauth/browser-session`, { headers: this.headers() }));
      this.accountName.set(user.name);
      this.signedIn.set(true);
      if (this.management) await this.loadConnections();
    } catch (error) { this.handleError(error); }
    finally { if (!this.abort.signal.aborted) this.loading.set(false); }
  }
  signIn(): void {
    rememberOAuthReturn(this.management ? '/oauth/connections' : `/oauth/authorize?request=${this.requestID}`);
    window.location.assign('/login');
  }
  signOut(): void { this.auth.clearSession(); this.signedIn.set(false); }
  async decide(approve: boolean): Promise<void> {
    if (this.busy() || this.completed() || !this.signedIn()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await firstValueFrom(this.http.post<{ redirect_uri: string }>(
        `${environment.DIMA_API}/oauth/requests/${this.requestID}/decision`, { approve }, { headers: this.headers() }));
      const url = new URL(result.redirect_uri);
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        !url.port || url.pathname !== '/oauth/callback' || url.username || url.password || url.hash) throw new Error('invalid_request');
      this.completed.set(true);
      window.location.assign(url.href);
    } catch (error) { this.handleError(error); }
    finally { this.busy.set(false); }
  }
  private async loadConnections(): Promise<void> {
    const result = await firstValueFrom(this.http.get<{ sessions: Connection[] }>(`${environment.DIMA_API}/oauth/connections`, { headers: this.headers() }));
    this.connections.set(result.sessions);
  }
  async revoke(connection: Connection, wholeApp = false): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const path = wholeApp ? `grants/${connection.grant_id}` : `connections/${connection._id}`;
      await firstValueFrom(this.http.delete(`${environment.DIMA_API}/oauth/${path}`, { headers: this.headers() }));
      await this.loadConnections();
    } catch (error) { this.handleError(error); }
    finally { this.busy.set(false); }
  }
  private handleError(error: unknown): void {
    if (this.abort.signal.aborted) return;
    if (error instanceof HttpErrorResponse && error.status === 401) {
      this.auth.clearSession(); this.signedIn.set(false);
      this.error.set('oauth.loginExpired');
    } else if (error instanceof Error && error.message === 'invalid_request' ||
      error instanceof HttpErrorResponse && error.error?.error === 'invalid_request') this.error.set('oauth.expired');
    else this.error.set('oauth.failed');
  }
}
