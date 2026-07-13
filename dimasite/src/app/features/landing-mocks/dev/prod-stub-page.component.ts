import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { LanguageService } from '../../../services/language.service';

@Component({
  selector: 'app-prod-stub-page',
  imports: [RouterLink],
  template: `
    <div class="stub">
      <main class="stub-main">
        <p class="stub-kicker">{{ t('devMocks.stub.kicker') }}</p>
        <h1 class="stub-title">{{ title() }}</h1>
        <p class="stub-copy">
          {{ t('devMocks.stub.copy', { blurb: blurb() }) }}
        </p>
        <div class="stub-actions">
          <a routerLink="/mocks/dev/prod-dashboard" class="stub-btn stub-btn--primary">
            {{ t('devMocks.stub.toDashboard') }}
          </a>
          <a routerLink="/mocks/dev/prod-commands" class="stub-btn">
            {{ t('devMocks.stub.toCommands') }}
          </a>
        </div>
      </main>
    </div>
  `,
  styles: `
    :host {
      display: block;
      --bg: #f4f5f8;
      --fg: #14151a;
      --muted: #667085;
      --line: rgba(15, 17, 21, 0.08);
      --accent: #7c3aed;
      --btn: #eef0f5;
      --kicker: #6d28d9;
      --glow: rgba(124, 58, 237, 0.12);
      --font: 'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif;
    }

    :host-context(html.dark) {
      --bg: #0f1115;
      --fg: #f5f7fb;
      --muted: #9aa3b5;
      --line: rgba(255, 255, 255, 0.07);
      --accent: #8b5cf6;
      --btn: #1d2230;
      --kicker: #c4b5fd;
      --glow: rgba(139, 92, 246, 0.16);
    }

    .stub {
      min-height: 100%;
      background:
        radial-gradient(700px 320px at 80% -10%, var(--glow), transparent 55%),
        var(--bg);
      color: var(--fg);
      font-family: var(--font);
    }

    .stub-main {
      max-width: 40rem;
      margin: 0 auto;
      padding: 1.5rem 1rem 2rem;
    }

    .stub-kicker {
      margin: 0 0 0.65rem;
      color: var(--kicker);
      font-size: 0.72rem;
      font-weight: 750;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .stub-title {
      margin: 0;
      font-size: clamp(1.8rem, 6vw, 2.6rem);
      letter-spacing: -0.035em;
      font-weight: 750;
      line-height: 1.1;
    }

    .stub-copy {
      margin: 0.85rem 0 0;
      color: var(--muted);
      line-height: 1.6;
    }

    .stub-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
      margin-top: 1.25rem;
    }

    .stub-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 0.65rem 1.05rem;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--btn);
      color: var(--fg);
      text-decoration: none;
      font-weight: 650;
      font-size: 0.9rem;
    }

    .stub-btn--primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProdStubPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly data = toSignal(this.route.data.pipe(map((d) => d)), {
    initialValue: this.route.snapshot.data
  });

  readonly title = computed(() => {
    this.languageService.currentLanguage();
    const key = String(this.data()?.['titleKey'] ?? '');
    if (key) return this.t(key);
    return String(this.data()?.['title'] ?? 'Page');
  });

  readonly blurb = computed(() => {
    this.languageService.currentLanguage();
    const key = String(this.data()?.['blurbKey'] ?? '');
    if (key) return this.t(key);
    return String(this.data()?.['blurb'] ?? '');
  });

  t(key: string, params?: Record<string, string | number>): string {
    this.languageService.currentLanguage();
    return this.languageService.translate(key, params);
  }
}
