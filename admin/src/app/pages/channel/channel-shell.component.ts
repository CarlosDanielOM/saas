import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { AvatarComponent } from '../../shared/avatar/avatar.component';
import { IconComponent } from '../../shared/icon/icon.component';
import { formatNumber, plural } from '../../shared/format';
import { ChannelWorkspaceService } from './channel-workspace.service';

interface WorkspaceTab {
  path: string;
  label: string;
  /** Something wrong the frame already knows about, shown as a small warn count. */
  count: number;
  countLabel: string;
}

/**
 * The channel workspace frame: one header and one tab strip for every page about a channel. It loads the
 * channel once and shares it (and the last-24-hours feed summary) with the tab pages through
 * `ChannelWorkspaceService`, which it provides. Tab pages render their own `.lf-main` and no `h1`.
 */
@Component({
  selector: 'app-channel-shell',
  templateUrl: './channel-shell.component.html',
  styleUrl: './channel-shell.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, AvatarComponent, IconComponent],
  providers: [ChannelWorkspaceService],
})
export class ChannelShellComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly ws = inject(ChannelWorkspaceService);
  private readonly strip = viewChild<ElementRef<HTMLElement>>('strip');

  /** Keyed so the tab pages are created fresh when the channel itself changes. */
  readonly outletKey = computed(() => [this.ws.channelID()]);

  readonly planLabel = computed(() => {
    const tier = this.ws.user()?.plan_tier ?? 'free';
    return tier === 'pro' ? 'Pro' : tier === 'premium' ? 'Premium' : 'Free';
  });

  /** One line: live or not, and when they joined. */
  readonly subline = computed(() => {
    const user = this.ws.user();
    if (!user) return '';
    const joined = user.created_at
      ? new Date(user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : null;
    const state = user.isLive ? `Live with ${formatNumber(user.liveViewers)} watching` : 'Offline';
    return joined ? `${state} · joined ${joined}` : state;
  });

  readonly tabs = computed<WorkspaceTab[]>(() => {
    const failed = this.ws.failed();
    const totalFailed = [...failed.values()].reduce((sum, value) => sum + value, 0);
    const protectionFailed = failed.get('protection') ?? 0;
    const eventsOff = this.ws.user()?.eventsubsDisabledCount ?? 0;
    return [
      { path: '', label: 'Overview', count: 0, countLabel: '' },
      { path: 'activity', label: 'Activity', count: totalFailed, countLabel: `${plural(totalFailed, 'failure')} in the last 24 hours` },
      { path: 'commands', label: 'Commands', count: 0, countLabel: '' },
      { path: 'eventsubs', label: 'Twitch events', count: eventsOff, countLabel: `${formatNumber(eventsOff)} turned off` },
      { path: 'protection', label: 'Protection', count: protectionFailed, countLabel: `${plural(protectionFailed, 'message')} not reviewed in the last 24 hours` },
      { path: 'usage', label: 'AI & credits', count: 0, countLabel: '' },
      { path: 'referrals', label: 'Referrals', count: 0, countLabel: '' },
      { path: 'logs', label: 'Bot log', count: 0, countLabel: '' },
    ];
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.route.paramMap.pipe(takeUntilDestroyed(destroyRef)).subscribe((params) => {
      this.ws.open(params.get('channelID') || '');
    });
    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd), takeUntilDestroyed(destroyRef))
      .subscribe(() => this.revealActiveTab(true));
    afterNextRender(() => this.revealActiveTab(false));
  }

  tabLink(path: string): string[] {
    const id = this.ws.channelID();
    return path ? ['/channels', id, path] : ['/channels', id];
  }

  retry(): void {
    this.ws.load();
    this.ws.loadSummary();
  }

  /** Keep the active tab inside the sideways-scrolling strip on phones (never scrolls the page). */
  private revealActiveTab(smooth: boolean): void {
    setTimeout(() => {
      const strip = this.strip()?.nativeElement;
      const active = strip?.querySelector<HTMLElement>('.is-active');
      if (!strip || !active) return;
      const left = active.offsetLeft - strip.offsetLeft;
      const right = left + active.offsetWidth;
      if (left >= strip.scrollLeft && right <= strip.scrollLeft + strip.clientWidth) return;
      const target = Math.max(0, left - (strip.clientWidth - active.offsetWidth) / 2);
      strip.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' });
    }, 50);
  }
}
