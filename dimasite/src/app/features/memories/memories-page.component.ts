import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom, map } from 'rxjs';

import {
  Memory,
  MemoryRisk,
  MemoryStatus,
  MemoryType
} from '../../models/memory.model';
import { LanguageService } from '../../services/language.service';
import { MemoriesApiService } from '../../services/memories-api.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

type MemoryFilterStatus = 'all' | Exclude<MemoryStatus, 'archived'> | 'archived';

interface EditFormState {
  content: string;
  summary: string;
  type: MemoryType;
  risk: MemoryRisk;
}

interface PendingAction {
  memoryId: string;
  action: 'approve' | 'deny' | 'archive' | 'delete';
}

@Component({
  selector: 'app-memories-page',
  imports: [RouterLink],
  templateUrl: './memories-page.component.html',
  styleUrl: './memories-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MemoriesPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly memoriesApi = inject(MemoriesApiService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toastService = inject(ToastService);

  private readonly streamerParam$ = this.route.paramMap.pipe(
    map(() => getRouteParam(this.route, 'streamer') ?? '')
  );

  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: getRouteParam(this.route, 'streamer') ?? ''
  });

  readonly channelID = signal<string | null>(null);

  readonly memories = signal<Memory[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly hasLoaded = signal(false);

  readonly filterStatus = signal<MemoryFilterStatus>('all');
  readonly filterType = signal<MemoryType | 'all'>('all');
  readonly filterRisk = signal<MemoryRisk | 'all'>('all');
  readonly searchQuery = signal('');

  readonly page = signal(1);
  readonly pageSize = signal(50);
  readonly hasMore = computed(() => this.memories().length < this.total());

  readonly editModalOpen = signal(false);
  readonly editingMemory = signal<Memory | null>(null);
  readonly editForm = signal<EditFormState>({
    content: '',
    summary: '',
    type: 'preference',
    risk: 'low'
  });
  readonly editSaving = signal(false);

  readonly pendingActions = signal<Map<string, PendingAction>>(new Map());

  readonly confirmDialogOpen = signal(false);
  readonly confirmAction = signal<'approve' | 'deny' | 'archive' | 'delete' | null>(null);
  readonly confirmMemory = signal<Memory | null>(null);

  readonly planTier = computed(() => {
    const tier = this.sessionAuth.session()?.appUser.plan_tier ?? 'free';
    if (tier === 'premium' || tier === 'pro') return tier;
    return 'free';
  });

  readonly pendingCount = computed(
    () =>
      this.memories().filter(
        (m) => m.status === 'pending_review' || m.status === 'candidate'
      ).length
  );

  readonly activeCount = computed(
    () => this.memories().filter((m) => m.status === 'confirmed').length
  );

  readonly filterStatusOptions = computed<Array<{ value: MemoryFilterStatus; labelKey: string }>>(
    () => [
      { value: 'all', labelKey: 'modules.memories.filters.all' },
      { value: 'pending_review', labelKey: 'modules.memories.status.pending_review' },
      { value: 'confirmed', labelKey: 'modules.memories.status.confirmed' },
      { value: 'rejected', labelKey: 'modules.memories.status.rejected' },
      { value: 'archived', labelKey: 'modules.memories.status.archived' }
    ]
  );

  readonly memoryTypeOptions = computed<Array<{ value: MemoryType | 'all'; labelKey: string }>>(
    () => [
      { value: 'all', labelKey: 'modules.memories.filters.allTypes' },
      { value: 'preference', labelKey: 'modules.memories.type.preference' },
      { value: 'running_joke', labelKey: 'modules.memories.type.running_joke' },
      { value: 'known_user_fact', labelKey: 'modules.memories.type.known_user_fact' },
      { value: 'channel_lore', labelKey: 'modules.memories.type.channel_lore' },
      { value: 'boundary', labelKey: 'modules.memories.type.boundary' }
    ]
  );

  readonly memoryRiskOptions = computed<Array<{ value: MemoryRisk | 'all'; labelKey: string }>>(
    () => [
      { value: 'all', labelKey: 'modules.memories.filters.allRisks' },
      { value: 'low', labelKey: 'modules.memories.risk.low' },
      { value: 'medium', labelKey: 'modules.memories.risk.medium' },
      { value: 'high', labelKey: 'modules.memories.risk.high' }
    ]
  );

  readonly displayedMemories = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return this.memories();

    return this.memories().filter(
      (m) =>
        m.content.toLowerCase().includes(query) ||
        m.summary.toLowerCase().includes(query) ||
        m.subject.username.toLowerCase().includes(query)
    );
  });

  readonly modulePath = computed(() => {
    const streamer = this.streamer();
    return streamer ? ['/', streamer, 'modules'] : ['/'];
  });

  private lastLoadedChannelID = '';

  constructor() {
    effect(() => {
      const streamer = this.streamer();
      if (!streamer) {
        this.channelID.set(null);
        return;
      }

      void firstValueFrom(this.sessionAuth.resolveChannelID(streamer)).then((channelID) => {
        this.channelID.set(channelID);
      });
    });

    effect(() => {
      const channelID = this.channelID();
      if (!channelID) return;

      if (this.lastLoadedChannelID === channelID) return;
      this.lastLoadedChannelID = channelID;
      void this.loadMemories(true);
    });

    effect(() => {
      this.filterStatus();
      this.filterType();
      this.filterRisk();

      if (this.hasLoaded() && this.channelID()) {
        void this.loadMemories(true);
      }
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  onEditContentChange(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.editForm.update((f) => ({ ...f, content: value }));
  }

  onEditSummaryChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.editForm.update((f) => ({ ...f, summary: value }));
  }

  onEditTypeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as MemoryType;
    this.editForm.update((f) => ({ ...f, type: value }));
  }

  onEditRiskChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as MemoryRisk;
    this.editForm.update((f) => ({ ...f, risk: value }));
  }

  async loadMemories(reset = false): Promise<void> {
    const channelID = this.channelID();
    if (!channelID) return;

    if (reset) {
      this.page.set(1);
      this.memories.set([]);
    }

    this.loading.set(true);
    this.error.set(null);

    try {
      const statusFilter = this.filterStatus();
      const typeFilter = this.filterType();
      const riskFilter = this.filterRisk();

      const statuses: MemoryStatus[] =
        statusFilter === 'all'
          ? ['candidate', 'pending_review', 'confirmed', 'rejected', 'archived']
          : [statusFilter as MemoryStatus];

      const types: MemoryType[] = typeFilter === 'all' ? [] : [typeFilter as MemoryType];
      const risks: MemoryRisk[] = riskFilter === 'all' ? [] : [riskFilter as MemoryRisk];
      const skip = (this.page() - 1) * this.pageSize();

      const result = await firstValueFrom(
        this.memoriesApi.listMemories(channelID, {
          statuses,
          types,
          risks,
          limit: this.pageSize(),
          skip
        })
      );

      if (reset) {
        this.memories.set(result.items);
      } else {
        this.memories.update((current) => [...current, ...result.items]);
      }
      this.total.set(result.total);
      this.hasLoaded.set(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load memories';
      this.error.set(message);
    } finally {
      this.loading.set(false);
    }
  }

  async loadMore(): Promise<void> {
    if (this.loading() || !this.hasMore()) return;
    this.page.update((p) => p + 1);
    await this.loadMemories(false);
  }

  onStatusFilterChange(status: MemoryFilterStatus): void {
    this.filterStatus.set(status);
  }

  onTypeFilterChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as MemoryType | 'all';
    this.filterType.set(value);
  }

  onRiskFilterChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as MemoryRisk | 'all';
    this.filterRisk.set(value);
  }

  onSearchChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);
  }

  clearSearch(): void {
    this.searchQuery.set('');
  }

  openEditModal(memory: Memory): void {
    this.editingMemory.set(memory);
    this.editForm.set({
      content: memory.content,
      summary: memory.summary,
      type: memory.type,
      risk: memory.risk
    });
    this.editModalOpen.set(true);
  }

  closeEditModal(): void {
    if (this.editSaving()) return;
    this.editModalOpen.set(false);
    this.editingMemory.set(null);
  }

  onEditBackdrop(event: Event): void {
    if (event.target === event.currentTarget) {
      this.closeEditModal();
    }
  }

  async saveEdit(): Promise<void> {
    const memory = this.editingMemory();
    const channelID = this.channelID();
    if (!memory || !channelID) return;

    this.editSaving.set(true);

    try {
      const form = this.editForm();
      const updated = await firstValueFrom(
        this.memoriesApi.updateMemory(channelID, memory._id, {
          content: form.content,
          summary: form.summary,
          type: form.type,
          risk: form.risk
        })
      );

      this.memories.update((list) => list.map((m) => (m._id === updated._id ? updated : m)));

      this.closeEditModal();
      this.toastService.success(
        this.t('modules.memories.toasts.updateSuccessTitle'),
        this.t('modules.memories.toasts.updateSuccessMessage')
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update memory';
      this.toastService.error(this.t('modules.memories.toasts.updateSuccessTitle'), message);
    } finally {
      this.editSaving.set(false);
    }
  }

  openConfirmDialog(action: 'approve' | 'deny' | 'archive' | 'delete', memory: Memory): void {
    this.confirmAction.set(action);
    this.confirmMemory.set(memory);
    this.confirmDialogOpen.set(true);
  }

  closeConfirmDialog(): void {
    this.confirmDialogOpen.set(false);
    this.confirmAction.set(null);
    this.confirmMemory.set(null);
  }

  onConfirmBackdrop(event: Event): void {
    if (event.target === event.currentTarget) {
      this.closeConfirmDialog();
    }
  }

  async confirmActionHandler(): Promise<void> {
    const action = this.confirmAction();
    const memory = this.confirmMemory();
    const channelID = this.channelID();

    if (!action || !memory || !channelID) {
      this.closeConfirmDialog();
      return;
    }

    const pendingKey = `${action}-${memory._id}`;
    this.pendingActions.update((m) => new Map(m).set(pendingKey, { memoryId: memory._id, action }));

    this.closeConfirmDialog();

    try {
      switch (action) {
        case 'approve':
          await firstValueFrom(
            this.memoriesApi.updateMemoryStatus(channelID, memory._id, 'confirmed')
          );
          this.toastService.success(
            this.t('modules.memories.toasts.approveSuccessTitle'),
            this.t('modules.memories.toasts.approveSuccessMessage')
          );
          break;
        case 'deny':
          await firstValueFrom(
            this.memoriesApi.updateMemoryStatus(channelID, memory._id, 'rejected')
          );
          this.toastService.success(
            this.t('modules.memories.toasts.denySuccessTitle'),
            this.t('modules.memories.toasts.denySuccessMessage')
          );
          break;
        case 'archive':
          await firstValueFrom(
            this.memoriesApi.updateMemoryStatus(channelID, memory._id, 'archived')
          );
          this.toastService.success(
            this.t('modules.memories.toasts.archiveSuccessTitle'),
            this.t('modules.memories.toasts.archiveSuccessMessage')
          );
          break;
        case 'delete':
          await firstValueFrom(this.memoriesApi.deleteMemory(channelID, memory._id));
          this.toastService.success(
            this.t('modules.memories.toasts.deleteSuccessTitle'),
            this.t('modules.memories.toasts.deleteSuccessMessage')
          );
          break;
      }

      if (action === 'delete') {
        this.memories.update((list) => list.filter((m) => m._id !== memory._id));
      } else {
        const newStatus: MemoryStatus =
          action === 'approve' ? 'confirmed' : action === 'deny' ? 'rejected' : 'archived';
        this.memories.update((list) =>
          list.map((m) => (m._id === memory._id ? { ...m, status: newStatus } : m))
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed';
      this.toastService.error(this.t('modules.memories.actions.confirm'), message);
    } finally {
      this.pendingActions.update((m) => {
        const newMap = new Map(m);
        newMap.delete(pendingKey);
        return newMap;
      });
    }
  }

  isActionPending(memoryId: string, action: 'approve' | 'deny' | 'archive' | 'delete'): boolean {
    return this.pendingActions().has(`${action}-${memoryId}`);
  }

  riskChipClass(risk: MemoryRisk): string {
    return `lf-chip lf-chip--risk-${risk}`;
  }

  statusChipClass(status: MemoryStatus): string {
    return `lf-chip lf-chip--status-${status.replace('_', '-')}`;
  }

  riskLabelKey(risk: MemoryRisk): string {
    return `modules.memories.risk.${risk}`;
  }

  statusLabelKey(status: MemoryStatus): string {
    return `modules.memories.status.${status}`;
  }

  typeLabelKey(type: MemoryType): string {
    return `modules.memories.type.${type}`;
  }

  getConfirmMessage(action: 'approve' | 'deny' | 'archive' | 'delete'): string {
    switch (action) {
      case 'approve':
        return this.t('modules.memories.confirmApprove');
      case 'deny':
        return this.t('modules.memories.confirmDeny');
      case 'archive':
        return this.t('modules.memories.confirmArchive');
      case 'delete':
        return this.t('modules.memories.confirmDelete');
    }
  }

  getConfirmTitle(action: 'approve' | 'deny' | 'archive' | 'delete'): string {
    switch (action) {
      case 'approve':
        return this.t('modules.memories.actions.approve');
      case 'deny':
        return this.t('modules.memories.actions.deny');
      case 'archive':
        return this.t('modules.memories.actions.archive');
      case 'delete':
        return this.t('modules.memories.actions.delete');
    }
  }

  formatDate(dateStr: string | undefined): string {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  formatConfidence(confidence: number): string {
    return `${Math.round(confidence * 100)}%`;
  }

  getSubjectLabel(memory: Memory): string {
    if (memory.subject.scope === 'channel') {
      return this.t('modules.memories.fields.channelwide');
    }
    return this.t('modules.memories.fields.userSpecific', {
      username: memory.subject.username
    });
  }
}
