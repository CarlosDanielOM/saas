import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LucideAngularModule, Moon, Sun } from 'lucide-angular';
import { map } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { ThemeService } from '../../services/theme.service';

type StatusCode = '500' | '503';

@Component({
  selector: 'app-status-error-page',
  imports: [RouterLink, LucideAngularModule],
  templateUrl: './status-error-page.component.html',
  styleUrl: './status-error-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StatusErrorPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly themeService = inject(ThemeService);

  readonly sunIcon = Sun;
  readonly moonIcon = Moon;

  private readonly code = toSignal(
    this.route.data.pipe(map((d) => ((d['code'] as StatusCode) || '500'))),
    { initialValue: '500' as StatusCode }
  );

  readonly statusCode = computed(() => this.code());
  readonly ns = computed(() => (this.statusCode() === '503' ? 'status503' : 'status500'));

  t(key: string, params?: Record<string, string | number>): string {
    this.languageService.currentLanguage();
    return this.languageService.translate(key, params);
  }

  tk(suffix: string): string {
    return this.t(`${this.ns()}.${suffix}`);
  }

  languageLabel(): string {
    return this.languageService.currentLanguage() === 'en' ? 'English · ES' : 'Español · EN';
  }

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  toggleLanguage(): void {
    this.languageService.toggleLanguage();
  }

  reload(): void {
    window.location.reload();
  }
}
