import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface DevMockCard {
  id: string;
  title: string;
  description: string;
  badge: string;
}

@Component({
  selector: 'app-dev-mock-index',
  imports: [RouterLink],
  template: `
    <div class="dev-index">
      <header class="dev-index__head">
        <p class="dev-index__eyebrow">Dev mocks</p>
        <h1>Product shells with live data</h1>
        <p class="dev-index__sub">
          Public playground routes under <code>/mocks/dev/*</code>. No auth required.
        </p>
      </header>

      <div class="dev-index__grid">
        @for (mock of mocks; track mock.id) {
          <a class="dev-card" [routerLink]="['/mocks/dev', mock.id]">
            <span class="dev-card__badge">{{ mock.badge }}</span>
            <h2>{{ mock.title }}</h2>
            <p>{{ mock.description }}</p>
            <span class="dev-card__path">/mocks/dev/{{ mock.id }}</span>
          </a>
        }
      </div>
    </div>
  `,
  styles: `
    .dev-index {
      min-height: 100dvh;
      padding: 1.25rem;
      background:
        radial-gradient(900px 420px at 0% 0%, color-mix(in srgb, #8b5cf6 14%, transparent), transparent 60%),
        var(--bg, #0b0b12);
      color: var(--text);
    }

    .dev-index__head {
      max-width: 40rem;
      margin-bottom: 1.5rem;
    }

    .dev-index__eyebrow {
      margin: 0 0 0.4rem;
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #38bdf8;
    }

    h1 {
      margin: 0;
      font-family: 'Sora', 'Space Grotesk', sans-serif;
      font-size: clamp(1.7rem, 4vw, 2.3rem);
    }

    .dev-index__sub {
      margin: 0.55rem 0 0;
      color: var(--text-soft);
      line-height: 1.5;
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
    }

    .dev-index__grid {
      display: grid;
      gap: 0.85rem;
      grid-template-columns: 1fr;
    }

    .dev-card {
      display: block;
      text-decoration: none;
      color: inherit;
      border: 1px solid color-mix(in srgb, var(--ring) 18%, transparent);
      border-radius: 16px;
      padding: 1rem 1.1rem;
      background: color-mix(in srgb, var(--surface) 90%, transparent);
      transition: border-color 0.15s ease, transform 0.15s ease;
    }

    .dev-card:hover {
      border-color: color-mix(in srgb, #8b5cf6 45%, transparent);
      transform: translateY(-1px);
    }

    .dev-card__badge {
      display: inline-flex;
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #a78bfa;
      margin-bottom: 0.45rem;
    }

    .dev-card h2 {
      margin: 0;
      font-size: 1.1rem;
    }

    .dev-card p {
      margin: 0.4rem 0 0.7rem;
      color: var(--text-soft);
      line-height: 1.45;
      font-size: 0.9rem;
    }

    .dev-card__path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.78rem;
      color: #38bdf8;
    }

    @media (min-width: 768px) {
      .dev-index {
        padding: 2rem;
      }

      .dev-index__grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DevMockIndexComponent {
  readonly mocks: DevMockCard[] = [
    {
      id: 'clips',
      title: 'Clip overlay · Design 1',
      badge: 'Design mocks',
      description:
        'OBS overlay sandbox. Test button injects fixture play-clip data and plays locally — no API. Current Classic vs Live First riff.'
    },
    {
      id: 'command-ast',
      title: 'Command AST blocks',
      badge: 'Local playground',
      description:
        'Visual coding blocks for command AST. Snap, nest, preview source, mock-run with fake chat. No command API.'
    },
    {
      id: 'lf-status',
      title: 'Auth & status (LF)',
      badge: 'Design mocks',
      description:
        'Login + 404 / 403 / 500 / 503 Live First proposals. No OAuth, no guards — visual only before productize.'
    },
    {
      id: 'prod-dashboard',
      title: 'Prod Dashboard',
      badge: 'Live First · OC3c',
      description:
        'Channel control center for cdom201 with product shell nav (dashboard/commands/modules/settings/profile).'
    },
    {
      id: 'prod-commands',
      title: 'Prod Commands',
      badge: 'Live API + timers',
      description:
        'Real chat commands for cdom201 plus interactive timer builder with free / premium / pro interval rules.'
    },
    {
      id: 'prod-modules',
      title: 'Prod Modules',
      badge: 'Placeholder',
      description: 'Stub page so the product shell modules tab is navigable.'
    },
    {
      id: 'prod-settings',
      title: 'Prod Settings',
      badge: 'Placeholder',
      description: 'Stub page for channel settings in the mock shell.'
    },
    {
      id: 'prod-profile',
      title: 'Prod Profile',
      badge: 'Placeholder',
      description: 'Stub profile page; theme + language live under the avatar menu.'
    }
  ];
}
