import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  Clock,
  LayoutGrid,
  List,
  Moon,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Sun,
  Timer,
  Trash2,
  Zap
} from 'lucide-angular';
import { LucideAngularModule } from 'lucide-angular';

import { Command, USER_LEVELS } from '../../../models/command.model';
import { ThemeService } from '../../../services/theme.service';

type PlanTier = 'free' | 'premium' | 'pro';
type ViewMode = 'table' | 'card';
type TabId = 'commands' | 'timers';

interface MockTimer {
  id: string;
  name: string;
  message: string;
  frequency: number;
  frequencyUnit: 'minutes';
  active: boolean;
  createdAt: string;
}

interface TimerDraft {
  name: string;
  message: string;
  frequency: number;
}

const LIVE_API = 'https://api.domdimabot.com';
const CHANNEL_ID = '533538623';
const CHANNEL_NAME = 'cdom201';
const FREE_INTERVALS = [15, 30, 45, 60] as const;
const MAX_TIMER_MINUTES = 180;

const TIER_TIMER_LIMITS: Record<PlanTier, number> = {
  free: 5,
  premium: 15,
  pro: 50
};

const SEED_TIMERS: MockTimer[] = [
  {
    id: 't1',
    name: 'discord',
    message: 'Join the community: discord.gg/HdubYrkPXt',
    frequency: 30,
    frequencyUnit: 'minutes',
    active: true,
    createdAt: new Date().toISOString()
  },
  {
    id: 't2',
    name: 'follow',
    message: 'Thanks for hanging out — hit follow if you enjoy the stream!',
    frequency: 15,
    frequencyUnit: 'minutes',
    active: true,
    createdAt: new Date().toISOString()
  },
  {
    id: 't3',
    name: 'socials',
    message: 'Links & socials: !socials',
    frequency: 60,
    frequencyUnit: 'minutes',
    active: false,
    createdAt: new Date().toISOString()
  }
];

