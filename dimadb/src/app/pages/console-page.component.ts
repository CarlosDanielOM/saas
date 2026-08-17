import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-console-page',
  templateUrl: './console-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsolePageComponent {}
