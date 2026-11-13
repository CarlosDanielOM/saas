import { ChangeDetectionStrategy, Component, computed, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DecisionsExplorerComponent } from '../../shared/decisions/decisions-explorer.component';
import { IconComponent } from '../../shared/icon/icon.component';

/** Every chat protection decision across all channels: what it decided, whether it was right, what it cost. */
@Component({
  selector: 'app-decisions-page',
  templateUrl: './decisions-page.component.html',
  styleUrl: './decisions-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, DecisionsExplorerComponent],
})
export class DecisionsPageComponent {
  readonly explorer = viewChild.required(DecisionsExplorerComponent);
  readonly waiting = computed(() => this.explorer().summary()?.verdictsWaiting ?? 0);
  readonly loading = computed(() => this.explorer().loading());
}
