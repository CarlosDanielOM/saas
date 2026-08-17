import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellComponent {
  readonly nav = [
    { label: 'Browse', route: '/browse', icon: 'browse' },
    { label: 'Console', route: '/console', icon: 'console' },
    { label: 'Connections', route: '/connections', icon: 'plug' },
    { label: 'Account', route: '/account', icon: 'user' },
  ] as const;
}
