import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { LanguageService } from '../../services/language.service';

@Component({
  selector: 'app-modules-page',
  templateUrl: './modules-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ModulesPageComponent {
  protected readonly languageService = inject(LanguageService);

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
