import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { Lock, LucideAngularModule, type LucideIconData } from 'lucide-angular';

export interface Module {
  id: string;
  name: string;
  description: string;
  icon: LucideIconData;
  path: string | null;
  category: 'engagement' | 'automation' | 'content';
  status: 'stable' | 'beta' | 'alpha' | 'coming_soon';
  isPremium: boolean;
  isPro: boolean;
  isLocked: boolean;
}

@Component({
  selector: 'app-module-card',
  imports: [LucideAngularModule],
  template: `
    <div 
      class="module-card"
      [class.featured]="featured()"
      [class.locked]="module().isLocked"
      [class.coming-soon]="module().status === 'coming_soon'"
      [style.--stagger-delay]="staggerDelay() + 'ms'"
    >
      <div class="card-glow"></div>
      
      <div class="card-content">
        <div class="gradient-line"></div>
        
        <div class="badge-group">
          <div class="status-badge" [class]="'status-' + module().status">
            <span class="status-dot"></span>
            <span class="status-text">{{ getStatusText() }}</span>
          </div>
          @if (module().isPro) {
            <div class="tier-badge tier-pro">
              <span class="tier-dot"></span>
              <span class="tier-text">Pro</span>
            </div>
          } @else if (module().isPremium) {
            <div class="tier-badge tier-premium">
              <span class="tier-dot"></span>
              <span class="tier-text">Premium</span>
            </div>
          }
        </div>

        <div class="icon-wrapper" [class.premium]="module().isPremium" [class.pro]="module().isPro">
          <div class="icon-3d">
            <lucide-icon [name]="module().icon" class="module-icon"></lucide-icon>
            <div class="icon-glow"></div>
          </div>
        </div>
        
        <div class="card-body">
          <h3 class="module-title">{{ module().name }}</h3>
          <p class="module-description">{{ module().description }}</p>
        </div>
        
        <div class="card-footer">
          @if (showPrimaryAction()) {
            <a 
              [attr.href]="module().path"
              class="action-button primary"
              (click)="navigateToModule($event)"
            >
              <span>{{ accessText() }}</span>
              <svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"></path>
              </svg>
            </a>
          } @else if (showUpgradeAction()) {
            <button class="action-button upgrade" (click)="upgradeClick.emit(module())">
              <lucide-icon [name]="lockIcon" class="lock-icon"></lucide-icon>
              <span>{{ upgradeText() }}</span>
            </button>
          } @else {
            <button class="action-button disabled" disabled>
              {{ accessText() }}
            </button>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .module-card {
      position: relative;
      perspective: 1000px;
      opacity: 0;
      transform: translateY(30px);
      animation: card-enter 0.6s cubic-bezier(0.22, 1, 0.36, 1) forwards;
      animation-delay: var(--stagger-delay, 0ms);
    }

    @keyframes card-enter {
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .card-content {
      position: relative;
      background: color-mix(in srgb, var(--surface) 85%, transparent);
      backdrop-filter: blur(12px);
      border: 1px solid color-mix(in srgb, var(--ring) 20%, transparent);
      border-radius: 1.5rem;
      padding: 1.75rem;
      transition: all 0.4s cubic-bezier(0.22, 1, 0.36, 1);
      transform-style: preserve-3d;
      overflow: hidden;
    }

    .card-content::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, color-mix(in srgb, #7c3aed 5%, transparent), transparent 50%);
      opacity: 0;
      transition: opacity 0.4s ease;
      pointer-events: none;
    }

    .card-glow {
      position: absolute;
      inset: -2px;
      background: linear-gradient(135deg,
        color-mix(in srgb, #7c3aed 50%, transparent),
        color-mix(in srgb, #3b82f6 50%, transparent),
        color-mix(in srgb, #a855f7 50%, transparent)
      );
      border-radius: 1.6rem;
      opacity: 0;
      filter: blur(20px);
      transition: opacity 0.4s ease;
      z-index: -1;
      pointer-events: none;
    }

    .gradient-line {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg,
        #7c3aed,
        #a855f7,
        #3b82f6,
        #7c3aed
      );
      background-size: 200% 100%;
      animation: gradient-flow 3s linear infinite;
      pointer-events: none;
    }

    @keyframes gradient-flow {
      0% { background-position: 0% 50%; }
      100% { background-position: 200% 50%; }
    }

    .badge-group {
      position: absolute;
      top: 1rem;
      right: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: nowrap;
      justify-content: flex-end;
      pointer-events: none;
      max-width: calc(100% - 2rem);
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      transition: all 0.3s ease;
      flex-shrink: 0;
      white-space: nowrap;
    }

    .status-stable {
      background: color-mix(in srgb, #22c55e 12%, transparent);
      color: #16a34a;
      border: 1px solid color-mix(in srgb, #22c55e 30%, transparent);
    }

    .status-beta {
      background: color-mix(in srgb, #3b82f6 12%, transparent);
      color: #2563eb;
      border: 1px solid color-mix(in srgb, #3b82f6 30%, transparent);
    }

    .status-alpha {
      background: color-mix(in srgb, #f59e0b 12%, transparent);
      color: #d97706;
      border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
    }

    .status-coming_soon {
      background: color-mix(in srgb, #6b7280 12%, transparent);
      color: #6b7280;
      border: 1px solid color-mix(in srgb, #6b7280 30%, transparent);
    }

    .status-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }

    .tier-badge {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      transition: all 0.3s ease;
      flex-shrink: 0;
      white-space: nowrap;
    }

    .tier-premium {
      background: color-mix(in srgb, #fbbf24 12%, transparent);
      color: #d97706;
      border: 1px solid color-mix(in srgb, #fbbf24 40%, transparent);
    }

    .tier-pro {
      background: color-mix(in srgb, #f59e0b 15%, transparent);
      color: #b45309;
      border: 1px solid color-mix(in srgb, #f59e0b 50%, transparent);
    }

    .tier-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
    }

    .icon-wrapper {
      position: relative;
      width: 4rem;
      height: 4rem;
      margin-bottom: 1.25rem;
      flex-shrink: 0;
    }

    .icon-3d {
      width: 100%;
      height: 100%;
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border-radius: 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      box-shadow:
        0 10px 25px -5px rgba(124, 58, 237, 0.35),
        inset 0 1px 0 rgba(255, 255, 255, 0.2);
      transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
      flex-shrink: 0;
      overflow: hidden;
    }

    .icon-wrapper.premium .icon-3d {
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      box-shadow:
        0 10px 25px -5px rgba(251, 191, 36, 0.35),
        inset 0 1px 0 rgba(255, 255, 255, 0.3);
    }

    .icon-wrapper.pro .icon-3d {
      background: linear-gradient(135deg, #f59e0b, #d97706);
      box-shadow:
        0 10px 25px -5px rgba(217, 119, 6, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.3);
    }

    .module-icon {
      width: 1.5rem;
      height: 1.5rem;
      color: white;
      display: block;
      line-height: 0;
      flex-shrink: 0;
    }

    .module-icon svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    .icon-glow {
      position: absolute;
      inset: -10px;
      background: radial-gradient(circle, rgba(124, 58, 237, 0.25), transparent 70%);
      opacity: 0;
      transition: opacity 0.4s ease;
      pointer-events: none;
    }

    .card-body {
      margin-bottom: 1.5rem;
    }

    .module-title {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text);
      margin: 0 0 0.5rem 0;
      line-height: 1.2;
    }

    .module-description {
      font-size: 0.9rem;
      color: var(--text-soft);
      line-height: 1.5;
      margin: 0;
    }

    .card-footer {
      margin-top: auto;
    }

    .action-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.875rem 1.25rem;
      border-radius: 0.75rem;
      font-size: 0.9rem;
      font-weight: 600;
      border: none;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.22, 1, 0.36, 1);
      text-decoration: none;
      position: relative;
      z-index: 2;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }

    .action-button.primary {
      background: linear-gradient(135deg, #7c3aed, #a855f7, #3b82f6);
      background-size: 200% 200%;
      color: white;
      box-shadow: 0 4px 15px rgba(124, 58, 237, 0.3);
      animation: gradient-shift 3s ease infinite;
    }

    @keyframes gradient-shift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    .action-button.disabled {
      background: color-mix(in srgb, var(--text) 10%, transparent);
      color: color-mix(in srgb, var(--text) 50%, transparent);
      cursor: not-allowed;
    }

    .action-button.upgrade {
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      color: white;
      box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3);
    }

    .arrow-icon {
      width: 1rem;
      height: 1rem;
      transition: transform 0.3s ease;
    }

    .lock-icon {
      width: 0.875rem;
      height: 0.875rem;
    }

    .module-card.featured .card-content {
      background: linear-gradient(135deg, color-mix(in srgb, var(--surface) 90%, transparent), color-mix(in srgb, var(--surface-2) 85%, transparent));
    }

    .module-card.featured .icon-wrapper {
      width: 5rem;
      height: 5rem;
    }

    .module-card.featured .module-icon {
      width: 2.25rem;
      height: 2.25rem;
    }

    .module-card.locked .card-content {
      opacity: 0.7;
    }

    .module-card.coming-soon .gradient-line {
      background: linear-gradient(90deg, #9ca3af, #d1d5db, #9ca3af);
      background-size: 200% 100%;
    }

    .module-card.coming-soon .icon-3d {
      background: linear-gradient(135deg, #9ca3af, #d1d5db);
      box-shadow: 0 10px 25px -5px rgba(156, 163, 175, 0.3);
    }

    /* Mobile optimizations - only apply hover effects on hover-capable devices */
    @media (hover: hover) {
      .module-card:hover .card-content {
        transform: translateY(-8px);
        border-color: color-mix(in srgb, var(--ring) 40%, transparent);
        box-shadow:
          0 25px 50px -12px rgba(124, 58, 237, 0.2),
          0 0 0 1px color-mix(in srgb, var(--ring) 15%, transparent);
      }

      .module-card:hover .card-content::before {
        opacity: 1;
      }

      .module-card:hover .card-glow {
        opacity: 0.5;
      }

      .module-card:hover .icon-3d {
        transform: scale(1.05);
      }

      .module-card:hover .icon-glow {
        opacity: 1;
      }

      .action-button.primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 25px rgba(124, 58, 237, 0.4);
      }

      .action-button.upgrade:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 25px rgba(245, 158, 11, 0.4);
      }

      .action-button:hover .arrow-icon {
        transform: translateX(4px);
      }

      .module-card.locked:hover .card-content {
        opacity: 0.9;
      }
    }

    /* Mobile/touch device styles - subtle active state instead of hover */
    @media (hover: none) {
      .card-content {
        /* Simpler shadows for mobile */
        box-shadow: 0 4px 12px rgba(124, 58, 237, 0.1);
      }

      .module-card:active .card-content {
        transform: scale(0.98);
        transition: transform 0.1s ease;
      }

      .action-button.primary:active,
      .action-button.upgrade:active {
        transform: scale(0.96);
        transition: transform 0.1s ease;
      }

      /* Disable expensive blur glow on mobile */
      .card-glow {
        display: none;
      }

      .icon-glow {
        display: none;
      }

      /* Simpler shadows on mobile */
      .icon-3d {
        box-shadow:
          0 4px 12px -2px rgba(124, 58, 237, 0.25),
          inset 0 1px 0 rgba(255, 255, 255, 0.2);
      }

      .icon-wrapper.premium .icon-3d {
        box-shadow:
          0 4px 12px -2px rgba(251, 191, 36, 0.25),
          inset 0 1px 0 rgba(255, 255, 255, 0.3);
      }

      .icon-wrapper.pro .icon-3d {
        box-shadow:
          0 4px 12px -2px rgba(217, 119, 6, 0.3),
          inset 0 1px 0 rgba(255, 255, 255, 0.3);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .module-card {
        animation: none;
        opacity: 1;
        transform: none;
      }

      .gradient-line {
        animation: none;
      }

      .status-dot {
        animation: none;
      }

      .action-button.primary {
        animation: none;
      }

      .card-content,
      .icon-3d,
      .action-button {
        transition: none;
      }
    }

    /* Small mobile screens - further optimizations */
    @media (max-width: 640px) {
      .card-content {
        padding: 1.25rem;
        border-radius: 1.25rem;
      }

      .icon-wrapper {
        width: 3.5rem;
        height: 3.5rem;
      }

      .module-title {
        font-size: 1.125rem;
      }

      .module-description {
        font-size: 0.875rem;
      }

      .action-button {
        padding: 0.75rem 1rem;
        font-size: 0.875rem;
      }

      .badge-group {
        gap: 0.35rem;
      }

      .status-badge,
      .tier-badge {
        padding: 0.3rem 0.6rem;
        font-size: 0.65rem;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ModuleCardComponent {
  private readonly router = inject(Router);

  readonly module = input.required<Module>();
  readonly featured = input(false);
  readonly staggerDelay = input(0);
  readonly accessText = input('Open Module');
  readonly upgradeText = input('Upgrade');

  readonly upgradeClick = output<Module>();

  readonly lockIcon = Lock;
  readonly isActionable = computed(() => Boolean(this.module().path) && this.module().status !== 'coming_soon');
  readonly showPrimaryAction = computed(() => this.isActionable() && !this.module().isLocked);
  readonly showUpgradeAction = computed(() => this.isActionable() && this.module().isLocked);

  navigateToModule(event: Event): void {
    const path = this.module().path;
    if (!path) {
      return;
    }

    event.preventDefault();
    void this.router.navigateByUrl(path);
  }

  getStatusText(): string {
    const statusMap: Record<string, string> = {
      'stable': 'Stable',
      'beta': 'Beta',
      'alpha': 'Alpha',
      'coming_soon': 'Coming Soon'
    };
    return statusMap[this.module().status] || this.module().status;
  }
}
