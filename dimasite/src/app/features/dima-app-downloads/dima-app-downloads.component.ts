import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { BrandLogoComponent } from '../../shared/brand-logo/brand-logo.component';
import { LanguageService } from '../../services/language.service';
import { ThemeService } from '../../services/theme.service';
import { DesktopArtifact, ReleaseChannel } from './desktop-release.model';
import { DesktopReleaseService, DownloadState } from './desktop-release.service';

@Component({
  selector: 'app-dima-app-downloads',
  imports: [RouterLink, BrandLogoComponent],
  templateUrl: './dima-app-downloads.component.html',
  styleUrl: './dima-app-downloads.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DimaAppDownloadsComponent {
  readonly language = inject(LanguageService);
  readonly theme = inject(ThemeService);
  private readonly releases = inject(DesktopReleaseService);
  private request?: Subscription;
  readonly channel = signal<ReleaseChannel>('stable');
  readonly state = signal<DownloadState>({ status: 'loading' });
  readonly release = computed(() => {
    const state = this.state();
    return state.status === 'ready' ? state.release : null;
  });
  readonly platforms = computed(() => {
    const release = this.release();
    return release ? [
      { id: 'windows', name: 'Windows', arch: 'x64', artifacts: release.windows },
      { id: 'linux', name: 'Linux', arch: 'x86_64', artifacts: release.linux }
    ] : [];
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.request?.unsubscribe());
    // No external metadata request during SSR/prerender.
    afterNextRender(() => this.reload());
  }

  t(key: string): string { return this.language.translate(`desktopDownloads.${key}`); }
  selectChannel(channel: ReleaseChannel): void {
    if (channel === this.channel()) return;
    this.channel.set(channel);
    this.reload();
  }
  reload(): void {
    this.request?.unsubscribe();
    this.state.set({ status: 'loading' });
    this.request = this.releases.load(this.channel()).subscribe(state => this.state.set(state));
  }
  size(artifact: DesktopArtifact): string {
    return new Intl.NumberFormat(this.language.currentLanguage(), { maximumFractionDigits: 1 })
      .format(artifact.size / 1_000_000) + ' MB';
  }
  date(value: string): string {
    return new Intl.DateTimeFormat(this.language.currentLanguage(), { dateStyle: 'medium', timeZone: 'UTC' })
      .format(new Date(value));
  }
}
