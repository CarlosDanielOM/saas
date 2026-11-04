import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { CommandsApiService } from '../../services/commands-api.service';
import { LanguageService } from '../../services/language.service';

/** Channel defaults for randomuser; command-specific exclusions remain in command text. */
@Component({
  selector: 'app-randomuser-settings',
  templateUrl: './randomuser-settings.component.html',
  styleUrl: './randomuser-settings.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RandomUserSettingsComponent {
  private readonly api = inject(CommandsApiService);
  private readonly language = inject(LanguageService);
  private readonly destroyRef = inject(DestroyRef);
  readonly channelID = input.required<string>();
  private readonly reload = signal(0);
  private readonly saved = signal<string[]>([]);
  readonly draft = signal('');
  readonly loading = signal(true);
  readonly loadFailed = signal(false);
  readonly saving = signal(false);
  readonly saveFailed = signal(false);
  readonly submitAttempted = signal(false);
  readonly logins = computed(() => [...new Set(this.draft().split(/[\s,;]+/)
    .filter(Boolean).map((login) => login.replace(/^@/, '').toLowerCase()))]);
  readonly dirty = computed(() => this.logins().join('\n') !== this.saved().join('\n'));
  readonly validationKey = computed(() => {
    if (this.logins().length > 200) return 'commands.randomuser.tooMany';
    if (this.logins().some((login) => !/^[a-z0-9_]{1,25}$/.test(login))) return 'commands.randomuser.invalid';
    return '';
  });

  constructor() {
    effect((onCleanup) => {
      const channelID = this.channelID();
      this.reload();
      this.loading.set(true);
      this.loadFailed.set(false);
      this.saving.set(false);
      this.saveFailed.set(false);
      this.submitAttempted.set(false);
      this.saved.set([]);
      this.draft.set('');
      const subscription = this.api.getRandomUserBlacklist(channelID).subscribe((blacklist) => {
        this.loading.set(false);
        this.loadFailed.set(blacklist === null);
        if (blacklist !== null) {
          this.saved.set(blacklist);
          this.draft.set(blacklist.join('\n'));
        }
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  retry(): void {
    this.reload.update((value) => value + 1);
  }

  edit(value: string): void {
    this.draft.set(value);
    this.saveFailed.set(false);
  }

  save(): void {
    this.submitAttempted.set(true);
    if (this.loading() || this.loadFailed() || this.saving() || this.validationKey() || !this.dirty()) return;
    const channelID = this.channelID();
    this.saving.set(true);
    this.saveFailed.set(false);
    this.api.saveRandomUserBlacklist(channelID, this.logins()).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((blacklist) => {
        if (channelID !== this.channelID()) return;
        this.saving.set(false);
        this.saveFailed.set(blacklist === null);
        if (blacklist !== null) {
          this.saved.set(blacklist);
          this.draft.set(blacklist.join('\n'));
        }
      });
  }
}
