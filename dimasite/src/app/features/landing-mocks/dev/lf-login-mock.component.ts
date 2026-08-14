import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Moon, Sun } from 'lucide-angular';

import { ThemeService } from '../../../services/theme.service';

type LoginStage = 'idle' | 'loading' | 'error';

interface LogLine {
  t: string;
  msg: string;
}

@Component({
  selector: 'app-lf-login-mock',
  imports: [RouterLink, LucideAngularModule],
  templateUrl: './lf-login-mock.component.html',
  styleUrl: './lf-login-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LfLoginMockComponent {
  private readonly themeService = inject(ThemeService);

  readonly sunIcon = Sun;
  readonly moonIcon = Moon;

  readonly stage = signal<LoginStage>('idle');
  readonly showLog = signal(true);
  readonly progress = signal(42);

  readonly logLines = signal<LogLine[]>([
    { t: '12:04:01', msg: 'Opening Twitch OAuth…' },
    { t: '12:04:03', msg: 'Code received · exchanging session' },
    { t: '12:04:04', msg: 'Syncing channel permissions' },
    { t: '12:04:05', msg: 'Resolving primary dashboard' }
  ]);

  readonly stageLabel = computed(() => {
    switch (this.stage()) {
      case 'loading':
        return 'Signing you in…';
      case 'error':
        return 'Something went wrong';
      default:
        return 'Continue with Twitch';
    }
  });

  setStage(next: LoginStage): void {
    this.stage.set(next);
    if (next === 'loading') {
      this.progress.set(48);
      this.showLog.set(true);
    }
  }

  toggleLog(): void {
    this.showLog.update((v) => !v);
  }

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }
}
