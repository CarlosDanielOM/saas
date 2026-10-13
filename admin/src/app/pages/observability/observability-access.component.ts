import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AvatarComponent } from '../../shared/avatar/avatar.component';
import { ConfirmModalComponent } from '../../shared/confirm-modal/confirm-modal.component';
import { IconComponent } from '../../shared/icon/icon.component';

export interface AccessGrant {
  user_id: string;
  role: 'owner' | 'viewer' | 'investigator';
  channels: string[];
  services: string[];
  expires_at: string | null;
}
type Expiry = 'never' | '1d' | '7d' | '30d' | 'custom';

const SERVICES: Array<{ id: string; label: string }> = [
  { id: 'api', label: 'API' },
  { id: 'bot', label: 'Bot' },
  { id: 'cron', label: 'Workers' },
  { id: 'queues', label: 'Queues' },
  { id: 'dragonfly', label: 'Dragonfly' },
  { id: 'mongodb', label: 'MongoDB' },
  { id: 'qdrant', label: 'Qdrant' },
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'analytics', label: 'Analytics' },
];
const EXPIRIES: Array<{ id: Expiry; label: string }> = [
  { id: 'never', label: 'No end date' },
  { id: '1d', label: '1 day' },
  { id: '7d', label: '1 week' },
  { id: '30d', label: '30 days' },
  { id: 'custom', label: 'Pick a date' },
];

/**
 * Owner-only analytics access: a stepped grant form and the list of who has access.
 * The page loads the grant list; this component owns the form and the confirmed changes.
 */
