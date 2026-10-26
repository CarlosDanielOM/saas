import { ChangeDetectionStrategy, Component } from '@angular/core';
import { DimaAppDownloadsComponent } from './dima-app-downloads.component';

/** Account utility hosted by the existing authenticated layout and parent guards. */
@Component({
  selector: 'app-desktop-module',
  imports: [DimaAppDownloadsComponent],
  template: '<app-dima-app-downloads [embedded]="true" />',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppModuleComponent {}
