import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import {
  Award,
  Check,
  Circle,
  Clock,
  Crown,
  Flame,
  FlaskConical,
  Gamepad2,
  Heart,
  Lock,
  LucideAngularModule,
  MessageCircle,
  Play,
  Radio,
  PlusCircle,
  Settings2,
  Square,
  Star,
  Terminal,
  Trophy,
  Tv,
  UserPlus,
  Users,
  VolumeX,
  Wrench,
  X,
  Zap,
  type LucideIconData
} from 'lucide-angular';

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
import { LfIconComponent, type LfIconName } from '../../../shared/lf-icon/lf-icon.component';

@Component({
  selector: 'app-event-card',
  imports: [ConfigPanelComponent, LfIconComponent, LucideAngularModule],
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
  readonly canManage = input(false);
  readonly pendingAction = input<ChatEventPendingAction>('none');
  readonly configure = output<void>();
  readonly toggle = output<void>();
  readonly save = output<void>();
  readonly delete = output<void>();
  readonly upgrade = output<void>();

  private readonly iconData: Record<string, LucideIconData> = {
    UserPlus,
    Heart,
    Zap,
    Users,
    MessageCircle,
    VolumeX,
    Gamepad2,
    Check,
    X,
    Wrench,
    Crown,
    Clock,
    Terminal,
    Award,
    Star,
    Trophy,
    FlaskConical,
    Lock,
    PlusCircle,
    Play,
    Settings2,
    Flame
  };

  /** The catalog uses the same Play glyph for every stream event; tell them apart here. */
  private readonly typeIcons: Record<string, LucideIconData> = {
    'stream.online': Radio,
    'stream.offline': Square,
    'channel.ad_break.begin': Tv
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
          icon: 'lock',
          tone: 'warn'
        };
      }

      return { text: message, icon: 'lock', tone: 'warn' };
    }

    if (event.releaseStage === 'alpha' || event.releaseStage === 'beta') {
      if (event.isSubscribed === false) {
        return {
          text:
            event.releaseStage === 'alpha'
              ? this.t('chatEvents.status.tryTheAlpha')
              : this.t('chatEvents.status.tryTheBeta'),
          icon: 'flask',
          tone: event.releaseStage === 'alpha' ? 'alpha' : 'beta'
        };
      }

      if (event.enabled) {
        return {
          text:
            event.releaseStage === 'alpha'
              ? this.t('chatEvents.status.alphaEnabled')
              : this.t('chatEvents.status.betaEnabled'),
          icon: 'flask',
          tone: event.releaseStage === 'alpha' ? 'alpha' : 'beta'
        };
      }

      return {
        text: this.t('chatEvents.status.disabled'),
        icon: 'close',
        tone: 'danger'
      };
    }

    if (event.releaseStage === 'stable') {
      if (event.isSubscribed === false) {
        return {
          text: this.t('chatEvents.status.notCreated'),
          icon: 'plus',
          tone: 'muted'
        };
      }

      if (event.enabled) {
        return {
          text: this.t('chatEvents.status.enabled'),
          icon: 'check',
          tone: 'ok'
        };
      }

      return {
        text: this.t('chatEvents.status.disabled'),
        icon: 'close',
        tone: 'danger'
      };
    }

    return {
      text: this.getStageMessage(event.releaseStage),
      icon: this.getStageGlyph(event.releaseStage),
      tone: this.getStageTone(event.releaseStage)
    };
  });

  t(key: string): string {
    return this.languageService.translate(key);
  }

  readonly releaseChip = computed(() => {
    const stage = this.event().releaseStage;
    return stage === 'alpha' || stage === 'beta' ? stage : null;
  });

  /** Locked plans, maintenance and similar states still need a visible explanation. */
  readonly statusNote = computed(() => {
    const event = this.event();
    if (!this.userAccess().canAccess) return this.displayStatus().text;
    if (event.releaseStage === 'coming_soon' || event.releaseStage === 'maintenance'
      || event.releaseStage === 'unavailable' || event.releaseStage === 'deprecated') {
      return this.displayStatus().text;
    }
    return null;
  });

  readonly canToggle = computed(() => {
    const stage = this.event().releaseStage;
    return this.userAccess().canAccess && stage !== 'coming_soon' && stage !== 'maintenance'
      && stage !== 'unavailable' && stage !== 'deprecated';
  });

  readonly alwaysOn = computed(() => this.event().enabled && !this.canDisable());

  getEventName(): string {
    return this.event().type === 'channel.chat.notification' && !this.event().notice
      ? this.t('chatEvents.notificationsName')
      : this.event().name;
  }

  getEventDescription(description: { en: string; es: string }): string {
    if (!description || typeof description !== 'object') {
      return 'Invalid description';
    }
    const lang = this.languageService.getCurrentLanguage();
    return description[lang] ?? description.en ?? 'Invalid description';
  }

  eventIcon(iconName: string): LucideIconData {
    return this.typeIcons[this.event().type] ?? this.iconData[iconName] ?? Circle;
  }

  toggleConfigure(): void {
    this.configure.emit();
  }

  toggleFeature(): void {
    if (!this.canManage()) return;
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
    if (!this.canManage()) return;
    this.save.emit();
  }

  deleteEvent(): void {
    if (!this.canManage()) return;
    this.delete.emit();
  }

  onUpgradeClick(): void {
    if (!this.canManage()) return;
    this.upgrade.emit();
  }

  private getStageAccessText(stage: ReleaseStage): string {
    return stage === 'alpha' ? this.t('chatEvents.stage.alphaAccess') : this.t('chatEvents.stage.betaAccess');
  }

  private getStageGlyph(stage: ReleaseStage): LfIconName {
    switch (stage) {
      case 'stable':
        return 'check';
      case 'beta':
      case 'alpha':
        return 'flask';
      case 'coming_soon':
        return 'timer';
      case 'maintenance':
        return 'wrench';
      default:
        return 'lock';
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
