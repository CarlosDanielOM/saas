import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { IconComponent } from '../icon/icon.component';
import { isAdmin } from '../../config/admin-whitelist';

@Component({
  selector: 'app-navbar',
  templateUrl: './navbar.component.html',
  styleUrl: './navbar.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
})
export class NavbarComponent {
  private readonly router = inject(Router);
  private readonly sessionAuth = inject(SessionAuthService);
  readonly theme = inject(ThemeService);
  readonly user = computed(() => this.sessionAuth.getSessionSnapshot()?.twitchUser);
  readonly admin = computed(() => isAdmin(this.user()?.id || ''));
  readonly home = computed(() => this.admin() ? '/dashboard' : '/observability');
  readonly accountOpen = signal(false);
  private readonly currentPath = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects.split('?')[0]),
    ),
    { initialValue: this.router.url.split('?')[0] },
  );
  isActive(route: string): boolean {
    const path = this.currentPath();
    switch (route) {
      case '/dashboard':
        return path === '/dashboard' || path === '/analytics';
      case '/activity':
        return path === '/activity';
      case '/ai':
        return path === '/ai' || path.startsWith('/ai/') || path === '/moderation-review' || path === '/assistant-refusals';
      case '/users':
        return path === '/users' || path.startsWith('/channels/');
      default:
        return path === route;
    }
  }

  // Five tabs fit a 320px phone with readable labels. Rarely used tools live in the account menu.
  readonly navItems = computed(() => this.admin() ? [
    { label: 'Overview', route: '/dashboard', icon: 'overview' },
    { label: 'Activity', route: '/activity', icon: 'pulse' },
    { label: 'AI', route: '/ai', icon: 'sparkles' },
    { label: 'Users', route: '/users', icon: 'users' },
    { label: 'System', route: '/observability', icon: 'chart' },
  ] : [{ label: 'Analytics', route: '/observability', icon: 'chart' }]);
  @HostListener('document:keydown.escape') closeAccount(): void {
    this.accountOpen.set(false);
  }
  logout(): void {
    this.sessionAuth.clearSession();
    void this.router.navigate(['/login']);
  }
}
