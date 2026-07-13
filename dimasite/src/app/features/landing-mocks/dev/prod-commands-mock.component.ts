import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { USER_LEVELS, USER_LEVEL_NAMES } from '../../../models/command.model';
import { LanguageService } from '../../../services/language.service';

type PlanTier = 'free' | 'premium' | 'pro';
type ViewMode = 'table' | 'card';

/** Unified command: optional timerMinutes makes it also auto-repeat. */
interface MockCommand {
  id: string;
  name: string;
  cmd: string;
  message: string;
  description: string | null;
  cooldown: number;
  userLevel: number;
  userLevelName: string;
  enabled: boolean;
  reserved: boolean;
  /** null / 0 = chat-only; >0 = chat + auto timer (minutes) */
  timerMinutes: number | null;
  local?: boolean;
}

interface CommandDraft {
  name: string;
  cmd: string;
  message: string;
  description: string;
  cooldown: number;
  userLevel: number;
  enabled: boolean;
  timerEnabled: boolean;
  timerMinutes: number;
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

/** Demo timer assignments for known cmds when loading live data */
const SEED_TIMERS_BY_CMD: Record<string, number> = {
  discord: 30,
  socials: 60,
  follow: 15,
  commands: 45
};

@Component({
  selector: 'app-prod-commands-mock',
  imports: [FormsModule, RouterLink],
  templateUrl: './prod-commands-mock.component.html',
  styleUrl: './prod-commands-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProdCommandsMockComponent {
  private readonly languageService = inject(LanguageService);

  readonly channelID = CHANNEL_ID;
  readonly channelName = CHANNEL_NAME;
  readonly freeIntervals = FREE_INTERVALS;
  readonly userLevels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
  readonly userLevelNames = USER_LEVEL_NAMES;

  readonly planTier = signal<PlanTier>('pro');
  readonly viewMode = signal<ViewMode>('table');
  readonly currentPage = signal(1);
  readonly itemsPerPage = signal(10);
  readonly itemsPerPageOptions = [5, 10, 15, 20];
  readonly searchInput = signal('');

  readonly commands = signal<MockCommand[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly showModal = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly draft = signal<CommandDraft>(this.emptyDraft());
  readonly formError = signal<string | null>(null);
  readonly toast = signal<string | null>(null);
  readonly confirmDeleteId = signal<string | null>(null);

  private toastTimer: number | null = null;

  readonly totalCommands = computed(() => this.commands().length);
  readonly enabledCommands = computed(
    () => this.commands().filter((c) => c.enabled).length
  );
  readonly timedCommands = computed(
    () => this.commands().filter((c) => (c.timerMinutes ?? 0) > 0).length
  );
  readonly activeTimers = computed(
    () =>
      this.commands().filter((c) => c.enabled && (c.timerMinutes ?? 0) > 0).length
  );
  readonly timerLimit = computed(() => TIER_TIMER_LIMITS[this.planTier()]);

  readonly intervalHint = computed(() => {
    this.languageService.currentLanguage();
    switch (this.planTier()) {
      case 'pro':
        return this.t('devMocks.commands.intervalPro');
      case 'premium':
        return this.t('devMocks.commands.intervalPremium');
      default:
        return this.t('devMocks.commands.intervalFree');
    }
  });

  readonly filteredCommands = computed(() => {
    const q = this.searchInput().trim().toLowerCase();
    const list = this.commands();
    if (!q) return list;
    return list.filter((c) =>
      [c.name, c.cmd, c.message, c.description ?? '', c.userLevelName]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
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
    if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1);
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

  readonly deleteTarget = computed(() => {
    const id = this.confirmDeleteId();
    if (!id) return null;
    return this.commands().find((c) => c.id === id) ?? null;
  });

  constructor() {
    void this.loadCommands();
  }

  t(key: string, params?: Record<string, string | number>): string {
    this.languageService.currentLanguage();
    return this.languageService.translate(key, params);
  }

  setPlanTier(tier: PlanTier): void {
    this.planTier.set(tier);
    const d = this.draft();
    if (d.timerEnabled && !this.validateInterval(d.timerMinutes, tier).valid) {
      this.draft.update((cur) => ({ ...cur, timerMinutes: 30 }));
    }
    this.showToast(this.t('devMocks.commands.planToast', { tier }));
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
  }

  onSearchInput(value: string): void {
    this.searchInput.set(value);
    this.currentPage.set(1);
  }

  changePage(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.currentPage.set(page);
  }

  onItemsPerPageChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const next = Number(target.value);
    if (!Number.isFinite(next) || next <= 0) return;
    this.itemsPerPage.set(next);
    this.currentPage.set(1);
  }

  formatTimer(minutes: number | null | undefined): string {
    if (!minutes || minutes <= 0) {
      return this.t('devMocks.commands.timerNone');
    }
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }

  levelLabel(level: number, name?: string): string {
    const key = USER_LEVEL_NAMES[level] || USER_LEVELS[level] || 'everyone';
    if (key.startsWith('commands.')) {
      return this.t(key);
    }
    return name || key;
  }

  async loadCommands(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await fetch(
        `${LIVE_API}/commands/${CHANNEL_ID}?limit=100&language=en`
      );
      const body = (await res.json()) as {
        error?: boolean;
        message?: string;
        commands?: Array<Record<string, unknown>>;
        data?: { commands?: Array<Record<string, unknown>> };
      };
      if (!res.ok || body.error) {
        throw new Error(body.message || `HTTP ${res.status}`);
      }
      const raw = Array.isArray(body.commands)
        ? body.commands
        : Array.isArray(body.data?.commands)
          ? body.data.commands
          : [];

      const mapped = raw.map((row) => this.mapApiCommand(row));
      // Keep local-only commands when refreshing
      const locals = this.commands().filter((c) => c.local);
      const liveIds = new Set(mapped.map((c) => c.id));
      const keptLocals = locals.filter((c) => !liveIds.has(c.id));
      this.commands.set([...keptLocals, ...mapped]);
      this.currentPage.set(1);
      this.showToast(
        this.t('devMocks.commands.loadedToast', { count: mapped.length })
      );
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      this.loading.set(false);
    }
  }

  openCreate(): void {
    this.editingId.set(null);
    this.formError.set(null);
    this.draft.set(this.emptyDraft());
    this.showModal.set(true);
  }

  openEdit(command: MockCommand): void {
    if (command.reserved) {
      this.showToast(this.t('devMocks.commands.reservedLocked'));
      return;
    }
    this.editingId.set(command.id);
    this.formError.set(null);
    const mins = command.timerMinutes ?? 0;
    this.draft.set({
      name: command.name,
      cmd: command.cmd,
      message: command.message,
      description: command.description ?? '',
      cooldown: command.cooldown,
      userLevel: command.userLevel,
      enabled: command.enabled,
      timerEnabled: mins > 0,
      timerMinutes: mins > 0 ? mins : this.planTier() === 'free' ? 30 : 15
    });
    this.showModal.set(true);
  }

  closeModal(): void {
    this.showModal.set(false);
    this.editingId.set(null);
    this.formError.set(null);
  }

  updateDraft<K extends keyof CommandDraft>(key: K, value: CommandDraft[K]): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  setTimerEnabled(enabled: boolean): void {
    this.draft.update((d) => ({ ...d, timerEnabled: enabled }));
  }

  setTimerMinutes(value: number | string): void {
    const n = typeof value === 'number' ? value : Number(value);
    this.draft.update((d) => ({
      ...d,
      timerMinutes: Number.isFinite(n) ? n : d.timerMinutes
    }));
  }

  saveCommand(): void {
    const d = this.draft();
    const tier = this.planTier();
    const name = d.name.trim();
    const cmd = d.cmd.trim().replace(/^!+/, '').toLowerCase();
    const message = d.message.trim();
    const description = d.description.trim() || null;
    const editingId = this.editingId();

    if (!name) {
      this.formError.set(this.t('devMocks.commands.errName'));
      return;
    }
    if (!cmd || !/^[\w-]+$/.test(cmd)) {
      this.formError.set(this.t('devMocks.commands.errCmd'));
      return;
    }
    if (!message) {
      this.formError.set(this.t('devMocks.commands.errMessage'));
      return;
    }
    if (!Number.isInteger(d.cooldown) || d.cooldown < 0 || d.cooldown > 600) {
      this.formError.set(this.t('devMocks.commands.errCooldown'));
      return;
    }

    let timerMinutes: number | null = null;
    if (d.timerEnabled) {
      const check = this.validateInterval(d.timerMinutes, tier);
      if (!check.valid) {
        this.formError.set(check.error ?? this.t('devMocks.commands.errTimer'));
        return;
      }
      // Cap active timed commands by plan when enabling a new timer
      const othersTimed = this.commands().filter(
        (c) =>
          c.id !== editingId &&
          c.enabled &&
          (c.timerMinutes ?? 0) > 0
      ).length;
      const willBeActive = d.enabled;
      if (willBeActive && othersTimed >= TIER_TIMER_LIMITS[tier]) {
        this.formError.set(
          this.t('devMocks.commands.errTimerLimit', {
            limit: TIER_TIMER_LIMITS[tier],
            tier
          })
        );
        return;
      }
      timerMinutes = d.timerMinutes;
    }

    const duplicate = this.commands().some(
      (c) => c.cmd === cmd && c.id !== editingId
    );
    if (duplicate) {
      this.formError.set(this.t('devMocks.commands.errDuplicate', { cmd }));
      return;
    }

    const userLevelName = USER_LEVELS[d.userLevel] || 'everyone';

    if (!editingId) {
      const next: MockCommand = {
        id: `local-${Date.now()}`,
        name,
        cmd,
        message,
        description,
        cooldown: d.cooldown,
        userLevel: d.userLevel,
        userLevelName,
        enabled: d.enabled,
        reserved: false,
        timerMinutes,
        local: true
      };
      this.commands.update((list) => [next, ...list]);
      this.showToast(this.t('devMocks.commands.createdToast', { name }));
    } else {
      this.commands.update((list) =>
        list.map((c) =>
          c.id === editingId
            ? {
                ...c,
                name,
                cmd,
                message,
                description,
                cooldown: d.cooldown,
                userLevel: d.userLevel,
                userLevelName,
                enabled: d.enabled,
                timerMinutes
              }
            : c
        )
      );
      this.showToast(this.t('devMocks.commands.updatedToast', { name }));
    }

    this.closeModal();
  }

  toggleEnabled(command: MockCommand): void {
    if (command.reserved) {
      this.showToast(this.t('devMocks.commands.reservedLocked'));
      return;
    }
    // If enabling a timed command, respect timer cap
    if (!command.enabled && (command.timerMinutes ?? 0) > 0) {
      const active = this.activeTimers();
      if (active >= this.timerLimit()) {
        this.showToast(
          this.t('devMocks.commands.errTimerLimit', {
            limit: this.timerLimit(),
            tier: this.planTier()
          })
        );
        return;
      }
    }
    this.commands.update((list) =>
      list.map((c) =>
        c.id === command.id ? { ...c, enabled: !c.enabled } : c
      )
    );
    this.showToast(
      command.enabled
        ? this.t('devMocks.commands.disabledToast', { name: command.name })
        : this.t('devMocks.commands.enabledToast', { name: command.name })
    );
  }

  requestDelete(command: MockCommand): void {
    if (command.reserved) {
      this.showToast(this.t('devMocks.commands.reservedLocked'));
      return;
    }
    this.confirmDeleteId.set(command.id);
  }

  cancelDelete(): void {
    this.confirmDeleteId.set(null);
  }

  confirmDelete(): void {
    const id = this.confirmDeleteId();
    if (!id) return;
    const cmd = this.commands().find((c) => c.id === id);
    this.commands.update((list) => list.filter((c) => c.id !== id));
    this.confirmDeleteId.set(null);
    if (cmd) {
      this.showToast(this.t('devMocks.commands.deletedToast', { name: cmd.name }));
    }
  }

  private emptyDraft(): CommandDraft {
    return {
      name: '',
      cmd: '',
      message: '',
      description: '',
      cooldown: 10,
      userLevel: 1,
      enabled: true,
      timerEnabled: false,
      timerMinutes: 30
    };
  }

  private mapApiCommand(row: Record<string, unknown>): MockCommand {
    const cmd = String(row['cmd'] ?? '').toLowerCase();
    const id = String(row['id'] ?? row['_id'] ?? cmd);
    const seedTimer = SEED_TIMERS_BY_CMD[cmd];
    return {
      id,
      name: String(row['name'] ?? cmd),
      cmd,
      message: String(row['message'] ?? ''),
      description:
        row['description'] == null ? null : String(row['description']),
      cooldown: Number(row['cooldown'] ?? 10) || 10,
      userLevel: Number(row['userLevel'] ?? 1) || 1,
      userLevelName: String(row['userLevelName'] ?? USER_LEVELS[1]),
      enabled: row['enabled'] !== false,
      reserved: row['reserved'] === true,
      timerMinutes: seedTimer ?? null,
      local: false
    };
  }

  private validateInterval(
    minutes: number,
    tier: PlanTier
  ): { valid: boolean; error?: string } {
    if (!Number.isInteger(minutes) || minutes <= 0) {
      return { valid: false, error: this.t('devMocks.commands.errTimer') };
    }
    switch (tier) {
      case 'pro':
        if (minutes > MAX_TIMER_MINUTES) {
          return { valid: false, error: this.t('devMocks.commands.intervalPro') };
        }
        return { valid: true };
      case 'premium':
        if (minutes < 5 || minutes > MAX_TIMER_MINUTES || minutes % 5 !== 0) {
          return {
            valid: false,
            error: this.t('devMocks.commands.intervalPremium')
          };
        }
        return { valid: true };
      default:
        if (!(FREE_INTERVALS as readonly number[]).includes(minutes)) {
          return { valid: false, error: this.t('devMocks.commands.intervalFree') };
        }
        return { valid: true };
    }
  }

  private showToast(message: string): void {
    this.toast.set(message);
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.set(null);
      this.toastTimer = null;
    }, 2400);
  }
}
