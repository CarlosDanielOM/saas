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
