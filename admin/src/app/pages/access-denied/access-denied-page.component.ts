import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { SessionAuthService } from '../../services/session-auth.service';

@Component({
  selector: 'app-access-denied-page',
  templateUrl: './access-denied-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: []
})
export class AccessDeniedPageComponent {
  private readonly router = inject(Router);
  private readonly sessionAuth = inject(SessionAuthService);

  logout(): void {
    this.sessionAuth.clearSession();
    void this.router.navigate(['/login']);
  }

  goHome(): void {
    window.location.href = 'https://domdimabot.com';
  }
}