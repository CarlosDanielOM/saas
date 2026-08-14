import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface StatusMockCard {
  id: string;
  title: string;
  code: string;
  description: string;
  badge: string;
}

@Component({
  selector: 'app-lf-auth-status-hub',
  imports: [RouterLink],
  template: `
    <div class="hub">
      <header class="hub__head">
        <p class="hub__eyebrow">Live First · design mocks</p>
        <h1>Auth &amp; status pages</h1>
        <p class="hub__sub">
          Visual proposals only — not wired to guards or OAuth. Pick a surface, then we productize.
        </p>
        <a class="hub__back" routerLink="/mocks/dev">← Dev mocks</a>
      </header>

      <div class="hub__grid">
        @for (mock of mocks; track mock.id) {
          <a class="card" [routerLink]="['/mocks/dev', mock.id]">
            <span class="card__code">{{ mock.code }}</span>
            <span class="card__badge">{{ mock.badge }}</span>
            <h2>{{ mock.title }}</h2>
            <p>{{ mock.description }}</p>
            <span class="card__path">/mocks/dev/{{ mock.id }}</span>
          </a>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      --bg: #f4f5f8;
      --tile: #ffffff;
      --fg: #14151a;
      --muted: #667085;
      --line: rgba(15, 17, 21, 0.08);
      --accent: #7c3aed;
      --accent-soft: rgba(124, 58, 237, 0.12);
      --font: 'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif;
    }

    :host-context(html.dark) {
      --bg: #0f1115;
      --tile: #171a21;
      --fg: #f5f7fb;
      --muted: #9aa3b5;
      --line: rgba(255, 255, 255, 0.07);
      --accent: #8b5cf6;
      --accent-soft: rgba(139, 92, 246, 0.16);
    }

    .hub {
      min-height: 100dvh;
      padding: 1.25rem;
      background:
        radial-gradient(800px 360px at 80% -5%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 55%),
        var(--bg);
      color: var(--fg);
      font-family: var(--font);
    }

    .hub__head {
      max-width: 36rem;
      margin-bottom: 1.5rem;
    }

    .hub__eyebrow {
      margin: 0 0 0.4rem;
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--accent);
    }

    h1 {
      margin: 0;
      font-size: clamp(1.6rem, 4vw, 2.1rem);
      letter-spacing: -0.03em;
    }

    .hub__sub {
      margin: 0.55rem 0 0;
      color: var(--muted);
      line-height: 1.5;
      font-size: 0.95rem;
    }

    .hub__back {
      display: inline-flex;
      margin-top: 0.85rem;
      color: var(--accent);
      font-weight: 650;
      font-size: 0.9rem;
      text-decoration: none;
    }

    .hub__grid {
      display: grid;
      gap: 0.85rem;
      grid-template-columns: 1fr;
      max-width: 56rem;
    }

    .card {
      display: grid;
      grid-template-columns: auto 1fr;
      grid-template-rows: auto auto auto auto;
      column-gap: 0.85rem;
      text-decoration: none;
      color: inherit;
      border: 1px solid var(--line);
      border-radius: 1.15rem;
      padding: 1rem 1.1rem;
      background: var(--tile);
      box-shadow: 0 10px 28px rgba(15, 15, 20, 0.06);
      transition: border-color 0.15s ease, transform 0.15s ease;
    }

    .card:hover {
      border-color: color-mix(in srgb, var(--accent) 40%, transparent);
      transform: translateY(-1px);
    }

    .card__code {
      grid-row: 1 / span 4;
      align-self: center;
      font-size: 1.35rem;
      font-weight: 800;
      letter-spacing: -0.04em;
      color: var(--accent);
      min-width: 3.2rem;
      text-align: center;
    }

    .card__badge {
      grid-column: 2;
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 0.2rem;
    }

    .card h2 {
      grid-column: 2;
      margin: 0;
      font-size: 1.05rem;
    }

    .card p {
      grid-column: 2;
      margin: 0.35rem 0 0.55rem;
      color: var(--muted);
      line-height: 1.45;
      font-size: 0.88rem;
    }

    .card__path {
      grid-column: 2;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.76rem;
      color: var(--muted);
    }

    @media (min-width: 720px) {
      .hub {
        padding: 2rem;
      }

      .hub__grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LfAuthStatusHubComponent {
  readonly mocks: StatusMockCard[] = [
    {
      id: 'lf-login',
      code: '•••',
      title: 'Login',
      badge: 'Auth',
      description:
        'Twitch sign-in card. Stage switcher: idle, loading (soft progress), error. Optional activity log — no Three.js.'
    },
    {
      id: 'lf-404',
      code: '404',
      title: 'Not found',
      badge: 'Public',
      description: 'Unknown route / missing channel. Big code + recovery CTAs on LF bento.'
    },
    {
      id: 'lf-403',
      code: '403',
      title: 'Forbidden',
      badge: 'Public / standalone',
      description: 'Permission denied as a full public page — permission chip + requested path.'
    },
    {
      id: 'lf-403-embedded',
      code: '403',
      title: 'Forbidden (in app)',
      badge: 'Auth shell',
      description: 'Same 403 content under a fake LF navbar — matches /:streamer/403.'
    },
    {
      id: 'lf-500',
      code: '500',
      title: 'Server error',
      badge: 'Status',
      description: 'Generic failure surface for unexpected backend/API breaks.'
    },
    {
      id: 'lf-503',
      code: '503',
      title: 'Unavailable',
      badge: 'Status',
      description: 'Maintenance / overload — calm copy, retry + home.'
    }
  ];
}
