import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { LanguageService } from '../../services/language.service';

@Component({
  selector: 'app-profile-page',
  templateUrl: './profile-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfilePageComponent {
  protected readonly languageService = inject(LanguageService);

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