@Component({
  selector: 'app-prod-commands-mock',
  imports: [FormsModule, RouterLink, LucideAngularModule],
  templateUrl: './prod-commands-mock.component.html',
  styleUrl: './prod-commands-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProdCommandsMockComponent {
  private readonly themeService = inject(ThemeService);

  readonly listIcon = List;
  readonly gridIcon = LayoutGrid;
  readonly moonIcon = Moon;
  readonly sunIcon = Sun;
  readonly refreshIcon = RefreshCw;
  readonly plusIcon = Plus;
  readonly trashIcon = Trash2;
  readonly powerIcon = Power;
  readonly powerOffIcon = PowerOff;
  readonly timerIcon = Timer;
  readonly zapIcon = Zap;
  readonly clockIcon = Clock;

  readonly channelID = CHANNEL_ID;
  readonly channelName = CHANNEL_NAME;
  readonly liveApi = LIVE_API;

  readonly planTier = signal<PlanTier>('pro');
  readonly activeTab = signal<TabId>('timers');
  readonly viewMode = signal<ViewMode>('table');
  readonly currentPage = signal(1);
  readonly itemsPerPage = signal(10);
  readonly itemsPerPageOptions = [5, 10, 15, 20];
  readonly searchInput = signal('');

  readonly commands = signal<Command[]>([]);
  readonly commandsLoading = signal(true);
  readonly commandsError = signal<string | null>(null);

  readonly timers = signal<MockTimer[]>([...SEED_TIMERS]);
  readonly showTimerModal = signal(false);
  readonly editingTimerId = signal<string | null>(null);
  readonly timerDraft = signal<TimerDraft>({ name: '', message: '', frequency: 30 });
  readonly timerFormError = signal<string | null>(null);
  readonly toast = signal<string | null>(null);

  private toastTimer: number | null = null;

  readonly totalCommands = computed(() => this.commands().length);
  readonly enabledCommands = computed(
    () => this.commands().filter((command) => command.enabled !== false).length
  );
  readonly activeTimers = computed(() => this.timers().filter((timer) => timer.active).length);
  readonly timerLimit = computed(() => TIER_TIMER_LIMITS[this.planTier()]);
  readonly intervalHint = computed(() => {
    switch (this.planTier()) {
      case 'pro':
        return 'Any whole minute from 1–180.';
      case 'premium':
        return '5-minute steps from 5–180.';
      default:
        return 'Pick 15, 30, 45, or 60 minutes.';
    }
  });

  readonly freeIntervals = FREE_INTERVALS;
  readonly premiumIntervals = computed(() =>
    Array.from({ length: MAX_TIMER_MINUTES / 5 }, (_, i) => (i + 1) * 5)
  );

  readonly filteredCommands = computed(() => {
    const query = this.searchInput().trim().toLowerCase();
    const list = this.commands();
    if (!query) {
      return list;
    }

    return list.filter((command) => {
      const haystack = [
        command.name,
        command.cmd,
        command.message,
        command.description ?? '',
        command.userLevelName
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  });

  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredCommands().length / this.itemsPerPage()))
  );

  readonly paginatedCommands = computed(() => {
    const start = (this.currentPage() - 1) * this.itemsPerPage();
    return this.filteredCommands().slice(start, start + this.itemsPerPage());
  });

  readonly pages = computed(() => {
    const total = this.totalPages();
    const current = this.currentPage();
    if (total <= 5) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }

    let start = current - 2;
    let end = current + 2;
    if (start < 1) {
      start = 1;
      end = 5;
    } else if (end > total) {
      end = total;
      start = total - 4;
    }

    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  });

  readonly frequencyOptions = computed(() => {
    const tier = this.planTier();
    if (tier === 'free') {
      return [...FREE_INTERVALS];
    }
    if (tier === 'premium') {
      return this.premiumIntervals();
    }
    return null;
  });

  constructor() {
    void this.loadCommands();
  }

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  setPlanTier(tier: PlanTier): void {
    this.planTier.set(tier);
    const draft = this.timerDraft();
    const validation = this.validateInterval(draft.frequency, tier);
    if (!validation.valid) {
      const fallback = tier === 'pro' ? 30 : tier === 'premium' ? 30 : 30;
      this.timerDraft.update((current) => ({ ...current, frequency: fallback }));
    }
    this.showToast(`Simulating ${tier.toUpperCase()} plan limits`);
  }

  setTab(tab: TabId): void {
    this.activeTab.set(tab);
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
  }

  onSearchInput(value: string): void {
    this.searchInput.set(value);
    this.currentPage.set(1);
  }

  changePage(page: number): void {
    if (page < 1 || page > this.totalPages()) {
      return;
    }
    this.currentPage.set(page);
  }

  onItemsPerPageChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }
    const next = Number(target.value);
    if (!Number.isFinite(next) || next <= 0) {
      return;
    }
    this.itemsPerPage.set(next);
    this.currentPage.set(1);
  }

  commandTrackId(command: Pick<Command, 'id' | '_id'>): string {
    return command.id || command._id || '';
  }

  getUserLevelLabel(command: Command): string {
    return command.userLevelName || USER_LEVELS[command.userLevel] || 'everyone';
  }

  formatInterval(minutes: number): string {
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }

  async loadCommands(): Promise<void> {
    this.commandsLoading.set(true);
    this.commandsError.set(null);

    try {
      const response = await fetch(
        `${LIVE_API}/commands/${CHANNEL_ID}?limit=100&language=en`
      );
      const body = (await response.json()) as {
        error?: boolean;
        message?: string;
        commands?: Command[];
        data?: { commands?: Command[] };
      };

      if (!response.ok || body.error) {
        throw new Error(body.message || `HTTP ${response.status}`);
      }

      const list = Array.isArray(body.commands)
        ? body.commands
        : Array.isArray(body.data?.commands)
          ? body.data.commands
          : [];

      this.commands.set(list);
      this.currentPage.set(1);
    } catch (error) {
      this.commandsError.set(
        error instanceof Error ? error.message : 'Failed to load commands'
      );
    } finally {
      this.commandsLoading.set(false);
    }
  }

  openCreateTimer(): void {
    this.editingTimerId.set(null);
    this.timerFormError.set(null);
    this.timerDraft.set({
      name: '',
      message: '',
      frequency: this.planTier() === 'free' ? 30 : 15
    });
    this.showTimerModal.set(true);
  }

  openEditTimer(timer: MockTimer): void {
    this.editingTimerId.set(timer.id);
    this.timerFormError.set(null);
    this.timerDraft.set({
      name: timer.name,
      message: timer.message,
      frequency: timer.frequency
    });
    this.showTimerModal.set(true);
  }

  closeTimerModal(): void {
    this.showTimerModal.set(false);
    this.editingTimerId.set(null);
    this.timerFormError.set(null);
  }

  updateDraftName(value: string): void {
    this.timerDraft.update((draft) => ({ ...draft, name: value }));
  }

  updateDraftMessage(value: string): void {
    this.timerDraft.update((draft) => ({ ...draft, message: value }));
  }

  updateDraftFrequency(value: number | string): void {
    const next = typeof value === 'number' ? value : Number(value);
    this.timerDraft.update((draft) => ({
      ...draft,
      frequency: Number.isFinite(next) ? next : draft.frequency
    }));
  }

  saveTimer(): void {
    const draft = this.timerDraft();
    const tier = this.planTier();
    const name = draft.name.trim().toLowerCase();
    const message = draft.message.trim();
    const frequency = draft.frequency;
    const editingId = this.editingTimerId();

    if (!name) {
      this.timerFormError.set('Timer name is required');
      return;
    }
    if (name.length > 30) {
      this.timerFormError.set('Timer name cannot exceed 30 characters');
      return;
    }
    if (!/^[\w]+$/.test(name)) {
      this.timerFormError.set('Name can only contain letters, numbers, and underscores');
      return;
    }
    if (!message) {
      this.timerFormError.set('Timer message is required');
      return;
    }
    if (message.length > 350) {
      this.timerFormError.set('Message cannot exceed 350 characters');
      return;
    }

    const intervalCheck = this.validateInterval(frequency, tier);
    if (!intervalCheck.valid) {
      this.timerFormError.set(intervalCheck.error ?? 'Invalid interval');
      return;
    }

    const duplicate = this.timers().some(
      (timer) => timer.name === name && timer.id !== editingId
    );
    if (duplicate) {
      this.timerFormError.set(`Timer "${name}" already exists`);
      return;
    }

    if (!editingId) {
      const activeCount = this.timers().filter((timer) => timer.active).length;
      const limit = TIER_TIMER_LIMITS[tier];
      if (activeCount >= limit) {
        this.timerFormError.set(
          `Timer limit reached (${limit} for ${tier}). Upgrade for more timers.`
        );
        return;
      }

      const next: MockTimer = {
        id: `local-${Date.now()}`,
        name,
        message,
        frequency,
        frequencyUnit: 'minutes',
        active: true,
        createdAt: new Date().toISOString()
      };
      this.timers.update((list) => [next, ...list]);
      this.showToast(`Timer "${name}" created · every ${this.formatInterval(frequency)}`);
    } else {
      this.timers.update((list) =>
        list.map((timer) =>
          timer.id === editingId
            ? { ...timer, name, message, frequency, frequencyUnit: 'minutes' }
            : timer
        )
      );
      this.showToast(`Timer "${name}" updated`);
    }

    this.closeTimerModal();
  }

  toggleTimer(timer: MockTimer): void {
    if (!timer.active) {
      const activeCount = this.timers().filter((item) => item.active).length;
      const limit = this.timerLimit();
      if (activeCount >= limit) {
        this.showToast(`Active timer limit reached (${limit} for ${this.planTier()})`);
        return;
      }
    }

    this.timers.update((list) =>
      list.map((item) =>
        item.id === timer.id ? { ...item, active: !item.active } : item
      )
    );
    this.showToast(
      timer.active ? `Timer "${timer.name}" paused` : `Timer "${timer.name}" activated`
    );
  }

  deleteTimer(timer: MockTimer): void {
    this.timers.update((list) => list.filter((item) => item.id !== timer.id));
    this.showToast(`Timer "${timer.name}" deleted`);
  }

  private validateInterval(
    minutes: number,
    tier: PlanTier
  ): { valid: boolean; error?: string } {
    if (!Number.isInteger(minutes) || minutes <= 0) {
      return { valid: false, error: 'Frequency must be a positive whole number of minutes' };
    }

    switch (tier) {
      case 'pro':
        if (minutes > MAX_TIMER_MINUTES) {
          return { valid: false, error: 'Pro timers must be between 1 and 180 minutes' };
        }
        return { valid: true };
      case 'premium':
        if (minutes < 5 || minutes > MAX_TIMER_MINUTES || minutes % 5 !== 0) {
          return {
            valid: false,
            error: 'Premium timers must use 5-minute intervals from 5 to 180 minutes'
          };
        }
        return { valid: true };
      case 'free':
      default:
        if (!(FREE_INTERVALS as readonly number[]).includes(minutes)) {
          return { valid: false, error: 'Free timers must use 15, 30, 45, or 60 minutes' };
        }
        return { valid: true };
    }
  }

  private showToast(message: string): void {
    this.toast.set(message);
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
    }
    this.toastTimer = window.setTimeout(() => {
      this.toast.set(null);
      this.toastTimer = null;
    }, 2600);
  }
}
