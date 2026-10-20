import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { LucideAngularModule, Moon, Sun } from 'lucide-angular';

import { LanguageService } from '../../../../services/language.service';
import { LinksService } from '../../../../services/links.service';
import { ThemeService } from '../../../../services/theme.service';
import { BrandLogoComponent } from '../../../../shared/brand-logo/brand-logo.component';
import { LpCopy } from './lp-copy';
import { LpLive } from './lp-live.service';

export interface LpNavLink {
  id: string;
  label: string;
}

/** Page frame shared by the landing proposals: background, sticky nav, footer and the mock switch. */
@Component({
  selector: 'app-lp-chrome',
  imports: [LucideAngularModule, BrandLogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:scroll)': 'onScroll()' },
  styleUrls: ['./lp-ui.css'],
  styles: `
    .lp {
      min-height: 100dvh;
      background:
        radial-gradient(800px 360px at 85% -5%, var(--glow-a), transparent 55%),
        radial-gradient(600px 280px at 5% 0%, var(--glow-b), transparent 50%),
        var(--bg);
      color: var(--fg);
      font-family: var(--font);
      overflow-x: clip;
    }
    .nav {
      position: sticky;
      top: 0;
      z-index: 30;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.6rem 0.85rem;
      background: var(--nav-bg);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid transparent;
      transition: border-color 160ms ease;
    }
    .nav--scrolled { border-bottom-color: var(--line); }
    .brand { display: inline-flex; align-items: center; min-height: 44px; color: var(--fg); text-decoration: none; }
    .links { display: none; gap: 0.15rem; margin-left: auto; }
    .links a {
      display: inline-flex; align-items: center; min-height: 44px; padding: 0 0.7rem; border-radius: 999px;
      color: var(--muted); font-size: 0.9rem; font-weight: 550; text-decoration: none;
    }
    .links a:hover { color: var(--fg); background: var(--accent-soft); }
    .tools { display: flex; align-items: center; gap: 0.35rem; margin-left: auto; }
    .tool {
      display: inline-grid; place-items: center; min-width: 44px; height: 44px; padding: 0 0.6rem; border-radius: 999px;
      border: 1px solid var(--btn-border); background: transparent; color: var(--fg); font: inherit; font-size: 0.8rem;
      font-weight: 750; letter-spacing: 0.04em; cursor: pointer;
    }
    .login-long { display: none; }
    main { display: block; }
    .foot {
      display: flex; flex-wrap: wrap; justify-content: center; gap: 0.35rem 1rem; padding: 2rem 1rem 1.5rem;
      color: var(--muted); font-size: 0.84rem;
    }
    .foot a { color: var(--muted); text-decoration: none; min-height: 32px; display: inline-flex; align-items: center; }
    .foot a:hover { color: var(--fg); }
    .mockbar {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 0.5rem;
      margin: 0 auto 1.5rem; padding: 0.5rem; max-width: 30rem;
      border: 1px dashed var(--btn-border); border-radius: 999px; color: var(--muted); font-size: 0.8rem;
    }
    .mockbar button[aria-pressed='true'] { background: #7c3aed; border-color: #7c3aed; color: #fff; }
    @media (min-width: 640px) {
      .nav { padding: 0.7rem 1.25rem; gap: 0.75rem; }
      .login-long { display: inline; }
      .login-short { display: none; }
    }
    @media (min-width: 960px) {
      .links { display: flex; }
      .tools { margin-left: 0.5rem; }
    }
  `,
  template: `
    <div class="lp" [class.lp--live]="live.channels().length > 0">
      <header class="nav" [class.nav--scrolled]="scrolled()">
        <a class="brand" href="/" aria-label="DomDimaBot"><app-brand-logo /></a>
        <nav class="links" aria-label="Primary">
          @for (link of links(); track link.id) {
            <a [href]="'#' + link.id" (click)="go($event, link.id)">{{ link.label }}</a>
          }
          <a [href]="docsUrl()">{{ c.t('nav.docs') }}</a>
        </nav>
        <div class="tools">
          <button type="button" class="tool" (click)="language.toggleLanguage()" [attr.aria-label]="c.t('nav.language')">
            {{ c.lang() === 'es' ? 'ES' : 'EN' }}
          </button>
          <button type="button" class="tool" (click)="toggleTheme()" [attr.aria-label]="c.t('nav.theme', { mode: dark() ? c.t('nav.light') : c.t('nav.dark') })">
            <lucide-icon class="lp-ico" [img]="dark() ? moon : sun" aria-hidden="true" />
          </button>
          <button type="button" class="lp-btn lp-btn--primary" (click)="live.start()">
            <span class="login-short">{{ c.t('nav.login') }}</span>
            <span class="login-long">{{ c.t('nav.loginLong') }}</span>
          </button>
        </div>
      </header>

      <main id="home">
        <ng-content />
      </main>

      <footer class="foot">
        <span>{{ c.t('common.footer') }}</span>
        <a [href]="docsUrl()">{{ c.t('common.docs') }}</a>
        <a [href]="docsUrl() + 'getting-started/'">{{ c.t('common.gettingStarted') }}</a>
        <a [href]="docsUrl() + 'commands/'">{{ c.t('common.commandsDoc') }}</a>
        <a [href]="docsUrl() + 'plans/'">{{ c.t('common.plansDoc') }}</a>
        <a [href]="discordUrl" target="_blank" rel="noopener">{{ c.t('common.discord') }}</a>
      </footer>

      <div class="mockbar" role="group" [attr.aria-label]="c.t('mock.group')">
        <span>{{ c.t('mock.group') }}:</span>
        <button type="button" class="lp-btn lp-btn--sm" [attr.aria-pressed]="!live.simulate()" (click)="live.simulate.set(false)">{{ c.t('mock.real') }}</button>
        <button type="button" class="lp-btn lp-btn--sm" [attr.aria-pressed]="live.simulate()" (click)="live.simulate.set(true)">{{ c.t('mock.live') }}</button>
      </div>
    </div>
  `
})
export class LpChromeComponent implements OnInit {
  readonly links = input<LpNavLink[]>([]);

  readonly c = inject(LpCopy);
  readonly live = inject(LpLive);
  readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  readonly discordUrl = inject(LinksService).getDiscordUrl();

  readonly sun = Sun;
  readonly moon = Moon;
  readonly scrolled = signal(false);
  readonly dark = computed(() => this.theme.isDarkMode());
  readonly docsUrl = computed(() => `https://docs.domdimabot.com/${this.c.lang() === 'es' ? 'es/' : ''}`);

  ngOnInit(): void {
    this.live.connect();
  }

  toggleTheme(): void {
    this.theme.setTheme(this.dark() ? 'light' : 'dark');
  }

  go(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  onScroll(): void {
    this.scrolled.set(window.scrollY > 8);
  }
}
