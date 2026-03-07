import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { LanguageService } from '../../services/language.service';

@Component({
  selector: 'app-settings-page',
  template: `
    <section class="placeholder-page">
      <h1>{{ t('settings.title') }}</h1>
      <p>{{ t('settings.subtitle') }}</p>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsPageComponent {
  private readonly languageService = inject(LanguageService);

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
