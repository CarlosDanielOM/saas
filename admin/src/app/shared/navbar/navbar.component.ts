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
import { IconComponent } from '../icon/icon.component';

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
  readonly user = computed(() => this.sessionAuth.getSessionSnapshot()?.twitchUser);
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
    return (
      path === route ||
      (route === '/users' && path.startsWith('/channels/')) ||
      (route === '/dashboard' && path === '/analytics')
    );
  }

  readonly navItems = [
    { label: 'Overview', route: '/dashboard', icon: 'overview' },
    { label: 'Users', route: '/users', icon: 'users' },
    { label: 'Files', route: '/read-tool', icon: 'files' },
    { label: 'Email', route: '/email-test', icon: 'mail' },
  ];
  @HostListener('document:keydown.escape') closeAccount(): void {
    this.accountOpen.set(false);
  }
  logout(): void {
    this.sessionAuth.clearSession();
    void this.router.navigate(['/login']);
  }
}
