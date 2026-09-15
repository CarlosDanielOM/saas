import { ChangeDetectionStrategy, Component, ElementRef, ChangeDetectorRef, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { FollowDefenseApiService } from '../../services/follow-defense-api.service';
import { LanguageService } from '../../services/language.service';
import { ToastService } from '../../services/toast.service';
import type { RaidSession, RaidFollower, RaidSessionsPage, RaidFollowersPage } from '../../models/follow-defense.model';

@Component({
  selector: 'app-raid-sessions',
  imports: [DatePipe, DecimalPipe],
  templateUrl: './raid-sessions.component.html',
  styleUrl: './raid-sessions.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RaidSessionsComponent {
  readonly channelID = input.required<string>();
  readonly moderated = output<void>();
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly api = inject(FollowDefenseApiService);
  private readonly language = inject(LanguageService);
  private readonly toast = inject(ToastService);
  readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('confirmation');
  readonly sessions = signal<RaidSessionsPage | null>(null);
  readonly followers = signal<RaidFollowersPage | null>(null);
  readonly expanded = signal<string | null>(null);
  readonly loading = signal(false);
  readonly followersLoading = signal(false);
  readonly error = signal('');
  readonly followerError = signal('');
  readonly confirmError = signal('');
  readonly submitting = signal(false);
  readonly selection = signal<{ channel: string; session: RaidSession; follower?: RaidFollower; requestID: string } | null>(null);
  private listVersion = 0;
  private followerVersion = 0;

  constructor() {
    effect((cleanup) => {
      this.channelID();
      untracked(() => {
        this.sessions.set(null);
        this.expanded.set(null);
        this.followers.set(null);
        this.selection.set(null);
        this.dialog().nativeElement.close();
        void this.load(1);
        const timer = window.setInterval(() => {
          if (document.hidden || this.submitting() || this.selection()) return;
          void this.load(this.sessions()?.page || 1, true);
          if (this.expanded()) void this.loadFollowers(this.expanded()!, this.followers()?.page || 1, true);
        }, 10000);
        cleanup(() => { window.clearInterval(timer); this.listVersion++; this.followerVersion++; });
      });
    });
  }

  t(key: string, params?: Record<string, string | number>) { return this.language.translate(`raidSessions.${key}`, params); }

  async load(page = 1, quiet = false) {
    const version = ++this.listVersion;
    if (!quiet) this.loading.set(true);
    try {
      const result = await firstValueFrom(this.api.getRaidSessions(this.channelID(), page));
      if (version !== this.listVersion) return;
      if (result.error || !result.data) throw new Error();
      this.sessions.set(result.data);
      this.error.set('');
      if (this.expanded() && !result.data.sessions.some(s => s.id === this.expanded())) this.expanded.set(null);
    } catch { if (version === this.listVersion) this.error.set(this.t('loadError')); }
    finally { if (version === this.listVersion) this.loading.set(false); }
  }

  toggle(session: RaidSession) {
    if (this.expanded() === session.id) { this.expanded.set(null); this.followerVersion++; return; }
    this.expanded.set(session.id);
    this.followers.set(null);
    void this.loadFollowers(session.id);
  }

  async loadFollowers(id: string, page = 1, quiet = false) {
    const version = ++this.followerVersion;
    if (!quiet) this.followersLoading.set(true);
    try {
      const result = await firstValueFrom(this.api.getRaidFollowers(this.channelID(), id, page));
      if (version !== this.followerVersion || this.expanded() !== id) return;
      if (result.error || !result.data) throw new Error();
      this.followers.set(result.data);
      this.followerError.set('');
    } catch { if (version === this.followerVersion) this.followerError.set(this.t('loadError')); }
    finally { if (version === this.followerVersion) this.followersLoading.set(false); }
  }

  ask(session: RaidSession, follower?: RaidFollower) {
    this.selection.set({ channel: this.channelID(), session, follower, requestID: crypto.randomUUID() });
    this.confirmError.set('');
    this.changeDetector.detectChanges();
    this.dialog().nativeElement.showModal();
  }

  cancel(event?: Event) {
    if (this.submitting()) { event?.preventDefault(); return; }
    this.dialog().nativeElement.close();
    this.selection.set(null);
  }

  async confirm() {
    const selected = this.selection();
    if (!selected || this.submitting()) return;
    this.submitting.set(true);
    this.confirmError.set('');
    try {
      const result = await firstValueFrom(this.api.banRaidFollowers(selected.channel, selected.session.id, selected.requestID,
        selected.follower?.userID || '', !selected.follower && selected.session.canIncludeFuture));
      if (result.error) throw new Error();
      this.dialog().nativeElement.close();
      this.selection.set(null);
      this.toast.success(this.t('queuedTitle'), this.t('queued'));
      this.moderated.emit();
      await this.load(this.sessions()?.page || 1);
      if (this.expanded() === selected.session.id) await this.loadFollowers(selected.session.id, this.followers()?.page || 1);
    } catch { this.confirmError.set(this.t('banError')); }
    finally { this.submitting.set(false); }
  }
}
