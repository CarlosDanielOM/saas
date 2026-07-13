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
      // Lineage of Mock 18 — Global Metrics
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
