import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-read-tool-page',
  templateUrl: './read-tool-page.component.html',
  styleUrl: './read-tool-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DecimalPipe]
})
export class ReadToolPageComponent {
  readonly filePath = signal('');
  readonly fileContent = signal<string | null>(null);
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);

  async readFile(): Promise<void> {
    const path = this.filePath().trim();
    if (!path) {
      this.error.set('Please enter a file path');
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);
    this.fileContent.set(null);

    try {
      const response = await fetch(`${environment.DIMA_API}/admin/read-file?path=${encodeURIComponent(path)}`);
      const envelope = await response.json() as { error: boolean; message?: string; data?: { content: string } };

      if (envelope.error) {
        this.error.set(envelope.message || 'Failed to read file');
        return;
      }

      this.fileContent.set(envelope.data?.content || '');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      this.isLoading.set(false);
    }
  }
}