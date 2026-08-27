import { Routes } from '@angular/router';

import { authGuard, guestGuard, setupGuard } from './guards/auth.guard';
import { ShellComponent } from './layout/shell.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'browse' },
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/login-page.component').then((m) => m.LoginPageComponent),
    title: 'Login | dimadb',
  },
  {
    path: 'setup',
    canActivate: [setupGuard],
    loadComponent: () => import('./pages/setup-page.component').then((m) => m.SetupPageComponent),
    title: 'Setup | dimadb',
  },
  {
    path: '',
    component: ShellComponent,
    canActivate: [authGuard],
    children: [
      {
        path: 'browse',
        loadComponent: () => import('./pages/browse-page.component').then((m) => m.BrowsePageComponent),
        title: 'Browse | dimadb',
      },
      {
        path: 'key',
        loadComponent: () => import('./pages/key-page.component').then((m) => m.KeyPageComponent),
        title: 'Key | dimadb',
      },
      {
        path: 'doc',
        loadComponent: () => import('./pages/doc-page.component').then((m) => m.DocPageComponent),
        title: 'Document | dimadb',
      },
      {
        path: 'console',
        loadComponent: () => import('./pages/console-page.component').then((m) => m.ConsolePageComponent),
        title: 'Console | dimadb',
      },
      {
        path: 'connections',
        loadComponent: () => import('./pages/connections-page.component').then((m) => m.ConnectionsPageComponent),
        title: 'Connections | dimadb',
      },
      {
        path: 'account',
        loadComponent: () => import('./pages/account-page.component').then((m) => m.AccountPageComponent),
        title: 'Account | dimadb',
      },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
