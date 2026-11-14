import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  OAuthPageComponent,
  type AuthorizationDetails,
  type OAuthBrowserSession,
  type OAuthChannel,
  type OAuthConnection,
  type OAuthPagePreview
} from '../../auth/oauth-page.component';

/**
 * `/mocks/dev/oauth-consent`: the real consent + connections page fed with fixtures, no network.
 * `?state=<id>` opens a state directly, `&chrome=0` hides the switcher for clean screenshots.
 */

const DESKTOP_RESOURCE = 'https://api.domdimabot.com/v1';
const MCP_RESOURCE = 'https://mcp.domdimabot.com/mcp';
const DESKTOP_SCOPES = ['profile:read', 'credits:read', 'desktop:connect', 'pet:read', 'pet:receive', 'pet:interact',
  'pet:control', 'pet:playback:select', 'ai:interact'];

const OWN: OAuthChannel = { id: '41000001', name: 'luna_streams', role: 'owner' };
const ADMIN_A: OAuthChannel = { id: '41000002', name: 'pixelrae', role: 'admin' };
const ADMIN_B: OAuthChannel = { id: '41000003', name: 'nightowl_tv', role: 'admin' };
const session = (channels: OAuthChannel[]): OAuthBrowserSession =>
  ({ user_id: '6650f1c2a1b2c3d4e5f60718', channel_id: OWN.id, name: OWN.name, channels });
const MANY = session([OWN, ADMIN_A, ADMIN_B]);
const ONE = session([OWN]);
const NONE = session([]);

const DESKTOP: AuthorizationDetails = {
  client_id: 'dima-desktop', client_name: 'Dima Desktop', device_name: 'Studio PC', scopes: DESKTOP_SCOPES,
  redirect_uri: 'http://127.0.0.1:53682/oauth/callback', client_kind: 'first_party', recognized: true,
  document_host: null, callback_host: '127.0.0.1:53682', resource: DESKTOP_RESOURCE, channel_selection: false
};
const RECOGNIZED: AuthorizationDetails = {
  client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', client_name: 'Claude', device_name: 'Claude',
  scopes: ['channel:read', 'channel:write'], redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_kind: 'cimd',
  recognized: true, document_host: 'claude.ai', callback_host: 'claude.ai', resource: MCP_RESOURCE, channel_selection: true
};
const UNVERIFIED: AuthorizationDetails = {
  client_id: 'https://tools.example.dev/mcp/client.json', client_name: 'Stream Helper MCP', device_name: 'Stream Helper MCP',
  scopes: ['channel:read'], redirect_uri: 'http://localhost:6274/oauth/callback', client_kind: 'cimd', recognized: false,
  document_host: 'tools.example.dev', callback_host: 'localhost:6274', resource: MCP_RESOURCE, channel_selection: true
};

function connections(now: number): OAuthConnection[] {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const day = 24 * 60;
  const claude = { client_id: RECOGNIZED.client_id, client_name: 'Claude', resource: MCP_RESOURCE, device_name: 'Claude' };
  const desktop = { client_id: 'dima-desktop', client_name: 'Dima Desktop', resource: DESKTOP_RESOURCE, scopes: DESKTOP_SCOPES };
  return [
    { ...claude, _id: 's-claude-1', grant_id: 'g-claude-own', channel_id: OWN.id, scopes: ['channel:read', 'channel:write'],
      last_used_at: ago(3), createdAt: ago(12 * day) },
    { ...claude, _id: 's-claude-2', grant_id: 'g-claude-own', channel_id: OWN.id, scopes: ['channel:read', 'channel:write'],
      last_used_at: ago(5 * day), createdAt: ago(9 * day) },
    { ...claude, _id: 's-claude-3', grant_id: 'g-claude-pixel', channel_id: ADMIN_A.id, scopes: ['channel:read'],
      last_used_at: ago(26 * 60), createdAt: ago(3 * day) },
    { ...desktop, _id: 's-desk-1', grant_id: 'g-desk', channel_id: OWN.id, device_name: 'Studio PC',
      last_used_at: ago(42), createdAt: ago(30 * day) },
    { ...desktop, _id: 's-desk-2', grant_id: 'g-desk', channel_id: OWN.id, device_name: 'Laptop',
      last_used_at: ago(6 * day), createdAt: ago(20 * day) },
    { _id: 's-vscode', grant_id: 'g-vscode', client_id: 'https://vscode.dev/oauth/client-metadata.json',
      client_name: 'Visual Studio Code', resource: MCP_RESOURCE, device_name: 'Visual Studio Code', channel_id: OWN.id,
      scopes: ['channel:read'], last_used_at: null, createdAt: ago(15) },
    // A channel the account no longer administers: the page falls back to the channel id.
    { _id: 's-helper', grant_id: 'g-helper', client_id: UNVERIFIED.client_id, client_name: 'Stream Helper MCP',
      resource: MCP_RESOURCE, device_name: 'Stream Helper MCP', channel_id: '41000999', scopes: ['channel:read', 'channel:write'],
      last_used_at: ago(40 * day), createdAt: ago(60 * day) }
  ];
}

