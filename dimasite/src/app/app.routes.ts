import { Routes } from '@angular/router';

import { authenticatedGuard } from './guards/authenticated.guard';
import { PublicCommandsPageComponent } from './features/commands/public-commands-page.component';
import { ForbiddenPageComponent } from './features/forbidden/forbidden-page.component';
import { NotFoundPageComponent } from './features/not-found/not-found-page.component';
import { permissionGuard } from './guards/permission.guard';
import { streamerRouteShapeGuard, validStreamerGuard } from './guards/streamer-route.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/landing/landing-page.component').then((m) => m.LandingPageComponent),
    title: 'DomDimaBot'
  },
  // === Design Mocks (public, no auth) ===
  {
    path: 'mock',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-index.component').then((m) => m.LandingMockIndexComponent),
    title: 'Landing Mocks | DomDimaBot'
  },
  {
    path: 'mock/1',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-1.component').then((m) => m.LandingMock1Component),
    title: 'Mock 1: Pure Minimal | DomDimaBot'
  },
  {
    path: 'mock/2',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-2.component').then((m) => m.LandingMock2Component),
    title: 'Mock 2: Gradient Pop | DomDimaBot'
  },
  {
    path: 'mock/3',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-3.component').then((m) => m.LandingMock3Component),
    title: 'Mock 3: Neon Console | DomDimaBot'
  },
  {
    path: 'mock/4',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-4.component').then((m) => m.LandingMock4Component),
    title: 'Mock 4: Twitch Energy | DomDimaBot'
  },
  {
    path: 'mock/5',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-5.component').then((m) => m.LandingMock5Component),
    title: 'Mock 5: Squad Glow | DomDimaBot'
  },
  {
    path: 'mock/6',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-6.component').then((m) => m.LandingMock6Component),
    title: 'Mock 6: Stream Glow | DomDimaBot'
  },
  {
    path: 'mock/7',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-7.component').then((m) => m.LandingMock7Component),
    title: 'Mock 7: Neon Riot | DomDimaBot'
  },
  {
    path: 'mock/8',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-8.component').then((m) => m.LandingMock8Component),
    title: 'Mock 8: Sunset Hype | DomDimaBot'
  },
  {
    path: 'mock/9',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-9.component').then((m) => m.LandingMock9Component),
    title: 'Mock 9: Cosmic Pulse | DomDimaBot'
  },
  {
    path: 'mock/10',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-10.component').then((m) => m.LandingMock10Component),
    title: 'Mock 10: Grid Terminal | DomDimaBot'
  },
  {
    path: 'mock/11',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-11.component').then((m) => m.LandingMock11Component),
    title: 'Mock 11: Synth Console | DomDimaBot'
  },
  {
    path: 'mock/12',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-12.component').then((m) => m.LandingMock12Component),
    title: 'Mock 12: Abyss Terminal | DomDimaBot'
  },
  {
    path: 'mock/13',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-13.component').then((m) => m.LandingMock13Component),
    title: 'Mock 13: Refined Dark | DomDimaBot'
  },
  {
    path: 'mock/14',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-14.component').then((m) => m.LandingMock14Component),
    title: 'Mock 14: Quiet Control | DomDimaBot'
  },
  {
    path: 'mock/15',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-15.component').then((m) => m.LandingMock15Component),
    title: 'Mock 15: Operational Clarity | DomDimaBot'
  },
  {
    path: 'mock/16',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-16.component').then((m) => m.LandingMock16Component),
    title: 'Mock 16: Platform Pulse | DomDimaBot'
  },
  {
    path: 'mock/17',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-17.component').then((m) => m.LandingMock17Component),
    title: 'Mock 17: Live Network | DomDimaBot'
  },
  {
    path: 'mock/18',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-18.component').then((m) => m.LandingMock18Component),
    title: 'Mock 18: Global Metrics | DomDimaBot'
  },
  {
    path: 'mock/19',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-19.component').then((m) => m.LandingMock19Component),
    title: 'Mock 19: Editorial Spread | DomDimaBot'
  },
  {
    path: 'mock/20',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-20.component').then((m) => m.LandingMock20Component),
    title: 'Mock 20: Aurora Stream | DomDimaBot'
  },
  {
    path: 'mock/21',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-21.component').then((m) => m.LandingMock21Component),
    title: 'Mock 21: Brutalist Mesh | DomDimaBot'
  },
  {
    path: 'mock/22',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-22.component').then((m) => m.LandingMock22Component),
    title: 'Mock 22: Signal Ticker | DomDimaBot'
  },
  {
    path: 'mock/23',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-23.component').then((m) => m.LandingMock23Component),
    title: 'Mock 23: Constellation | DomDimaBot'
  },
  {
    path: 'mock/24',
    loadComponent: () =>
      import('./features/landing-mocks/landing-mock-24.component').then((m) => m.LandingMock24Component),
    title: 'Mock 24: Mission Control | DomDimaBot'
  },
  {
    path: 'mock/dashboard-23',
    loadComponent: () =>
      import('./features/landing-mocks/landing-dashboard-mock-23.component').then(
        (m) => m.LandingDashboardMock23Component
      ),
    title: 'Dashboard · Constellation | DomDimaBot'
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./features/auth/login-page.component').then((m) => m.LoginPageComponent),
    title: 'Login | DomDimaBot'
  },
  {
    path: 'r/:refCode',
    loadComponent: () =>
      import('./features/referral/referral-capture-page.component').then(
        (m) => m.ReferralCapturePageComponent
      ),
    title: 'Referral | DomDimaBot'
  },
  {
    path: 'commands/:streamer',
    component: PublicCommandsPageComponent,
    title: 'Commands | DomDimaBot'
  },
  {
    path: 'tip/:streamer',
    loadComponent: () =>
      import('./features/tip/tip-page.component').then((m) => m.TipPageComponent),
    title: 'Tip | DomDimaBot'
  },
  {
    path: '403',
    component: ForbiddenPageComponent,
    data: {
      previewPermission: 'settings:view'
    },
    title: '403 | DomDimaBot'
  },
  {
    path: '404',
    component: NotFoundPageComponent,
    title: '404 | DomDimaBot'
  },
  {
    path: 'mocks/grok',
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
          import('./features/landing-mocks/grok/grok-mock-index.component').then(
            (m) => m.GrokMockIndexComponent
          ),
        title: 'Grok Landing Mocks | DomDimaBot'
      },
      {
        path: '1',
        loadComponent: () =>
          import('./features/landing-mocks/grok/grok-mock-1.component').then(
            (m) => m.GrokMock1Component
          ),
        title: 'Split Studio · Grok Mock | DomDimaBot'
      },
      {
        path: '2',
        loadComponent: () =>
          import('./features/landing-mocks/grok/grok-mock-2.component').then(
            (m) => m.GrokMock2Component
          ),
        title: 'Night Signal · Grok Mock | DomDimaBot'
      },
      {
        path: '3',
        loadComponent: () =>
          import('./features/landing-mocks/grok/grok-mock-3.component').then(
            (m) => m.GrokMock3Component
          ),
        title: 'Warm Desk · Grok Mock | DomDimaBot'
      },
      // OpenCode mocks (design-skill explorations)
      {
        path: 'oc1',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/opencode-mock-1.component').then(
            (m) => m.OpencodeMock1Component
          ),
        title: 'Broadcast Brutal · OpenCode Mock | DomDimaBot'
      },
      {
        path: 'oc2',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/opencode-mock-2.component').then(
            (m) => m.OpencodeMock2Component
          ),
        title: 'Editorial Void · OpenCode Mock | DomDimaBot'
      },
      {
        path: 'oc3',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/opencode-mock-3.component').then(
            (m) => m.OpencodeMock3Component
          ),
        title: 'Command Bento · OpenCode Mock | DomDimaBot'
      },
      // Lineage of OC3 — Command Bento
      {
        path: 'oc3a',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/opencode-mock-3a.component').then(
            (m) => m.OpencodeMock3aComponent
          ),
        title: 'Night Deck · OpenCode OC3a | DomDimaBot'
      },
      {
        path: 'oc3b',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/opencode-mock-3b.component').then(
            (m) => m.OpencodeMock3bComponent
          ),
        title: 'Cream Studio · OpenCode OC3b | DomDimaBot'
      },
      {
        path: 'oc3c',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/opencode-mock-3c.component').then(
            (m) => m.OpencodeMock3cComponent
          ),
        title: 'Live First · OpenCode OC3c | DomDimaBot'
      },
      // Sol OpenCode landing explorations
      {
        path: 'soloc1',
        loadComponent: () =>
          import(
            './features/landing-mocks/grok/opencode/sol/sol-opencode-mock-1.component'
          ).then((m) => m.SolOpencodeMock1Component),
        title: 'Streamside Guide · Sol OpenCode Mock | DomDimaBot'
      },
      {
        path: 'soloc2',
        loadComponent: () =>
          import(
            './features/landing-mocks/grok/opencode/sol/sol-opencode-mock-2.component'
          ).then((m) => m.SolOpencodeMock2Component),
        title: 'Live Ops Grid · Sol OpenCode Mock | DomDimaBot'
      },
      {
        path: 'soloc3',
        loadComponent: () =>
          import(
            './features/landing-mocks/grok/opencode/sol/sol-opencode-mock-3.component'
          ).then((m) => m.SolOpencodeMock3Component),
        title: 'Channel 24 · Sol OpenCode Mock | DomDimaBot'
      },
      // OpenCode lineage of Mock 18 — Global Metrics
      {
        path: 'oc18a',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/lineage/opencode-18a.component').then(
            (m) => m.Opencode18aComponent
          ),
        title: 'Metric Terminal · OpenCode OC18a | DomDimaBot'
      },
      {
        path: 'oc18b',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/lineage/opencode-18b.component').then(
            (m) => m.Opencode18bComponent
          ),
        title: 'Paper Ops · OpenCode OC18b | DomDimaBot'
      },
      {
        path: 'oc18c',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/lineage/opencode-18c.component').then(
            (m) => m.Opencode18cComponent
          ),
        title: 'Signal Columns · OpenCode OC18c | DomDimaBot'
      },
      // OpenCode lineage of Mock 20 — Aurora Stream
      {
        path: 'oc20a',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/lineage/opencode-20a.component').then(
            (m) => m.Opencode20aComponent
          ),
        title: 'Prism Flow · OpenCode OC20a | DomDimaBot'
      },
      {
        path: 'oc20b',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/lineage/opencode-20b.component').then(
            (m) => m.Opencode20bComponent
          ),
        title: 'Mist Glass · OpenCode OC20b | DomDimaBot'
      },
      {
        path: 'oc20c',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/lineage/opencode-20c.component').then(
            (m) => m.Opencode20cComponent
          ),
        title: 'Coral Bloom · OpenCode OC20c | DomDimaBot'
      },
      // OpenCode lineage of Mock 23 — Constellation
      {
        path: 'oc23a',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/lineage/opencode-23a.component').then(
            (m) => m.Opencode23aComponent
          ),
        title: 'Star Lattice · OpenCode OC23a | DomDimaBot'
      },
      {
        path: 'oc23b',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/lineage/opencode-23b.component').then(
            (m) => m.Opencode23bComponent
          ),
        title: 'Observatory · OpenCode OC23b | DomDimaBot'
      },
      {
        path: 'oc23c',
        loadComponent: () =>
          import('./features/landing-mocks/grok/opencode/lineage/opencode-23c.component').then(
            (m) => m.Opencode23cComponent
          ),
        title: 'Core Pulse · OpenCode OC23c | DomDimaBot'
      },
      // Lineage of Mock 18 — Global Metrics (Grok)
      {
        path: '18a',
        loadComponent: () =>
          import('./features/landing-mocks/grok/lineage/grok-lineage-18a.component').then(
            (m) => m.GrokLineage18aComponent
          ),
        title: 'Pulse Board · Grok 18a | DomDimaBot'
      },
      {
        path: '18b',
        loadComponent: () =>
          import('./features/landing-mocks/grok/lineage/grok-lineage-18b.component').then(
            (m) => m.GrokLineage18bComponent
          ),
        title: 'Quiet Ledger · Grok 18b | DomDimaBot'
      },
      {
        path: '18c',
        loadComponent: () =>
          import('./features/landing-mocks/grok/lineage/grok-lineage-18c.component').then(
            (m) => m.GrokLineage18cComponent
          ),
        title: 'Focus Strip · Grok 18c | DomDimaBot'
      },
      // Lineage of Mock 20 — Aurora Stream
      {
        path: '20a',
        loadComponent: () =>
          import('./features/landing-mocks/grok/lineage/grok-lineage-20a.component').then(
            (m) => m.GrokLineage20aComponent
          ),
        title: 'Tide Glass · Grok 20a | DomDimaBot'
      },
      {
        path: '20b',
        loadComponent: () =>
          import('./features/landing-mocks/grok/lineage/grok-lineage-20b.component').then(
            (m) => m.GrokLineage20bComponent
          ),
        title: 'Soft Horizon · Grok 20b | DomDimaBot'
      },
      {
        path: '20c',
        loadComponent: () =>
          import('./features/landing-mocks/grok/lineage/grok-lineage-20c.component').then(
            (m) => m.GrokLineage20cComponent
          ),
        title: 'Bloom Panel · Grok 20c | DomDimaBot'
      },
      // Lineage of Mock 23 — Constellation
      {
        path: '23a',
        loadComponent: () =>
          import('./features/landing-mocks/grok/lineage/grok-lineage-23a.component').then(
            (m) => m.GrokLineage23aComponent
          ),
        title: 'Orbit Rings · Grok 23a | DomDimaBot'
      },
      {
        path: '23b',
        loadComponent: () =>
          import('./features/landing-mocks/grok/lineage/grok-lineage-23b.component').then(
            (m) => m.GrokLineage23bComponent
          ),
        title: 'Deep Catalog · Grok 23b | DomDimaBot'
      },
      {
        path: '23c',
        loadComponent: () =>
          import('./features/landing-mocks/grok/lineage/grok-lineage-23c.component').then(
            (m) => m.GrokLineage23cComponent
          ),
        title: 'Nebula Core · Grok 23c | DomDimaBot'
      },
      // MiniMax M3 mocks — three independent directions via OpenCode + UI/UX skill
      {
        path: 'm3-1',
        loadComponent: () =>
          import('./features/landing-mocks/grok/m3/m3-mock-1.component').then(
            (m) => m.M3Mock1Component
          ),
        title: 'Terminal Co-op · M3 Mock | DomDimaBot'
      },
      {
        path: 'm3-2',
        loadComponent: () =>
          import('./features/landing-mocks/grok/m3/m3-mock-2.component').then(
            (m) => m.M3Mock2Component
          ),
        title: 'Print Editorial · M3 Mock | DomDimaBot'
      },
      {
        path: 'm3-3',
        loadComponent: () =>
          import('./features/landing-mocks/grok/m3/m3-mock-3.component').then(
            (m) => m.M3Mock3Component
          ),
        title: 'Now Playing · M3 Mock | DomDimaBot'
      }
    ]
  },
  {
    path: ':streamer',
    canMatch: [streamerRouteShapeGuard],
    loadComponent: () =>
      import('./features/layout/authenticated-layout.component').then(
        (m) => m.AuthenticatedLayoutComponent
      ),
    canActivate: [validStreamerGuard, authenticatedGuard],
    title: 'Dashboard | DomDimaBot',
    children: [
      {
        path: '',
        pathMatch: 'full',
        redirectTo: 'dashboard'
      },
      {
        path: '403',
        component: ForbiddenPageComponent,
        data: {
          embeddedLayout: true
        },
        title: '403 | DomDimaBot'
      },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
        canActivate: [permissionGuard],
        data: {
          permission: 'dashboard:view'
        },
        title: 'Dashboard | DomDimaBot'
      },
      {
        path: 'commands',
        loadComponent: () =>
          import('./features/commands/commands-page.component').then((m) => m.CommandsPageComponent),
        canActivate: [permissionGuard],
        data: {
          permission: 'commands:view'
        },
        title: 'Commands | DomDimaBot'
      },
      {
        path: 'modules',
        children: [
          {
            path: '',
            pathMatch: 'full',
            loadComponent: () =>
              import('./features/modules/modules-page.component').then((m) => m.ModulesPageComponent),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'Modules | DomDimaBot'
          },
          {
            path: 'clips',
            loadComponent: () =>
              import('./features/clips/clips-page.component').then((m) => m.ClipsPageComponent),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'Clips | DomDimaBot'
          },
          {
            path: 'chat-events',
            loadComponent: () =>
              import('./features/chat-events/chat-events-page.component').then((m) => m.ChatEventsPageComponent),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
              title: 'Chat Events | DomDimaBot'
          },
          {
            path: 'triggers',
            loadComponent: () =>
              import('./features/triggers/triggers-page.component').then((m) => m.TriggersPageComponent),
            canActivate: [permissionGuard],
            data: {
              permission: 'triggers:view'
            },
            title: 'Triggers | DomDimaBot'
          },
          {
            path: 'dimafx',
            loadComponent: () =>
              import('./features/dimafx/dimafx-page.component').then((m) => m.DimafxPageComponent),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'DimaFX | DomDimaBot'
          },
          {
            path: 'ai-personality',
            loadComponent: () =>
              import('./features/ai-personality/ai-personality-page.component').then(
                (m) => m.AiPersonalityPageComponent
              ),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'AI Personality | DomDimaBot'
          },
          {
            path: 'memories',
            loadComponent: () =>
              import('./features/memories/memories-page.component').then(
                (m) => m.MemoriesPageComponent
              ),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'Memories | DomDimaBot'
          },
          {
            path: 'analytics',
            children: [
              {
                path: '',
                pathMatch: 'full',
                loadComponent: () =>
                  import('./features/analytics/analytics-hub-page.component').then(
                    (m) => m.AnalyticsHubPageComponent
                  ),
                canActivate: [permissionGuard],
                data: {
                  permission: 'dashboard:view'
                },
                title: 'Analytics | DomDimaBot'
              },
              {
                path: 'follows',
                loadComponent: () =>
                  import('./features/analytics/follow-ledger-page.component').then(
                    (m) => m.FollowLedgerPageComponent
                  ),
                canActivate: [permissionGuard],
                data: {
                  permission: 'dashboard:view'
                },
                title: 'Follow Ledger | DomDimaBot'
              }
            ]
          },
          {
            path: 'referrals',
            loadComponent: () =>
              import('./features/referrals/referrals-page.component').then((m) => m.ReferralsPageComponent),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'Referrals | DomDimaBot'
          },
          {
            path: 'redemptions',
            loadComponent: () =>
              import('./features/redemptions/redemptions-page.component').then((m) => m.RedemptionsPageComponent),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'Redemptions | DomDimaBot'
          },
          {
            path: 'tts',
            loadComponent: () =>
              import('./features/tts/tts-page.component').then((m) => m.TtsPageComponent),
            canActivate: [permissionGuard],
            data: {
              permission: 'settings:view'
            },
            title: 'Text to Speech | DomDimaBot'
          },
          {
            path: 'follow-defense',
            loadComponent: () =>
              import('./features/follow-defense/follow-defense-page.component').then(
                (m) => m.FollowDefensePageComponent
              ),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'Follow Defense | DomDimaBot'
          },
          {
            path: 'stream-summaries',
            loadComponent: () =>
              import('./features/stream-summaries/stream-summaries-page.component').then(
                (m) => m.StreamSummariesPageComponent
              ),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'Stream Summaries | DomDimaBot'
          },
          {
            path: 'clip-recommendations',
            loadComponent: () =>
              import('./features/clip-recommendations/clip-recommendations-page.component').then(
                (m) => m.ClipRecommendationsPageComponent
              ),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'Clip Recommendations | DomDimaBot'
          },
          {
            path: 'library',
            loadComponent: () =>
              import('./features/library/media-library-page.component').then((m) => m.MediaLibraryPageComponent),
            canActivate: [permissionGuard],
            data: {
              permission: 'dashboard:view'
            },
            title: 'Media Library | DomDimaBot'
          }
        ]
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/settings/settings-page.component').then((m) => m.SettingsPageComponent),
        canActivate: [permissionGuard],
        data: {
          permission: 'settings:view'
        },
        title: 'Settings | DomDimaBot'
      },
      {
        path: 'admin-hub',
        loadComponent: () =>
          import('./features/admin-hub/admin-hub-page.component').then((m) => m.AdminHubPageComponent),
        canActivate: [permissionGuard],
        data: {
          permission: 'dashboard:view'
        },
        title: 'Admin Hub | DomDimaBot'
      },
      {
        path: 'profile',
        loadComponent: () =>
          import('./features/profile/profile-page.component').then((m) => m.ProfilePageComponent),
        canActivate: [permissionGuard],
        data: {
          permission: 'settings:view'
        },
        title: 'Profile | DomDimaBot'
      }
    ]
  },
  {
    path: '**',
    redirectTo: '404'
  }
];
