import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-connections-page',
  templateUrl: './connections-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectionsPageComponent {
  readonly connections = [
    { name: 'Dragonfly', source: 'env', url: 'redis://dragonfly:6379', ok: true },
    { name: 'Local cache', source: 'local', url: 'redis://127.0.0.1:6379', ok: false },
  ];
}
