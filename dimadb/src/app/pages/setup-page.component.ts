import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-setup-page',
  imports: [RouterLink],
  templateUrl: './setup-page.component.html',
  styleUrl: './auth-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupPageComponent {}
