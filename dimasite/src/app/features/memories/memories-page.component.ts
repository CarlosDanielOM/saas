import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, firstValueFrom, map, of, startWith, switchMap } from 'rxjs';

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
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

type MemoryFilterStatus = 'all' | 'pending_review' | 'confirmed' | 'rejected' | 'archived';
type MemoryAction = 'approve' | 'deny' | 'archive' | 'restore' | 'delete';

interface EditFormState {
  content: string;
  summary: string;
  type: MemoryType;
  risk: MemoryRisk;
}

const REVIEW_STATUSES: MemoryStatus[] = ['candidate', 'pending_review'];
const MEMORY_TYPES: MemoryType[] = ['preference', 'running_joke', 'known_user_fact', 'channel_lore', 'boundary'];
const MEMORY_RISKS: MemoryRisk[] = ['low', 'medium', 'high'];
/** Search only earns its space once the list is long enough to scan. */
const SEARCH_THRESHOLD = 6;

@Component({
  selector: 'app-memories-page',
  imports: [RouterLink, LfIconComponent],
  templateUrl: './memories-page.component.html',
  styleUrl: './memories-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'handleEscape()'
  }
})
export class MemoriesPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly memoriesApi = inject(MemoriesApiService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toastService = inject(ToastService);
  private readonly editDialog = viewChild<ElementRef<HTMLElement>>('editDialog');
  private readonly deleteDialog = viewChild<ElementRef<HTMLElement>>('deleteDialog');

  private readonly streamerParam$ = this.route.paramMap.pipe(
    map(() => getRouteParam(this.route, 'streamer') ?? '')
  );

  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: getRouteParam(this.route, 'streamer') ?? ''
  });

  readonly channelID = signal<string | null>(null);
  readonly canManage = toSignal(toObservable(this.channelID).pipe(
    switchMap((channelID) => channelID
      ? this.sessionAuth.checkPermission(channelID, 'memories:manage').pipe(
          catchError(() => of(false)),
          startWith(false)
        )
      : of(false))
  ), { initialValue: false });

  readonly memories = signal<Memory[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly hasLoaded = signal(false);
  /** Channel-wide counts, independent of the current filter. */
  readonly reviewCount = signal(0);
  readonly activeCount = signal(0);

  readonly filterStatus = signal<MemoryFilterStatus>('all');
  readonly filterType = signal<MemoryType | 'all'>('all');
  readonly filterRisk = signal<MemoryRisk | 'all'>('all');
  readonly searchQuery = signal('');

  readonly page = signal(1);
  readonly pageSize = signal(50);
  readonly hasMore = computed(() => this.memories().length < this.total());

  readonly editingMemory = signal<Memory | null>(null);
  readonly editForm = signal<EditFormState>({ content: '', summary: '', type: 'preference', risk: 'low' });
  readonly editSaving = signal(false);
  readonly editAttempted = signal(false);
  readonly editContentMissing = computed(() => !this.editForm().content.trim());

  readonly deletingMemory = signal<Memory | null>(null);
  readonly pendingActions = signal<Set<string>>(new Set());

  readonly memoryTypes = MEMORY_TYPES;
  readonly memoryRisks = MEMORY_RISKS;
  readonly statusFilters: MemoryFilterStatus[] = ['all', 'pending_review', 'confirmed', 'rejected', 'archived'];

  readonly planTier = computed(() => this.sessionAuth.getPlanTierForStreamer(this.streamer()));
  readonly modulePath = computed(() => {
    const streamer = this.streamer();
    return streamer ? ['/', streamer, 'modules'] : ['/'];
  });
  readonly summariesPath = computed(() => ['/', this.streamer(), 'modules', 'stream-summaries']);

  readonly showSearch = computed(() => this.total() > SEARCH_THRESHOLD || this.searchQuery().length > 0);
  readonly filtersActive = computed(() => this.filterType() !== 'all' || this.filterRisk() !== 'all' || this.filterStatus() !== 'all' || !!this.searchQuery());

  readonly displayedMemories = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return this.memories();
    return this.memories().filter(
      (m) =>
        m.content.toLowerCase().includes(query) ||
        m.summary.toLowerCase().includes(query) ||
        (m.subject.username || '').toLowerCase().includes(query)
    );
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
      if (!channelID || this.lastLoadedChannelID === channelID) return;
      this.lastLoadedChannelID = channelID;
      void this.loadMemories(true);
      void this.refreshCounts();
    });

    effect(() => {
      this.filterStatus();
      this.filterType();
      this.filterRisk();
      if (this.hasLoaded() && this.channelID()) {
        void this.loadMemories(true);
      }
    });

    effect(() => {
      const target = this.deleteDialog() ?? this.editDialog();
      if (target) queueMicrotask(() => target.nativeElement.focus());
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  handleEscape(): void {
    if (this.deletingMemory()) {
      this.deletingMemory.set(null);
      return;
    }
    if (this.editingMemory()) this.closeEditModal();
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
      const statuses: MemoryStatus[] =
        statusFilter === 'all'
          ? ['candidate', 'pending_review', 'confirmed', 'rejected', 'archived']
          : statusFilter === 'pending_review'
            ? REVIEW_STATUSES
            : [statusFilter];
      const types: MemoryType[] = this.filterType() === 'all' ? [] : [this.filterType() as MemoryType];
      const risks: MemoryRisk[] = this.filterRisk() === 'all' ? [] : [this.filterRisk() as MemoryRisk];
      const skip = (this.page() - 1) * this.pageSize();

      const result = await firstValueFrom(
        this.memoriesApi.listMemories(channelID, { statuses, types, risks, limit: this.pageSize(), skip })
      );

      if (reset) {
        this.memories.set(result.items);
      } else {
        this.memories.update((current) => [...current, ...result.items]);
      }
      this.total.set(result.total);
      this.hasLoaded.set(true);
    } catch {
      this.error.set(this.t('modules.memories.v2.loadFailed'));
    } finally {
      this.loading.set(false);
    }
  }

  private async refreshCounts(): Promise<void> {
    const channelID = this.channelID();
    if (!channelID) return;
    try {
      const [review, active] = await Promise.all([
        firstValueFrom(this.memoriesApi.listMemories(channelID, { statuses: REVIEW_STATUSES, limit: 1 })),
        firstValueFrom(this.memoriesApi.listMemories(channelID, { statuses: ['confirmed'], limit: 1 }))
      ]);
      this.reviewCount.set(review.total);
      this.activeCount.set(active.total);
    } catch {
      // Counts are a convenience; the list itself reports load errors.
    }
  }

  async loadMore(): Promise<void> {
    if (this.loading() || !this.hasMore()) return;
    this.page.update((p) => p + 1);
    await this.loadMemories(false);
  }

  setStatus(status: MemoryFilterStatus): void {
    this.filterStatus.set(status);
  }

  setType(type: MemoryType | 'all'): void {
    this.filterType.set(type);
  }

  onRiskFilterChange(event: Event): void {
    this.filterRisk.set((event.target as HTMLSelectElement).value as MemoryRisk | 'all');
  }

  onSearchChange(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
  }

  clearFilters(): void {
    this.searchQuery.set('');
    this.filterType.set('all');
    this.filterRisk.set('all');
    this.filterStatus.set('all');
  }

  isReview(memory: Memory): boolean {
    return REVIEW_STATUSES.includes(memory.status);
  }

  statusLabel(status: MemoryStatus): string {
    return this.t('modules.memories.v2.status.' + (status === 'candidate' ? 'pending_review' : status));
  }

  typeLabel(type: MemoryType): string {
    return this.t('modules.memories.v2.type.' + type);
  }

  subjectLabel(memory: Memory): string {
    if (memory.subject.scope === 'channel' || !memory.subject.username) return this.t('modules.memories.v2.wholeChannel');
    return this.t('modules.memories.v2.aboutUser', { username: memory.subject.username });
  }

  usedLabel(memory: Memory): string {
    if (!memory.useCount) return this.t('modules.memories.v2.neverUsed');
    return this.t(memory.useCount === 1 ? 'modules.memories.v2.usedOnce' : 'modules.memories.v2.used', { count: memory.useCount });
  }

  formatDate(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(this.languageService.currentLanguage() === 'es' ? 'es' : 'en', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  isPending(memory: Memory): boolean {
    return this.pendingActions().has(memory._id);
  }

  // Editing

  openEditModal(memory: Memory): void {
    if (!this.canManage()) return;
    this.editingMemory.set(memory);
    this.editAttempted.set(false);
    this.editForm.set({ content: memory.content, summary: memory.summary, type: memory.type, risk: memory.risk });
  }

  closeEditModal(): void {
    if (this.editSaving()) return;
    this.editingMemory.set(null);
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

  setEditRisk(risk: MemoryRisk): void {
    this.editForm.update((f) => ({ ...f, risk }));
  }

  async saveEdit(): Promise<void> {
    if (!this.canManage()) return;
    this.editAttempted.set(true);
    const memory = this.editingMemory();
    const channelID = this.channelID();
    if (!memory || !channelID || this.editContentMissing()) return;

    this.editSaving.set(true);
    try {
      const form = this.editForm();
      const updated = await firstValueFrom(
        this.memoriesApi.updateMemory(channelID, memory._id, {
          content: form.content.trim(),
          summary: form.summary.trim() || form.content.trim(),
          type: form.type,
          risk: form.risk
        })
      );
      this.memories.update((list) => list.map((m) => (m._id === updated._id ? updated : m)));
      this.editSaving.set(false);
      this.closeEditModal();
      this.toastService.success(this.t('modules.memories.toasts.updateSuccessTitle'), this.t('modules.memories.toasts.updateSuccessMessage'));
    } catch (err) {
      const message = err instanceof Error ? err.message : this.t('modules.memories.v2.actionFailed');
      this.toastService.error(this.t('modules.memories.v2.actionFailed'), message);
    } finally {
      this.editSaving.set(false);
    }
  }

  // Status changes and delete

  askDelete(memory: Memory): void {
    if (this.canManage()) this.deletingMemory.set(memory);
  }

  async confirmDelete(): Promise<void> {
    const memory = this.deletingMemory();
    if (!memory) return;
    this.deletingMemory.set(null);
    await this.runAction('delete', memory);
  }

  async runAction(action: MemoryAction, memory: Memory): Promise<void> {
    const channelID = this.channelID();
    if (!this.canManage() || !channelID || this.isPending(memory)) return;

    this.pendingActions.update((set) => new Set(set).add(memory._id));
    try {
      if (action === 'delete') {
        await firstValueFrom(this.memoriesApi.deleteMemory(channelID, memory._id));
        this.memories.update((list) => list.filter((m) => m._id !== memory._id));
        this.total.update((count) => Math.max(0, count - 1));
      } else {
        const status: MemoryStatus = action === 'deny' ? 'rejected' : action === 'archive' ? 'archived' : 'confirmed';
        await firstValueFrom(this.memoriesApi.updateMemoryStatus(channelID, memory._id, status));
        const stillMatches = this.filterStatus() === 'all' || (this.filterStatus() === status);
        this.memories.update((list) => stillMatches
          ? list.map((m) => (m._id === memory._id ? { ...m, status } : m))
          : list.filter((m) => m._id !== memory._id));
        if (!stillMatches) this.total.update((count) => Math.max(0, count - 1));
      }
      this.toastService.success(this.t(`modules.memories.v2.done.${action}`), memory.summary || memory.content);
      void this.refreshCounts();
    } catch (err) {
      const message = err instanceof Error ? err.message : this.t('modules.memories.v2.actionFailed');
      this.toastService.error(this.t('modules.memories.v2.actionFailed'), message);
    } finally {
      this.pendingActions.update((set) => {
        const next = new Set(set);
        next.delete(memory._id);
        return next;
      });
    }
  }
}