interface MockState { id: string; group: string; label: string; preview: () => OAuthPagePreview }

const consent = (details: AuthorizationDetails, extra: Partial<OAuthPagePreview> = {}): OAuthPagePreview =>
  ({ mode: 'consent', signedIn: true, session: MANY, details, ...extra });

const STATES: MockState[] = [
  { id: 'desktop', group: 'Consent', label: 'Dima Desktop', preview: () => consent(DESKTOP, { session: ONE }) },
  { id: 'cimd-recognized', group: 'Consent', label: 'Recognized app · 3 channels', preview: () => consent(RECOGNIZED) },
  { id: 'cimd-unverified', group: 'Consent', label: 'Unverified app · 1 channel', preview: () => consent(UNVERIFIED, { session: ONE }) },
  { id: 'cimd-signed-out', group: 'Consent', label: 'Signed out', preview: () => consent(RECOGNIZED, { signedIn: false }) },
  { id: 'cimd-no-channels', group: 'Consent', label: 'No channel to connect', preview: () => consent(RECOGNIZED, { session: NONE }) },
  { id: 'desktop-signed-out', group: 'Consent', label: 'Desktop · signed out', preview: () => consent(DESKTOP, { signedIn: false }) },

  { id: 'error-expired', group: 'Errors', label: 'Expired or used', preview: () =>
    consent(RECOGNIZED, { loadError: { status: 400, code: 'invalid_request' } }) },
  { id: 'error-blocked', group: 'Errors', label: 'Blocked app', preview: () =>
    consent(RECOGNIZED, { loadError: { status: 400, code: 'invalid_client' } }) },
  { id: 'error-unsupported', group: 'Errors', label: 'Unsupported scope', preview: () =>
    consent(UNVERIFIED, { loadError: { status: 400, code: 'invalid_scope' } }) },
  { id: 'error-channel-access', group: 'Errors', label: 'No access to channel', preview: () => consent(RECOGNIZED, {
    decisionError: { status: 403, code: 'channel_access_required' }, startError: 'channel_access_required', startChannel: ADMIN_B.id }) },
  { id: 'error-login', group: 'Errors', label: 'Sign-in expired', preview: () =>
    consent(RECOGNIZED, { loadError: { status: 401, code: 'login_required' } }) },
  { id: 'error-account', group: 'Errors', label: 'No Dima account', preview: () =>
    consent(RECOGNIZED, { decisionError: { status: 403, code: 'account_required' }, startError: 'account_required' }) },
  { id: 'error-slow-down', group: 'Errors', label: 'Too many tries', preview: () =>
    consent(RECOGNIZED, { decisionError: { status: 429, code: 'slow_down' }, startError: 'slow_down' }) },
  { id: 'error-unsafe-redirect', group: 'Errors', label: 'Return address mismatch', preview: () => consent(RECOGNIZED, {
    decisionRedirect: 'https://claude.ai.attacker.example/api/mcp/auth_callback?code=stolen', startError: 'unsafe_redirect' }) },
  { id: 'error-failed', group: 'Errors', label: 'Server unavailable', preview: () => consent(UNVERIFIED, {
    session: ONE, decisionError: { status: 503, code: 'temporarily_unavailable' }, startError: 'temporarily_unavailable' }) },
  { id: 'error-load-failed', group: 'Errors', label: 'Request lookup failed', preview: () =>
    consent(RECOGNIZED, { loadError: { status: 503, code: 'temporarily_unavailable' } }) },
  { id: 'error-embedded', group: 'Errors', label: 'Opened in a frame', preview: () => consent(RECOGNIZED, { startError: 'embedded' }) },

  { id: 'connections', group: 'Connections', label: 'Several apps', preview: () =>
    ({ mode: 'connections', signedIn: true, session: MANY, connections: connections(Date.now()) }) },
  { id: 'connections-empty', group: 'Connections', label: 'Empty', preview: () =>
    ({ mode: 'connections', signedIn: true, session: ONE, connections: [] }) },
  { id: 'connections-signed-out', group: 'Connections', label: 'Signed out', preview: () =>
    ({ mode: 'connections', signedIn: false, session: MANY, connections: connections(Date.now()) }) }
];
const GROUPS = [...new Set(STATES.map(state => state.group))];