@Component({
  selector: 'app-observability-access',
  imports: [DatePipe, AvatarComponent, ConfirmModalComponent, IconComponent],
  templateUrl: './observability-access.component.html',
  styleUrl: './observability-access.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ObservabilityAccessComponent {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.DIMA_API}/observability/api`;

  readonly grants = input.required<AccessGrant[]>();
  readonly channelNames = input.required<Record<string, string | null>>();
  readonly loading = input(false);
  /** A grant was saved or revoked; the page reloads the list. */
  readonly changed = output<void>();
  /** Names learned from a Twitch lookup, so the page can label that ID everywhere. */
  readonly namesFound = output<{ channelNames: Record<string, string | null> }>();

  readonly services = SERVICES;
  readonly expiries = EXPIRIES;

  readonly grantLogin = signal('');
  readonly grantUser = signal('');
  readonly grantUserName = signal<string | null>(null);
  readonly lookupState = signal<'idle' | 'busy' | 'missing'>('idle');
  readonly grantRole = signal<'viewer' | 'investigator'>('viewer');
  readonly grantAllChannels = signal(true);
  readonly grantChannels = signal<string[]>([]);
  readonly grantExtraChannels = signal('');
  readonly grantServices = signal<string[]>([]);
  readonly grantExpiry = signal<Expiry>('never');
  readonly grantCustomExpiry = signal('');
  readonly grantAttempted = signal(false);
  readonly confirmation = signal<'save' | string | null>(null);
  readonly saving = signal(false);
  readonly notice = signal('');
  readonly accessError = signal('');

  readonly knownChannels = computed(() =>
    Object.entries(this.channelNames())
      .map(([id, name]) => ({ id, name: name || `Unknown channel (${id})` }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  readonly grantChannelList = computed(() => {
    const extra = this.grantExtraChannels()
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    return this.grantAllChannels() ? [] : [...new Set([...this.grantChannels(), ...extra])];
  });
  readonly grantExpiresAt = computed(() => {
    const expiry = this.grantExpiry();
    if (expiry === 'never') return null;
    if (expiry === 'custom') return this.grantCustomExpiry() ? new Date(this.grantCustomExpiry()) : null;
    return new Date(Date.now() + { '1d': 1, '7d': 7, '30d': 30 }[expiry] * 86400000);
  });
  readonly grantProblems = computed(() => {
    const problems: Record<string, string> = {};
    if (!/^\d{1,30}$/.test(this.grantUser())) problems['user'] = 'Find the Twitch account first, or enter its numeric user ID.';
    if (!this.grantAllChannels() && !this.grantChannelList().length) problems['channels'] = 'Pick at least one channel, or choose all channels.';
    if (this.grantChannelList().some((id) => !/^[a-zA-Z0-9_.:-]{1,80}$/.test(id))) problems['channels'] = 'Channel IDs can only contain letters, numbers and _ . : -';
    if (this.grantExpiry() === 'custom') {
      const at = this.grantExpiresAt();
      if (!at || !Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) problems['expiry'] = 'Pick a date in the future.';
    }
    return problems;
  });
  readonly grantSummary = computed(() => {
    const who = this.grantUserName() ? `${this.grantUserName()} (${this.grantUser()})` : `Twitch user ${this.grantUser()}`;
    const what = this.grantRole() === 'investigator' ? 'see charts, numbers, logs and request traces' : 'see charts and numbers (no logs or traces)';
    const channels = this.grantChannelList();
    const where = channels.length ? `for ${this.channelList(channels)} only` : 'for every channel';
    const services = this.grantServices().length ? `, limited to ${this.serviceList(this.grantServices())}` : '';
    const until = this.grantExpiresAt() ? `until ${this.grantExpiresAt()!.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'with no end date';
    const servers = channels.length ? ' Channel-limited access never includes the Servers view.' : '';
    return `${who} will be able to ${what} ${where}${services}, ${until}.${servers}`;
  });
  readonly revokeTarget = computed(() => {
    const action = this.confirmation();
    return action && action !== 'save' ? action : null;
  });

  async lookupLogin(): Promise<void> {
    const login = this.grantLogin().trim().replace(/^@/, '');
    if (!login) return;
    this.lookupState.set('busy');
    try {
      const response = await firstValueFrom(
        this.http.get<{ data?: { id?: string; username?: string; display_name?: string } }>(`${environment.DIMA_API}/users`, { params: { username: login } }),
      );
      const user = response?.data;
      if (!user?.id) throw new Error('missing');
      this.grantUser.set(String(user.id));
      this.grantUserName.set(user.display_name || user.username || login);
      this.namesFound.emit({ channelNames: { [String(user.id)]: user.username || login } });
      this.lookupState.set('idle');
    } catch {
      this.grantUser.set('');
      this.grantUserName.set(null);
      this.lookupState.set('missing');
    }
  }
  setGrantUserId(value: string): void {
    this.grantUser.set(value.trim());
    this.grantUserName.set(this.channelNames()[value.trim()] ?? null);
  }
  clearGrantUser(): void {
    this.grantUser.set('');
    this.grantUserName.set(null);
    this.grantLogin.set('');
    this.lookupState.set('idle');
  }
  toggle(list: typeof this.grantChannels, id: string): void {
    list.update((items) => (items.includes(id) ? items.filter((x) => x !== id) : [...items, id]));
  }
  reviewGrant(): void {
    this.grantAttempted.set(true);
    this.notice.set('');
    this.accessError.set('');
    if (Object.keys(this.grantProblems()).length) return;
    this.confirmation.set('save');
  }
  editGrant(item: AccessGrant): void {
    this.grantUser.set(item.user_id);
    this.grantUserName.set(this.channelNames()[item.user_id] ?? null);
    this.grantLogin.set(this.channelNames()[item.user_id] ?? '');
    this.grantRole.set(item.role === 'investigator' ? 'investigator' : 'viewer');
    this.grantAllChannels.set(!item.channels.length);
    this.grantChannels.set([...item.channels]);
    this.grantExtraChannels.set('');
    this.grantServices.set([...item.services]);
    if (item.expires_at && Date.parse(item.expires_at) > Date.now()) {
      // datetime-local wants local wall-clock time without a zone.
      const local = new Date(Date.parse(item.expires_at) - new Date().getTimezoneOffset() * 60000);
      this.grantExpiry.set('custom');
      this.grantCustomExpiry.set(local.toISOString().slice(0, 16));
    } else {
      this.grantExpiry.set('never');
      this.grantCustomExpiry.set('');
    }
    this.notice.set('');
    document.getElementById('grant-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  revoke(userId: string): void {
    this.notice.set('');
    this.confirmation.set(userId);
  }
  async confirmAccess(): Promise<void> {
    const action = this.confirmation();
    if (!action) return;
    this.saving.set(true);
    this.notice.set('');
    this.accessError.set('');
    try {
      if (action === 'save') {
        await firstValueFrom(
          this.http.put(this.base + '/grants/' + this.grantUser(), {
            role: this.grantRole(),
            channels: this.grantChannelList(),
            services: this.grantServices(),
            expiresAt: this.grantExpiresAt()?.toISOString() ?? null,
          }),
        );
        this.notice.set('Access updated.');
        this.resetForm();
      } else {
        await firstValueFrom(this.http.delete(this.base + '/grants/' + action));
        this.notice.set('Access revoked.');
      }
      this.confirmation.set(null);
      this.changed.emit();
    } catch (error) {
      this.confirmation.set(null);
      this.accessError.set(
        error instanceof HttpErrorResponse && error.status === 400
          ? 'That grant was rejected. Check the user ID, channels and end date.'
          : "Couldn't save the change. Nothing was updated; try again.",
      );
    } finally {
      this.saving.set(false);
    }
  }
  private resetForm(): void {
    this.clearGrantUser();
    this.grantRole.set('viewer');
    this.grantAllChannels.set(true);
    this.grantChannels.set([]);
    this.grantExtraChannels.set('');
    this.grantServices.set([]);
    this.grantExpiry.set('never');
    this.grantCustomExpiry.set('');
    this.grantAttempted.set(false);
  }

  serviceLabel(id: string): string {
    return SERVICES.find((s) => s.id === id)?.label ?? id;
  }
  serviceList(ids: string[]): string {
    return ids.map((id) => this.serviceLabel(id)).join(', ');
  }
  roleLabel(role: string): string {
    return role === 'investigator' ? 'Investigator' : role === 'owner' ? 'Owner' : 'Viewer';
  }
  channelName(id: string): string {
    return this.channelNames()[id] || 'Unknown account';
  }
  channelLabel(id: string): string {
    return `${this.channelName(id)} (${id})`;
  }
  channelList(ids: string[]): string {
    return ids.map((id) => this.channelLabel(id)).join(', ');
  }
  isExpired(item: AccessGrant): boolean {
    return !!item.expires_at && Date.parse(item.expires_at) <= Date.now();
  }
}
