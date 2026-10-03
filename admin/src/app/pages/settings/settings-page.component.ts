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
  readonly modeIcons: Record<string, string> = { system: 'monitor', light: 'sun', dark: 'moon' };
  readonly summary = computed(() => {
    const mode = this.theme.modes.find((option) => option.id === this.theme.mode())!.name;
    const accent = this.theme.accents.find((option) => option.id === this.theme.accent())!.name;
    return `${mode} · ${accent}`;
  });
}
