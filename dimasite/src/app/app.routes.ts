import { Routes } from '@angular/router';

import { authenticatedGuard } from './guards/authenticated.guard';
import { permissionGuard } from './guards/permission.guard';

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
    path: ':streamer',
    loadComponent: () =>
      import('./features/layout/authenticated-layout.component').then(
        (m) => m.AuthenticatedLayoutComponent
      ),
    canActivate: [authenticatedGuard],
    title: 'Dashboard | DomDimaBot',
    children: [
      {
        path: '',
        pathMatch: 'full',
        redirectTo: 'dashboard'
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
        loadComponent: () =>
          import('./features/modules/modules-page.component').then((m) => m.ModulesPageComponent),
        canActivate: [permissionGuard],
        data: {
          permission: 'dashboard:view'
        },
        title: 'Modules | DomDimaBot'
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
    redirectTo: ''
  }
];
