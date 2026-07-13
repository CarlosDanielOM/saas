import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild
} from '@angular/core';
import {
  RouterLink,
  RouterLinkActive,
  RouterOutlet
} from '@angular/router';
import { LucideAngularModule, Moon, Sun, UserRound } from 'lucide-angular';

import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';

const LIVE_API = 'https://api.domdimabot.com';
const CHANNEL_LOGIN = 'cdom201';

@Component({
  selector: 'app-dev-mock-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, LucideAngularModule],
  templateUrl: './dev-mock-shell.component.html',
  styleUrl: './dev-mock-shell.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DevMockShellComponent {
  private readonly themeService = inject(ThemeService);
  private readonly languageService = inject(LanguageService);
  private readonly profileMenu = viewChild<ElementRef<HTMLElement>>('profileMenu');

  readonly sunIcon = Sun;
  readonly moonIcon = Moon;
  readonly userIcon = UserRound;

  readonly profileOpen = signal(false);
  readonly avatarUrl = signal('');
  readonly displayName = signal('CDOM201');
  readonly avatarLetter = signal('C');

  constructor() {
    void this.loadProfile();
  }

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  languageLabel(): string {
    return this.languageService.currentLanguage() === 'en' ? 'English · ES' : 'Español · EN';
  }

  toggleProfileMenu(event: Event): void {
    event.stopPropagation();
    this.profileOpen.update((open) => !open);
  }

  closeProfileMenu(): void {
    this.profileOpen.set(false);
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  toggleLanguage(): void {
    this.languageService.toggleLanguage();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.profileOpen()) {
      return;
    }
    const menu = this.profileMenu()?.nativeElement;
    const target = event.target;
    if (!(target instanceof Node) || !menu?.contains(target)) {
      this.closeProfileMenu();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeProfileMenu();
  }

  private async loadProfile(): Promise<void> {
    try {
      const res = await fetch(`${LIVE_API}/users?username=${CHANNEL_LOGIN}`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        data?: { display_name?: string; profile_image_url?: string };
      };
      const data = body.data;
      if (!data) return;
      const name = data.display_name || CHANNEL_LOGIN;
      this.displayName.set(name);
      this.avatarLetter.set(name.slice(0, 1).toUpperCase());
      if (data.profile_image_url) {
        this.avatarUrl.set(data.profile_image_url);
      }
    } catch {
      // keep fallbacks
    }
  }
}
