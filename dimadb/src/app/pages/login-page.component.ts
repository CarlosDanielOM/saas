import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-login-page',
  imports: [RouterLink],
  templateUrl: './login-page.component.html',
  styleUrl: './auth-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPageComponent {}
