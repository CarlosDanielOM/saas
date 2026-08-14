import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LucideAngularModule, Moon, Sun } from 'lucide-angular';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

import { ThemeService } from '../../../services/theme.service';

export type ErrorMockCode = '404' | '403' | '500' | '503';

export interface ErrorMockData {
  code: ErrorMockCode;
  kicker: string;
  title: string;
  copy: string;
  embedded?: boolean;
  permission?: string;
  fromPath?: string;
  primaryLabel: string;
  primaryLink: string;
  secondaryLabel: string;
  secondaryLink: string;
}

const PRESETS: Record<ErrorMockCode, Omit<ErrorMockData, 'code' | 'embedded' | 'permission' | 'fromPath'>> = {
  '404': {
    kicker: 'Lost signal',
    title: 'This page isn’t on the map',
    copy: 'The route doesn’t exist, or that channel couldn’t be found. Double-check the URL or head back to somewhere familiar.',
    primaryLabel: 'Go to dashboard',
    primaryLink: '/mocks/dev/prod-dashboard',
    secondaryLabel: 'Back home',
    secondaryLink: '/'
  },
  '403': {
    kicker: 'Access denied',
    title: 'You don’t have permission here',
    copy: 'This area needs a role or plan you don’t currently have on this channel. Ask the owner, or open a page you can manage.',
    primaryLabel: 'Open dashboard',
    primaryLink: '/mocks/dev/prod-dashboard',
    secondaryLabel: 'Back home',
    secondaryLink: '/'
  },
  '500': {
    kicker: 'Server hiccup',
    title: 'Something broke on our side',
    copy: 'We hit an unexpected error. Your channel data is safe — try again in a moment. If it keeps happening, ping support.',
    primaryLabel: 'Try again',
    primaryLink: '.',
    secondaryLabel: 'Back home',
    secondaryLink: '/'
  },
  '503': {
    kicker: 'Temporarily offline',
    title: 'We’re catching our breath',
    copy: 'DomDimaBot is unavailable right now — maintenance or heavy load. Check back shortly; status updates land on the usual channels.',
    primaryLabel: 'Refresh',
    primaryLink: '.',
    secondaryLabel: 'Back home',
    secondaryLink: '/'
  }
};

@Component({
  selector: 'app-lf-error-mock',
  imports: [RouterLink, LucideAngularModule],
  templateUrl: './lf-error-mock.component.html',
  styleUrl: './lf-error-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LfErrorMockComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly themeService = inject(ThemeService);

  readonly sunIcon = Sun;
  readonly moonIcon = Moon;

  private readonly routeData = toSignal(
    this.route.data.pipe(
      map((d) => ({
        code: (d['code'] as ErrorMockCode) || '404',
        embedded: Boolean(d['embedded']),
        permission: (d['permission'] as string) || '',
        fromPath: (d['fromPath'] as string) || ''
      }))
    ),
    {
      initialValue: {
        code: '404' as ErrorMockCode,
        embedded: false,
        permission: '',
        fromPath: ''
      }
    }
  );

  readonly model = computed<ErrorMockData>(() => {
    const r = this.routeData();
    const base = PRESETS[r.code] ?? PRESETS['404'];
    return {
      code: r.code,
      embedded: r.embedded,
      permission: r.permission || (r.code === '403' ? 'settings:view' : ''),
      fromPath: r.fromPath || (r.code === '403' ? '/cdom201/settings' : r.code === '404' ? '/nope/page' : ''),
      ...base
    };
  });

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  codeTone(): string {
    const c = this.model().code;
    if (c === '403') return 'warn';
    if (c === '500' || c === '503') return 'danger';
    return 'muted';
  }
}
