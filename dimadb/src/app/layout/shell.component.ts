import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { ConnectionsService } from '../services/connections.service';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellComponent {
  readonly connections = inject(ConnectionsService);

  readonly nav = [
    { label: 'Browse', route: '/browse', icon: 'browse' },
    { label: 'Console', route: '/console', icon: 'console' },
    { label: 'Connections', route: '/connections', icon: 'plug' },
    { label: 'Account', route: '/account', icon: 'user' },
  ] as const;

  constructor() {
    void this.connections.load().catch(() => undefined);
  }

  onSelect(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value) {
      this.connections.select(value);
    }
  }
}
