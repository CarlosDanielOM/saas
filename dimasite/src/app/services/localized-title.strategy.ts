import { Injectable, effect, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

import { LanguageService } from './language.service';

@Injectable()
export class LocalizedTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly language = inject(LanguageService);
  private readonly routeTitle = signal<string | undefined>(undefined);

  constructor() {
    super();
    effect(() => {
      const routeTitle = this.routeTitle();
      // Track language even for a title that has not changed since navigation.
      this.language.currentLanguage();
      if (routeTitle) this.applyTitle(routeTitle);
    });
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const routeTitle = this.buildTitle(snapshot);
    this.routeTitle.set(routeTitle);
    if (routeTitle) this.applyTitle(routeTitle);
  }

  private applyTitle(routeTitle: string): void {
    if (!routeTitle.startsWith('pageTitles.')) {
      this.title.setTitle(routeTitle);
      return;
    }
    const translated = this.language.translate(routeTitle);
    this.title.setTitle(routeTitle === 'pageTitles.landing' ? translated : `${translated} | DomDimaBot`);
  }
}
