import { Routes } from '@angular/router';

import { adminAuthGuard } from './guards/admin-auth.guard';
import { LayoutComponent } from './features/layout/layout.component';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'dashboard',
    pathMatch: 'full'
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login/login-page.component').then((m) => m.LoginPageComponent),
    title: 'Login | DimaBot Admin'
  },
  {
    path: 'access-denied',
    loadComponent: () =>
      import('./pages/access-denied/access-denied-page.component').then((m) => m.AccessDeniedPageComponent),
    title: 'Access Denied | DimaBot Admin'
  },
  {
    path: '',
    component: LayoutComponent,
    canActivate: [adminAuthGuard],
    children: [
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./pages/dashboard/dashboard-page.component').then((m) => m.DashboardPageComponent),
        title: 'Dashboard | DimaBot Admin'
      },
      {
        path: 'users',
        loadComponent: () =>
          import('./pages/users/users-page.component').then((m) => m.UsersPageComponent),
        title: 'Users | DimaBot Admin'
      },
      {
        path: 'channels/:channelID',
        loadComponent: () =>
          import('./pages/channel/channel-detail.component').then((m) => m.ChannelDetailComponent),
        title: 'Channel | DimaBot Admin'
      },
      {
        path: 'channels/:channelID/eventsubs',
        loadComponent: () =>
          import('./pages/channel/channel-eventsubs.component').then((m) => m.ChannelEventsubsComponent),
        title: 'Channel Eventsubs | DimaBot Admin'
      },
      {
        path: 'channels/:channelID/commands',
        loadComponent: () =>
          import('./pages/channel/channel-commands.component').then((m) => m.ChannelCommandsComponent),
        title: 'Channel Commands | DimaBot Admin'
      },
      {
        path: 'analytics',
        loadComponent: () =>
          import('./pages/dashboard/dashboard-page.component').then((m) => m.DashboardPageComponent),
        title: 'Analytics | DimaBot Admin'
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./pages/dashboard/dashboard-page.component').then((m) => m.DashboardPageComponent),
        title: 'Settings | DimaBot Admin'
      },
      {
        path: 'read-tool',
        loadComponent: () =>
          import('./pages/read-tool/read-tool-page.component').then((m) => m.ReadToolPageComponent),
        title: 'Read Tool | DimaBot Admin'
      },
      {
        path: 'email-test',
        loadComponent: () =>
          import('./pages/email-test/email-test-page.component').then((m) => m.EmailTestPageComponent),
        title: 'Email Test | DimaBot Admin'
      }
    ]
  },
  {
    path: '**',
    redirectTo: 'dashboard'
  }
];