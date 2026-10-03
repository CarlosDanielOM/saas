import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { environment } from '../../../environments/environment';
import { SessionAuthService } from '../../services/session-auth.service';
import { IconComponent } from '../../shared/icon/icon.component';

type EmailType = 'welcome' | 'activation-reminder' | 'stream-summary';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Component({
  selector: 'app-email-test-page',
  templateUrl: './email-test-page.component.html',
  styleUrl: './email-test-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
})
export class EmailTestPageComponent {
  private readonly sessionAuth = inject(SessionAuthService);

  readonly emailType = signal<EmailType>('welcome');
  readonly language = signal<'en' | 'es'>('en');
  readonly theme = signal<'light' | 'dark'>('dark');
  readonly recipientEmail = signal('');
  readonly submitAttempted = signal(false);
  readonly isLoading = signal(false);
  readonly result = signal<{ success: boolean; message: string; to?: string } | null>(null);
  // For activation-reminder the backend returns the real activation link (it feeds the
  // public site's pendingActionsQueue), so it can be opened or shared from here.
  readonly activationLink = signal<string | null>(null);
  readonly copyFeedback = signal<string | null>(null);

  readonly myEmail = computed(() => {
    const session = this.sessionAuth.getSessionSnapshot();
    return session?.twitchUser?.email || session?.appUser?.email || null;
  });
  readonly recipientError = computed(() => {
    const email = this.recipientEmail().trim();
    if (!email) return 'Please enter a recipient email';
    if (!EMAIL_PATTERN.test(email)) return "That doesn't look like an email address";
    return null;
  });

  readonly emailTypes: { value: EmailType; label: string; icon: string; description: string }[] = [
    {
      value: 'welcome',
      label: 'Welcome',
      icon: 'sparkles',
      description: 'Sent right after a streamer signs up.',
    },
    {
      value: 'activation-reminder',
      label: 'Reminder',
      icon: 'bell',
      description: "Nudges streamers who haven't activated the bot. Includes a real activation link.",
    },
    {
      value: 'stream-summary',
      label: 'Summary',
      icon: 'chart',
      description: 'The recap streamers get after a stream ends.',
    },
  ];

  readonly languages = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
  ] as const;

  readonly themes = [
    { value: 'light', label: 'Light Mode', icon: 'sun' },
    { value: 'dark', label: 'Dark Mode', icon: 'moon' },
  ] as const;

  useMyEmail(): void {
    const email = this.myEmail();
    if (email) this.recipientEmail.set(email);
  }

  async sendTestEmail(): Promise<void> {
    this.submitAttempted.set(true);
    const email = this.recipientEmail().trim();
    if (this.recipientError()) return;

    this.isLoading.set(true);
    this.result.set(null);
    this.activationLink.set(null);
    this.copyFeedback.set(null);

    try {
      const response = await fetch(
        `${environment.DIMA_API}/email/test?type=${this.emailType()}&to=${encodeURIComponent(email)}&lang=${this.language()}&theme=${this.theme()}`,
      );
      const envelope = (await response.json()) as {
        error: boolean;
        message?: string;
        data?: { activationLink?: string };
      };

      if (envelope.error) {
        this.result.set({ success: false, message: envelope.message || "Couldn't send the email" });
      } else {
        this.result.set({ success: true, message: 'Email sent successfully!', to: email });
        if (this.emailType() === 'activation-reminder' && envelope.data?.activationLink) {
          this.activationLink.set(envelope.data.activationLink);
        }
      }
    } catch (err) {
      this.result.set({
        success: false,
        message: err instanceof Error ? err.message : "Couldn't send the email",
      });
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
