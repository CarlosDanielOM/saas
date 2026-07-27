import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { ToastService } from '../../../services/toast.service';
import {
  ChatEvent,
  ChatEventPendingAction,
  EventDisplayStatus,
  EventStatusTone,
  PlanTier,
  ReleaseStage,
  UserAccess
} from '../chat-events.model';
import { ConfigPanelComponent } from './config-panel.component';

@Component({
  selector: 'app-event-card',
  imports: [ConfigPanelComponent],
  styleUrl: './event-card.component.css',
  templateUrl: './event-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class EventCardComponent {
  private readonly languageService = inject(LanguageService);
  private readonly toastService = inject(ToastService);

  readonly event = input.required<ChatEvent>();
  readonly userPlan = input.required<PlanTier>();
  readonly userAccess = input.required<UserAccess>();
  readonly pendingAction = input<ChatEventPendingAction>('none');
  readonly configure = output<void>();
  readonly toggle = output<void>();
  readonly save = output<void>();
  readonly delete = output<void>();
  readonly upgrade = output<void>();

  private readonly iconGlyphs: Record<string, string> = {
    UserPlus: '＋',
    Heart: '♥',
    Zap: '⚡',
    Users: '👥',
    MessageCircle: '💬',
    VolumeX: '🔇',
    Gamepad2: '🎮',
    Check: '✓',
    X: '×',
    Wrench: '🔧',
    Crown: '★',
    Clock: '⏱',
    Terminal: '>_',
    Award: '🏅',
    Star: '☆',
    Trophy: '🏆',
    FlaskConical: '⚗',
    Lock: '🔒',
    PlusCircle: '＋',
    Play: '▶',
    Settings2: '⚙'
  };

  readonly canDisable = computed(() => {
    const event = this.event();
    if (!event.config || event.config.length === 0) {
      return true;
    }
    return event.config[0].canDisable !== false;
  });

  readonly isEnabling = computed(() => this.pendingAction() === 'enabling');
  readonly isDisabling = computed(() => this.pendingAction() === 'disabling');
  readonly isSaving = computed(() => this.pendingAction() === 'saving');
  readonly isDeleting = computed(() => this.pendingAction() === 'deleting');
  readonly isBusy = computed(() => this.pendingAction() !== 'none');
  readonly configureButtonLabel = computed(() => {
    if (this.isSaving()) {
      return this.t('chatEvents.pending.saving');
    }

    if (this.isDeleting()) {
      return this.t('chatEvents.pending.deleting');
    }

    return this.t('chatEvents.configure');
  });

  readonly displayStatus = computed((): EventDisplayStatus => {
    const event = this.event();

    if (!this.userAccess().canAccess && this.userAccess().reason) {
      const reason = this.userAccess().reason;
      const message =
        reason === 'needs_pro'
          ? this.t('chatEvents.permissionMessages.needsPro')
          : this.t('chatEvents.permissionMessages.needsPremium');

      if (event.releaseStage === 'alpha' || event.releaseStage === 'beta') {
        return {
          text: `${message} (${this.getStageAccessText(event.releaseStage)})`,
          glyph: '🔒',
          tone: 'warn'
        };
      }

      return { text: message, glyph: '🔒', tone: 'warn' };
    }

    if (event.releaseStage === 'alpha' || event.releaseStage === 'beta') {
      if (event.isSubscribed === false) {
        return {
          text:
            event.releaseStage === 'alpha'
              ? this.t('chatEvents.status.tryTheAlpha')
              : this.t('chatEvents.status.tryTheBeta'),
          glyph: '⚗',
          tone: event.releaseStage === 'alpha' ? 'alpha' : 'beta'
        };
      }

      if (event.enabled) {
        return {
          text:
            event.releaseStage === 'alpha'
              ? this.t('chatEvents.status.alphaEnabled')
              : this.t('chatEvents.status.betaEnabled'),
          glyph: '⚗',
          tone: event.releaseStage === 'alpha' ? 'alpha' : 'beta'
        };
      }

      return {
        text: this.t('chatEvents.status.disabled'),
        glyph: '×',
        tone: 'danger'
      };
    }

    if (event.releaseStage === 'stable') {
      if (event.isSubscribed === false) {
        return {
          text: this.t('chatEvents.status.notCreated'),
          glyph: '＋',
          tone: 'muted'
        };
      }

      if (event.enabled) {
        return {
          text: this.t('chatEvents.status.enabled'),
          glyph: '✓',
          tone: 'ok'
        };
      }

      return {
        text: this.t('chatEvents.status.disabled'),
        glyph: '×',
        tone: 'danger'
      };
    }

    return {
      text: this.getStageMessage(event.releaseStage),
      glyph: this.getStageGlyph(event.releaseStage),
      tone: this.getStageTone(event.releaseStage)
    };
  });

  t(key: string): string {
    return this.languageService.translate(key);
  }

  getEventDescription(description: { en: string; es: string }): string {
    if (!description || typeof description !== 'object') {
      return 'Invalid description';
    }
    const lang = this.languageService.getCurrentLanguage();
    return description[lang] ?? description.en ?? 'Invalid description';
  }

  eventGlyph(iconName: string): string {
    return this.iconGlyphs[iconName] || '•';
  }

  toggleConfigure(): void {
    this.configure.emit();
  }

  toggleFeature(): void {
    if (this.event().enabled && !this.canDisable()) {
      this.toastService.info(
        this.t('chatEvents.toasts.disableNotAllowedTitle'),
        this.t('chatEvents.toasts.disableNotAllowedMsg')
      );
      return;
    }
    this.toggle.emit();
  }

  saveConfiguration(): void {
    this.save.emit();
  }

  deleteEvent(): void {
    this.delete.emit();
  }

  onUpgradeClick(): void {
    this.upgrade.emit();
  }

  private getStageAccessText(stage: ReleaseStage): string {
    return stage === 'alpha' ? this.t('chatEvents.stage.alphaAccess') : this.t('chatEvents.stage.betaAccess');
  }

  private getStageGlyph(stage: ReleaseStage): string {
    switch (stage) {
      case 'stable':
        return '✓';
      case 'beta':
      case 'alpha':
        return '⚗';
      case 'coming_soon':
        return '⏱';
      case 'maintenance':
        return '🔧';
      default:
        return '🔒';
    }
  }

  private getStageTone(stage: ReleaseStage): EventStatusTone {
    switch (stage) {
      case 'stable':
        return 'ok';
      case 'beta':
        return 'beta';
      case 'alpha':
        return 'alpha';
      case 'coming_soon':
        return 'muted';
      case 'maintenance':
        return 'warn';
      default:
        return 'muted';
    }
  }

  private getStageMessage(stage: ReleaseStage): string {
    switch (stage) {
      case 'coming_soon':
        return this.t('chatEvents.stage.comingSoon');
      case 'maintenance':
        return this.t('chatEvents.stage.maintenance');
      case 'unavailable':
        return this.t('chatEvents.stage.unavailable');
      case 'deprecated':
        return this.t('chatEvents.stage.deprecated');
      default:
        return this.t('chatEvents.status.notCreated');
    }
  }
}
