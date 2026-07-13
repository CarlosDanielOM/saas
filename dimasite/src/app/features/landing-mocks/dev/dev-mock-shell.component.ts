import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-dev-mock-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <div class="shell">
      <header class="shell-nav">
        <a routerLink="/mocks/dev/prod-dashboard" class="shell-brand" aria-label="DomDimaBot dashboard">
          <span class="shell-brand__live" aria-hidden="true"></span>
          DomDimaBot
        </a>

        <nav class="shell-nav__links" aria-label="Product modules">
          <a
            routerLink="/mocks/dev/prod-dashboard"
            routerLinkActive="shell-nav__link--active"
            class="shell-nav__link"
          >
            Dashboard
          </a>
          <a
            routerLink="/mocks/dev/prod-commands"
            routerLinkActive="shell-nav__link--active"
            class="shell-nav__link"
          >
            Commands
          </a>
          <a routerLink="/mocks/dev" class="shell-nav__link shell-nav__link--quiet">All mocks</a>
        </nav>

        <div class="shell-nav__right">
          <span class="shell-chip">Mock shell</span>
          <div class="shell-avatar" title="cdom201">C</div>
        </div>
      </header>

      <div class="shell-body">
        <router-outlet />
      </div>

      <nav class="shell-bottom" aria-label="Primary navigation">
        <a
          routerLink="/mocks/dev/prod-dashboard"
          routerLinkActive="shell-bottom__link--active"
          class="shell-bottom__link"
        >
          <span class="shell-bottom__icon" aria-hidden="true">▣</span>
          <span>Dashboard</span>
        </a>
        <a
          routerLink="/mocks/dev/prod-commands"
          routerLinkActive="shell-bottom__link--active"
          class="shell-bottom__link"
        >
          <span class="shell-bottom__icon" aria-hidden="true">⚡</span>
          <span>Commands</span>
        </a>
        <a routerLink="/mocks/dev" class="shell-bottom__link">
          <span class="shell-bottom__icon" aria-hidden="true">▦</span>
          <span>Mocks</span>
        </a>
      </nav>
    </div>
  `,
  styles: `
    .shell {
      --bg: #0f1115;
      --tile: #171a21;
      --fg: #f5f7fb;
      --muted: #9aa3b5;
      --line: rgba(255, 255, 255, 0.07);
      --accent: #8b5cf6;
      --accent-soft: rgba(139, 92, 246, 0.16);
      --live: #ef4444;
      --live-soft: rgba(239, 68, 68, 0.14);
      --font: 'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif;
      min-height: 100dvh;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font);
    }

    .shell *,
    .shell *::before,
    .shell *::after {
      box-sizing: border-box;
    }

    .shell-nav {
      position: sticky;
      top: 0;
      z-index: 40;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 0.55rem 0.75rem;
      padding: 0.7rem 0.85rem;
      background: rgba(15, 17, 21, 0.92);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--line);
    }

    .shell-brand {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      min-width: 0;
      color: var(--fg);
      text-decoration: none;
      font-weight: 750;
      letter-spacing: -0.02em;
      font-size: 0.95rem;
    }

    .shell-brand__live {
      flex: 0 0 auto;
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 999px;
      background: var(--live);
      box-shadow: 0 0 0 3px var(--live-soft);
      animation: shell-pulse 1.6s ease-in-out infinite;
    }

    @keyframes shell-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.45;
      }
    }

    .shell-nav__links {
      display: none;
    }

    .shell-nav__link {
      border: 0;
      background: transparent;
      color: var(--muted);
      font: inherit;
      font-size: 0.88rem;
      font-weight: 600;
      padding: 0.42rem 0.7rem;
      border-radius: 999px;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
    }

    .shell-nav__link:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.05);
    }

    .shell-nav__link--active {
      color: var(--fg);
      background: var(--accent-soft);
    }

    .shell-nav__link--quiet {
      color: var(--muted);
      font-weight: 500;
    }

    .shell-nav__right {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.4rem;
    }

    .shell-chip {
      display: none;
      padding: 0.22rem 0.5rem;
      border-radius: 999px;
      background: var(--accent-soft);
      color: #c4b5fd;
      font-size: 0.68rem;
      font-weight: 750;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .shell-avatar {
      width: 2rem;
      height: 2rem;
      border-radius: 0.7rem;
      display: grid;
      place-items: center;
      font-weight: 750;
      font-size: 0.85rem;
      background: linear-gradient(145deg, #4c1d95, #8b5cf6);
      border: 1px solid rgba(196, 181, 253, 0.35);
    }

    .shell-body {
      min-height: calc(100dvh - 3.4rem);
      padding-bottom: calc(4.6rem + env(safe-area-inset-bottom));
    }

    .shell-bottom {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 45;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.2rem;
      padding: 0.45rem 0.55rem calc(0.45rem + env(safe-area-inset-bottom));
      background: rgba(15, 17, 21, 0.94);
      backdrop-filter: blur(16px);
      border-top: 1px solid var(--line);
    }

    .shell-bottom__link {
      display: grid;
      justify-items: center;
      gap: 0.15rem;
      min-height: 3.15rem;
      padding: 0.35rem 0.25rem;
      border-radius: 0.9rem;
      color: var(--muted);
      text-decoration: none;
      font-size: 0.72rem;
      font-weight: 700;
    }

    .shell-bottom__link--active {
      color: var(--fg);
      background: var(--accent-soft);
    }

    .shell-bottom__icon {
      font-size: 0.95rem;
      line-height: 1;
      opacity: 0.9;
    }

    @media (min-width: 960px) {
      .shell-nav {
        display: flex;
        flex-wrap: nowrap;
        padding-inline: 1.25rem;
      }

      .shell-nav__links {
        display: flex;
        align-items: center;
        gap: 0.15rem;
        margin-left: auto;
      }

      .shell-nav__right {
        margin-left: 0.35rem;
      }

      .shell-chip {
        display: inline-flex;
      }

      .shell-bottom {
        display: none;
      }

      .shell-body {
        padding-bottom: 0;
        min-height: calc(100dvh - 3.6rem);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .shell-brand__live {
        animation: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DevMockShellComponent {}