@Component({
  selector: 'app-oauth-consent-mock',
  imports: [OAuthPageComponent, RouterLink],
  template: `
    @if (chrome) {
      <nav class="switcher" aria-label="Mock states">
        <a class="switcher__back" routerLink="/mocks/dev">← Dev mocks</a>
        @for (group of groups; track group) {
          <div class="switcher__group" role="group" [attr.aria-label]="group">
            <span class="switcher__label">{{ group }}</span>
            @for (state of statesIn(group); track state.id) {
              <button type="button" class="switcher__chip" [attr.aria-pressed]="state.id === stateId()" (click)="select(state.id)">{{ state.label }}</button>
            }
          </div>
        }
        <code class="switcher__path">?state={{ stateId() }}</code>
      </nav>
    }
    @for (item of active(); track item.key) {
      <app-oauth-page [preview]="item.preview" />
    }
  `,
  styles: `
    :host { display: block; --bar: #11131a; --bar-fg: #e8ebf3; --chip: #1d2230; --line: rgba(255, 255, 255, 0.12); }
    .switcher {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.9rem; padding: 0.6rem 1rem;
      background: var(--bar); color: var(--bar-fg); font: 0.78rem/1.3 'Plus Jakarta Sans', system-ui, sans-serif;
      border-bottom: 1px solid var(--line);
    }
    .switcher__back { color: #c4b5fd; font-weight: 700; }
    .switcher__group { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; }
    .switcher__label { color: #a7b0c2; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; font-size: 0.66rem; }
    .switcher__chip {
      min-height: 32px; padding: 0.25rem 0.65rem; border: 1px solid var(--line); border-radius: 999px;
      background: var(--chip); color: var(--bar-fg); font: inherit; cursor: pointer;
    }
    .switcher__chip[aria-pressed='true'] { background: #7c3aed; border-color: #7c3aed; color: #fff; }
    .switcher__chip:focus-visible, .switcher__back:focus-visible { outline: 2px solid #c4b5fd; outline-offset: 2px; }
    .switcher__path { color: #a7b0c2; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OAuthConsentMockComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly groups = GROUPS;
  readonly chrome = this.route.snapshot.queryParamMap.get('chrome') !== '0';
  readonly stateId = signal(this.initialState());
  /** A new key per pick recreates the page, so it loads its fixture from scratch like a fresh visit. */
  private readonly generation = signal(0);
  readonly active = computed(() => {
    const state = STATES.find(item => item.id === this.stateId()) ?? STATES[0];
    return [{ key: `${state.id}:${this.generation()}`, preview: state.preview() }];
  });

  statesIn(group: string): MockState[] { return STATES.filter(state => state.group === group); }

  select(id: string): void {
    this.stateId.set(id);
    this.generation.update(value => value + 1);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { state: id }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  private initialState(): string {
    const id = this.route.snapshot.queryParamMap.get('state');
    return STATES.some(state => state.id === id) ? id! : STATES[0].id;
  }
}
