import {
  ChangeDetectionStrategy,
  Component,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-email-test-page',
  templateUrl: './email-test-page.component.html',
  styleUrl: './email-test-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule]
})
export class EmailTestPageComponent {
  readonly emailType = signal<'welcome' | 'activation-reminder' | 'stream-summary'>('welcome');
  readonly language = signal<'en' | 'es'>('en');
  readonly theme = signal<'light' | 'dark'>('dark');
  readonly recipientEmail = signal('');
  readonly isLoading = signal(false);
  readonly result = signal<{ success: boolean; message: string } | null>(null);
  // When testing activation-reminder, the backend returns the activation link that feeds the standardized pendingActionsQueue on the public site.
  readonly activationLink = signal<string | null>(null);
  readonly copyFeedback = signal<string | null>(null);

  readonly emailTypes = [
    { value: 'welcome', label: 'Welcome' },
    { value: 'activation-reminder', label: 'Reminder' },
    { value: 'stream-summary', label: 'Summary' }
  ];

  readonly languages = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' }
  ];

  readonly themes = [
    { value: 'light', label: 'Light Mode' },
    { value: 'dark', label: 'Dark Mode' }
  ];

  async sendTestEmail(): Promise<void> {
    const email = this.recipientEmail().trim();
    if (!email) {
      this.result.set({ success: false, message: 'Please enter a recipient email' });
      return;
    }

    this.isLoading.set(true);
    this.result.set(null);

    // Clear previous activation link before sending
    this.activationLink.set(null);
    this.copyFeedback.set(null);

    try {
      const response = await fetch(
        `${environment.DIMA_API}/email/test?type=${this.emailType()}&to=${encodeURIComponent(email)}&lang=${this.language()}&theme=${this.theme()}`
      );
      const envelope = await response.json() as { error: boolean; message?: string; data?: any };

      if (envelope.error) {
        this.result.set({ success: false, message: envelope.message || 'Failed to send email' });
      } else {
        this.result.set({ success: true, message: 'Email sent successfully!' });

        // Hook into the new standardized pendingActionsQueue system:
        // For activation-reminder emails, the backend now returns the real activation link
        // that goes through /email/auth and feeds the pendingActionsQueue (toast / redirect actions).
        if (this.emailType() === 'activation-reminder' && envelope.data?.activationLink) {
          this.activationLink.set(envelope.data.activationLink);
        }
      }
    } catch (err) {
      this.result.set({ success: false, message: err instanceof Error ? err.message : 'Failed to send email' });
    } finally {
      this.isLoading.set(false);
    }
  }

  async copyActivationLink(): Promise<void> {
    const link = this.activationLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      this.copyFeedback.set('Copied!');
      setTimeout(() => this.copyFeedback.set(null), 1800);
    } catch {
      this.copyFeedback.set('Copy failed');
      setTimeout(() => this.copyFeedback.set(null), 2000);
    }
  }

  clearActivationLink(): void {
    this.activationLink.set(null);
    this.copyFeedback.set(null);
  }
}