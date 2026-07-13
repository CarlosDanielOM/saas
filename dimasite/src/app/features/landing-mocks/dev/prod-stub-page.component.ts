import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

@Component({
  selector: 'app-prod-stub-page',
  imports: [RouterLink],
  template: `
    <div class="stub">
      <main class="stub-main">
        <p class="stub-kicker">Mock shell · placeholder</p>
        <h1 class="stub-title">{{ title() }}</h1>
        <p class="stub-copy">
          {{ blurb() }}
          This page exists so product navigation feels complete — wire the real module later.
        </p>
        <div class="stub-actions">
          <a routerLink="/mocks/dev/prod-dashboard" class="stub-btn stub-btn--primary">Dashboard</a>
          <a routerLink="/mocks/dev/prod-commands" class="stub-btn">Commands</a>
        </div>
      </main>
    </div>
  `,
  styles: `
    .stub {
      --bg: #0f1115;
      --tile: #171a21;
      --fg: #f5f7fb;
      --muted: #9aa3b5;
      --line: rgba(255, 255, 255, 0.07);
      --accent: #8b5cf6;
      --font: 'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif;
      min-height: 100%;
      background:
        radial-gradient(700px 320px at 80% -10%, rgba(139, 92, 246, 0.16), transparent 55%),
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
      color: #c4b5fd;
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
      background: #1d2230;
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
  private readonly data = toSignal(this.route.data.pipe(map((d) => d)), {
    initialValue: this.route.snapshot.data
  });

  readonly title = computed(() => String(this.data()?.['title'] ?? 'Page'));
  readonly blurb = computed(
    () =>
      String(
        this.data()?.['blurb'] ??
          'A Live First placeholder for this product area.'
      )
  );
}
