import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { LinksService } from '../../services/links.service';
import { ToastService } from '../../shared/toast/toast.service';
import { IconComponent } from '../../shared/icon/icon.component';

const RECENT_KEY = 'dima-admin.recent-files.v1';
/** Mirrors ALLOWED_BASE_PATHS in dimabot admin-tools.route.ts. */
export const READABLE_ROOTS = ['/home/cdom/saas/dimabot/', '/home/cdom/saas/admin/'];

function readRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

@Component({
  selector: 'app-read-tool-page',
  templateUrl: './read-tool-page.component.html',
  styleUrl: './read-tool-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
})
export class ReadToolPageComponent {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly toast = inject(ToastService);

  readonly roots = READABLE_ROOTS;
  readonly filePath = signal('');
  readonly shownPath = signal('');
  readonly fileContent = signal<string | null>(null);
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly wrap = signal(true);
  readonly recent = signal<string[]>(readRecent());
  readonly lineCount = computed(() => {
    const content = this.fileContent();
    return content ? content.replace(/\n$/, '').split('\n').length : 0;
  });

  async readFile(path = this.filePath()): Promise<void> {
    path = path.trim();
    this.filePath.set(path);
    if (!path) {
      this.error.set('Please enter a file path');
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);
    this.fileContent.set(null);

    try {
      // HttpClient so the admin session token is attached (the endpoint requires auth).
      const envelope = await firstValueFrom(
        this.http.get<{ error: boolean; message?: string; data?: { content: string } }>(
          `${this.links.getApiUrl()}/admin/read-file`,
          { params: { path } },
        ),
      );
      if (envelope.error) {
        this.error.set(envelope.message || "Couldn't read that file");
        return;
      }
      this.fileContent.set(envelope.data?.content || '');
      this.shownPath.set(path);
      this.remember(path);
    } catch (err) {
      const response = err as { error?: { message?: string }; message?: string };
      this.error.set(response?.error?.message || response?.message || "Couldn't read that file");
    } finally {
      this.isLoading.set(false);
    }
  }

  useRoot(root: string): void {
    this.filePath.set(root);
  }

  forget(path: string): void {
    this.recent.update((list) => list.filter((p) => p !== path));
    this.saveRecent();
  }

  async copyContent(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.fileContent() ?? '');
      this.toast.success('File contents copied');
    } catch {
      this.toast.error('Could not copy — select the text and copy it manually');
    }
  }

  private remember(path: string): void {
    this.recent.update((list) => [path, ...list.filter((p) => p !== path)].slice(0, 6));
    this.saveRecent();
  }

  private saveRecent(): void {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent()));
    } catch {
      /* Recents are a convenience only. */
    }
  }
}
