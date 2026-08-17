import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-browse-page',
  imports: [RouterLink],
  templateUrl: './browse-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowsePageComponent {
  readonly keys = [
    { name: 'overlay:active:123456', type: 'string', ttl: '12m', size: '1' },
    { name: 'chat:history:miyu', type: 'list', ttl: '—', size: '240' },
    { name: 'user:session:dom', type: 'hash', ttl: '3h', size: '8f' },
    { name: 'timers:queue', type: 'zset', ttl: '—', size: '17' },
    { name: 'follow:defense:seen', type: 'set', ttl: '6h', size: '84' },
  ];
}
