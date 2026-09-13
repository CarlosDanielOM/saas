import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ThemeService } from '../../services/theme.service';
import { IconComponent } from '../../shared/icon/icon.component';

@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.css',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPageComponent {
  readonly theme = inject(ThemeService);
  readonly selectedName = computed(
    () => this.theme.themes.find((option) => option.id === this.theme.selected())!.name,
  );
}
