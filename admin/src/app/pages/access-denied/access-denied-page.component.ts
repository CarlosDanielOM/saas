import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { SessionAuthService } from '../../services/session-auth.service';
import { IconComponent } from '../../shared/icon/icon.component';
import { isAdmin } from '../../config/admin-whitelist';

@Component({
  selector: 'app-access-denied-page',
  templateUrl: './access-denied-page.component.html',
  styleUrl: '../auth-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RouterLink],
})
export class AccessDeniedPageComponent {
  private readonly router = inject(Router);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly route = inject(ActivatedRoute);
  readonly analytics = this.route.snapshot.queryParamMap.get('area') === 'analytics';
  readonly unavailable = this.analytics && this.route.snapshot.queryParamMap.get('unavailable') === 'true';
  readonly admin = isAdmin(this.sessionAuth.getSessionSnapshot()?.twitchUser.id || '');

  logout(): void {
    this.sessionAuth.clearSession();
    void this.router.navigate(['/login']);
  }

  goHome(): void {
    window.location.href = 'https://domdimabot.com';
  }
}
