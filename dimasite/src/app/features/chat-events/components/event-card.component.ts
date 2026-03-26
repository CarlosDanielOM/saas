import { ChangeDetectionStrategy, Component, input, output, computed, inject } from '@angular/core';
import { LucideAngularModule, 
  Crown, Check, X, Lock, PlusCircle, Settings2,
  UserPlus, Heart, Zap, Users, MessageCircle, VolumeX, Gamepad2,
  Wrench, Clock, Terminal, Award, Star, Trophy, FlaskConical, Play,
  LucideIconData
} from 'lucide-angular';

import { LanguageService } from '../../../services/language.service';
import { ChatEvent, ChatEventPendingAction, EventDisplayStatus, PlanTier, ReleaseStage, UserAccess } from '../chat-events.model';
import { ConfigPanelComponent } from './config-panel.component';

type IconMap = Record<string, LucideIconData>;

@Component({
  selector: 'app-event-card',
  imports: [LucideAngularModule, ConfigPanelComponent],
  template: `
    <div 
      class="event-card"
      [class.event-card--configuring]="event().isConfiguring"
      [class.event-card--premium]="event().premium"
      [class.event-card--pro]="event().pro"
      >
      
      <div class="event-card__header">
        <div 
          class="event-card__icon-wrapper"
          [class]="event().color">
          <lucide-icon 
            [name]="getIconComponent(event().icon)" 
            class="event-card__icon"
            [class]="event().textColor"></lucide-icon>
        </div>
        
        <div class="event-card__info">
          <h3 class="event-card__name">
            {{ event().name }}
            @if (event().pro) {
              <span class="event-card__badge event-card__badge--pro">
                <lucide-icon [name]="crownIcon" class="event-card__badge-icon"></lucide-icon>
                <span class="event-card__badge-plus">+</span>
              </span>
            } @else if (event().premium) {
              <span class="event-card__badge event-card__badge--premium">
                <lucide-icon [name]="crownIcon" class="event-card__badge-icon"></lucide-icon>
              </span>
            }
          </h3>
          <p class="event-card__description">{{ getEventDescription(event().description) }}</p>
        </div>
      </div>

      <div class="event-card__actions-bar">
        <div class="event-card__status">
          <lucide-icon 
            [name]="displayStatus().icon" 
            class="event-card__status-icon"
            [class]="displayStatus().color"></lucide-icon>
          <span 
            class="event-card__status-text"
            [class]="displayStatus().color">
            {{ displayStatus().text }}
          </span>
        </div>

        <div class="event-card__buttons">
          @if (userAccess().canAccess) {
            @if (event().enabled) {
              @if (event().config) {
                <button
                  type="button"
                  class="event-card__btn event-card__btn--configure"
                  [class.event-card__btn--pending]="isBusy()"
                  [class.event-card__btn--active]="event().isConfiguring"
                  [disabled]="isBusy()"
                  (click)="toggleConfigure()">
                  <lucide-icon [name]="settingsIcon" class="event-card__btn-icon"></lucide-icon>
                  {{ configureButtonLabel() }}
                </button>
              }

              <button
                type="button"
                  class="event-card__btn event-card__btn--disable"
                [class.event-card__btn--pending]="isDisabling()"
                [class.event-card__btn--disabled]="!canDisable()"
                [disabled]="!canDisable() || isBusy()"
                [title]="!canDisable() ? t('chatEvents.tooltips.disableNotAllowed') : ''"
                (click)="toggleFeature()">
                {{ isDisabling() ? t('chatEvents.pending.disabling') : t('chatEvents.disable') }}
              </button>
            } @else if (event().releaseStage !== 'coming_soon' && event().releaseStage !== 'maintenance') {
              <button
                type="button"
                class="event-card__btn event-card__btn--enable"
                [class.event-card__btn--pending]="isEnabling()"
                [disabled]="isBusy()"
                (click)="toggleFeature()">
                {{ isEnabling() ? t('chatEvents.pending.enabling') : t('chatEvents.enable') }}
              </button>
            } @else {
              <button
                type="button"
                class="event-card__btn event-card__btn--disabled"
                disabled>
                {{ t('chatEvents.configure') }}
              </button>
            }
          } @else {
            <button
              type="button"
              class="event-card__btn event-card__btn--upgrade"
              (click)="onUpgradeClick()">
              {{ t('chatEvents.upgrade') }}
            </button>
          }
        </div>
      </div>

      @if (event().isConfiguring && event().config) {
        <app-config-panel
          [event]="event()"
          [userPlan]="userPlan()"
          [pendingAction]="pendingAction()"
          (save)="saveConfiguration()"
          (delete)="deleteEvent()" />
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class EventCardComponent {
  private readonly languageService = inject(LanguageService);

  readonly event = input.required<ChatEvent>();
  readonly userPlan = input.required<PlanTier>();
  readonly userAccess = input.required<UserAccess>();
  readonly pendingAction = input<ChatEventPendingAction>('none');
  readonly configure = output<void>();
  readonly toggle = output<void>();
  readonly save = output<void>();
  readonly delete = output<void>();
  readonly upgrade = output<void>();

  readonly crownIcon = Crown;
  readonly checkIcon = Check;
  readonly xIcon = X;
  readonly lockIcon = Lock;
  readonly plusCircleIcon = PlusCircle;
  readonly settingsIcon = Settings2;

  private readonly iconMap: IconMap = {
    'UserPlus': UserPlus,
    'Heart': Heart,
    'Zap': Zap,
    'Users': Users,
    'MessageCircle': MessageCircle,
    'VolumeX': VolumeX,
    'Gamepad2': Gamepad2,
    'Check': Check,
    'X': X,
    'Wrench': Wrench,
    'Crown': Crown,
    'Clock': Clock,
    'Terminal': Terminal,
    'Award': Award,
    'Star': Star,
    'Trophy': Trophy,
    'FlaskConical': FlaskConical,
    'Lock': Lock,
    'PlusCircle': PlusCircle,
    'Play': Play,
    'Settings2': Settings2
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

    // Handle access restrictions
    if (!this.userAccess().canAccess && this.userAccess().reason) {
      const reason = this.userAccess().reason;
      const message = reason === 'needs_pro' 
        ? this.t('chatEvents.permissionMessages.needsPro')
        : this.t('chatEvents.permissionMessages.needsPremium');
      
      if (event.releaseStage === 'alpha' || event.releaseStage === 'beta') {
        return {
          text: `${message} (${this.getStageAccessText(event.releaseStage)})`,
          icon: Lock,
          color: 'text-yellow-600'
        };
      }

      return {
        text: message,
        icon: Lock,
        color: 'text-yellow-600'
      };
    }

    // Handle Alpha and Beta stages
    if (event.releaseStage === 'alpha' || event.releaseStage === 'beta') {
      if (event.isSubscribed === false) {
        const text = event.releaseStage === 'alpha'
          ? this.t('chatEvents.status.tryTheAlpha')
          : this.t('chatEvents.status.tryTheBeta');
        return { 
          text, 
          icon: this.getStageIcon(event.releaseStage), 
          color: this.getStageColor(event.releaseStage) 
        };
      } else {
        if (event.enabled) {
          const text = event.releaseStage === 'alpha'
            ? this.t('chatEvents.status.alphaEnabled')
            : this.t('chatEvents.status.betaEnabled');
          return { 
            text, 
            icon: this.getStageIcon(event.releaseStage), 
            color: this.getStageColor(event.releaseStage) 
          };
        } else {
          return { 
            text: this.t('chatEvents.status.disabled'), 
            icon: X, 
            color: 'text-red-500' 
          };
        }
      }
    }

    // Handle Stable stage
    if (event.releaseStage === 'stable') {
      if (event.isSubscribed === false) {
        return { 
          text: this.t('chatEvents.status.notCreated'), 
          icon: PlusCircle, 
          color: 'text-gray-500' 
        };
      } else {
        if (event.enabled) {
          return { 
            text: this.t('chatEvents.status.enabled'), 
            icon: Check, 
            color: 'text-green-500' 
          };
        } else {
          return { 
            text: this.t('chatEvents.status.disabled'), 
            icon: X, 
            color: 'text-red-500' 
          };
        }
      }
    }

    // Fallback for other stages
    return { 
      text: this.getStageMessage(event.releaseStage), 
      icon: this.getStageIcon(event.releaseStage), 
      color: this.getStageColor(event.releaseStage) 
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

  getIconComponent(iconName: string): LucideIconData {
    return this.iconMap[iconName] || this.iconMap['X'];
  }

  toggleConfigure(): void {
    this.configure.emit();
  }

  toggleFeature(): void {
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
    return stage === 'alpha' 
      ? this.t('chatEvents.stage.alphaAccess')
      : this.t('chatEvents.stage.betaAccess');
  }

  private getStageIcon(stage: ReleaseStage): LucideIconData {
    switch (stage) {
      case 'stable': return Check;
      case 'beta': return FlaskConical;
      case 'alpha': return FlaskConical;
      case 'coming_soon': return Clock;
      case 'maintenance': return Wrench;
      default: return Lock;
    }
  }

  private getStageColor(stage: ReleaseStage): string {
    switch (stage) {
      case 'stable': return 'text-green-500';
      case 'beta': return 'text-blue-500';
      case 'alpha': return 'text-purple-500';
      case 'coming_soon': return 'text-gray-400';
      case 'maintenance': return 'text-yellow-500';
      default: return 'text-gray-500';
    }
  }

  private getStageMessage(stage: ReleaseStage): string {
    switch (stage) {
      case 'coming_soon': return this.t('chatEvents.stage.comingSoon');
      case 'maintenance': return this.t('chatEvents.stage.maintenance');
      case 'unavailable': return this.t('chatEvents.stage.unavailable');
      case 'deprecated': return this.t('chatEvents.stage.deprecated');
      default: return this.t('chatEvents.status.notCreated');
    }
  }
}
