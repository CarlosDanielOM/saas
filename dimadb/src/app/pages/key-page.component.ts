import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

@Component({
  selector: 'app-key-page',
  imports: [RouterLink],
  templateUrl: './key-page.component.html',
  styleUrl: './pages-shared.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly query = toSignal(this.route.queryParamMap.pipe(map((q) => q)), {
    initialValue: this.route.snapshot.queryParamMap,
  });

  readonly key = computed(() => this.query().get('k') || 'overlay:active:123456');
  readonly type = computed(() => this.query().get('t') || 'string');
}
