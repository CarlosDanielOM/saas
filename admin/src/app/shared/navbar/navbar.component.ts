import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

import { SessionAuthService } from '../../services/session-auth.service';

interface NavItem {
  label: string;
  route: string;
  icon: string;
}

@Component({
  selector: 'app-navbar',
  templateUrl: './navbar.component.html',
  styleUrl: './navbar.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive]
})
export class NavbarComponent {
  private readonly router = inject(Router);
  private readonly sessionAuth = inject(SessionAuthService);

  readonly user = computed(() => this.sessionAuth.getSessionSnapshot()?.twitchUser);
  readonly isMenuOpen = signal(false);

  readonly navItems: NavItem[] = [
    { label: 'Dashboard', route: '/dashboard', icon: 'home' },
    { label: 'Users', route: '/users', icon: 'users' },
    { label: 'Analytics', route: '/analytics', icon: 'chart' },
    { label: 'Settings', route: '/settings', icon: 'settings' },
  ];

  toggleMenu(): void {
    this.isMenuOpen.update(open => !open);
  }

  closeMenu(): void {
    this.isMenuOpen.set(false);
  }

  logout(): void {
    this.sessionAuth.clearSession();
    void this.router.navigate(['/login']);
  }
}