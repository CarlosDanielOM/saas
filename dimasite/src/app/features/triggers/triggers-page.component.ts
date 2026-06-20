import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
  type ElementRef,
  type OnDestroy,
  type OnInit
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  ArrowLeft,
  AudioLines,
  Check,
  Copy,
  Edit3,
  Globe2,
  HardDrive,
  Image,
  Info,
  LibraryBig,
  LucideAngularModule,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  Video,
  X,
  Zap,
  Eye,
  Pause,
  type LucideIconData
} from 'lucide-angular';
import { firstValueFrom, map } from 'rxjs';

import { LoadingIndicatorComponent } from '../../components/loading';
import { SafeUrlPipe } from '../../pipes/safe-url.pipe';
import { DisplayNamePipe } from '../../pipes/display-name.pipe';
import { ConfirmationModalComponent } from '../../shared/confirmation-modal/confirmation-modal.component';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { PublicLibraryModalComponent } from './components/public-library-modal.component';
import {
  CreateTriggerRequest,
  TriggerRewardDraft,
  MediaAsset,
  MediaLibraryItem,
  MediaLibraryMeta,
  MediaScope,
  MediaType,
  PlanTier,
  TriggerRecord,
  TriggerTestPayload,
  UpdateTriggerRequest
} from './triggers.model';
import { TriggersService } from './triggers.service';

type TriggerFormMode = 'create' | 'edit';
type DeleteTarget = 'trigger' | 'library-item';
type MediaFilter = 'all' | MediaType;

interface TriggerFormState {
  name: string;
  libraryItemID: string;
  volume: number;
  reward: TriggerRewardFormState;
}

interface TriggerRewardFormState {
  enabled: boolean;
  title: string;
  prompt: string;
  cost: number;
  message: string;
  cooldown: number;
  userInput: boolean;
  skipQueue: boolean;
  costChange: number;
  returnToOriginalCost: boolean;
  duration: number;
  backgroundColor: string;
}

interface UploadFormState {
  name: string;
  scope: MediaScope;
  file: File | null;
}

interface DeleteState {
  type: DeleteTarget;
  id: string;
  label: string;
}

const DEFAULT_LIBRARY_META: MediaLibraryMeta = {
  planTier: 'free',
  quotaBytesUsed: 0,
  quotaBytesLimit: 50 * 1024 * 1024
};

const SUPPORTED_TRIGGER_MEDIA_TYPES = new Set<MediaType>(['video', 'audio']);
const TRIGGER_NAME_REGEX = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$/;
const SAFE_NAME_MAX_LENGTH = 60;

@Component({
  selector: 'app-triggers-page',
  imports: [
    RouterLink,
    LucideAngularModule,
    LoadingIndicatorComponent,
    SafeUrlPipe,
    DisplayNamePipe,
    ConfirmationModalComponent,
    PublicLibraryModalComponent
  ],
  styleUrl: './triggers-page.component.css',
  templateUrl: './triggers-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'triggers-page-host',
    '(document:keydown.escape)': 'handleEscape()'
  }
})
export class TriggersPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly languageService = inject(LanguageService);
  private readonly linksService = inject(LinksService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly triggersService = inject(TriggersService);
  private readonly toastService = inject(ToastService);

  private cooldownTimer: number | null = null;
  private testPreviewReady = false;
  private pendingPreviewPayload: TriggerTestPayload | null = null;

  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('uploadFileInput');
  readonly testPreviewFrame = viewChild<ElementRef<HTMLIFrameElement>>('testPreviewFrame');

  readonly backIcon = ArrowLeft;
  readonly sparklesIcon = Sparkles;
  readonly refreshIcon = RefreshCw;
  readonly plusIcon = Plus;
  readonly uploadIcon = Upload;
  readonly copyIcon = Copy;
  readonly copiedIcon = Check;
  readonly playIcon = Play;
  readonly deleteIcon = Trash2;
  readonly editIcon = Edit3;
  readonly libraryIcon = LibraryBig;
  readonly marketplaceIcon = Globe2;
  readonly storageIcon = HardDrive;
  readonly searchIcon = Search;
  readonly videoIcon = Video;
  readonly audioIcon = AudioLines;
  readonly imageIcon = Image;
  readonly triggerIcon = Zap;
  readonly alertIcon = ShieldAlert;
  readonly closeIcon = X;
  readonly infoIcon = Info;
  readonly previewIcon = Eye;
  readonly pauseIcon = Pause;

  readonly streamer = toSignal(this.route.paramMap.pipe(map(() => getRouteParam(this.route, 'streamer'))), {
    requireSync: true
  });
  readonly channelID = signal<string | null>(null);
  readonly triggers = signal<TriggerRecord[]>([]);
  readonly libraryItems = signal<MediaLibraryItem[]>([]);
  readonly activePreviewAsset = signal<MediaAsset | null>(null);
  readonly isAudioPlaying = signal(false);
  private previewAudio: HTMLAudioElement | null = null;
  readonly libraryMeta = signal<MediaLibraryMeta>(DEFAULT_LIBRARY_META);

  readonly isLoadingTriggers = signal(true);
  readonly isLoadingLibrary = signal(true);
  readonly isSubmittingTrigger = signal(false);
  readonly isUploadingMedia = signal(false);
  readonly isSendingTest = signal(false);
  readonly pageError = signal<string | null>(null);

  readonly refreshCooldown = signal(0);
  readonly copiedObsLink = signal(false);
  readonly mediaFilter = signal<MediaFilter>('all');
  readonly librarySearch = signal('');
  readonly isPublicLibraryModalOpen = signal(false);

  readonly isTriggerModalOpen = signal(false);
  readonly triggerFormMode = signal<TriggerFormMode>('create');
  readonly editingTriggerId = signal<string | null>(null);
  readonly triggerForm = signal<TriggerFormState>(this.createDefaultTriggerForm());

  readonly isUploadModalOpen = signal(false);
  readonly isDraggingUpload = signal(false);
  readonly uploadForm = signal<UploadFormState>({
    name: '',
    scope: 'private',
    file: null
  });

  readonly isTestModalOpen = signal(false);
  readonly testingTrigger = signal<TriggerRecord | null>(null);
  readonly pendingDelete = signal<DeleteState | null>(null);

  readonly planTier = computed<PlanTier>(() => this.libraryMeta().planTier || this.sessionAuth.session()?.appUser.plan_tier || 'free');
  readonly obsOverlayUrl = computed(() => {
    const channelId = this.channelID();
    return channelId ? `${this.linksService.getApiUrl()}/overlays/triggers/${channelId}` : '';
  });
  readonly testPreviewOverlayUrl = computed(() => {
    const channelId = this.channelID();
    return channelId ? `${this.linksService.getApiUrl()}/overlays/triggers/${channelId}?preview=1` : '';
  });
  readonly quotaPercent = computed(() => {
    const meta = this.libraryMeta();
    if (!meta.quotaBytesLimit) {
      return 0;
    }

    return Math.max(0, Math.min(100, Math.round((meta.quotaBytesUsed / meta.quotaBytesLimit) * 100)));
  });
  readonly planTierLabel = computed(() => this.planTier().toUpperCase());
  readonly libraryCount = computed(() => this.libraryItems().length);
  readonly libraryAssetIds = computed(() => this.libraryItems().map((item) => item.assetID));
  readonly triggerCapableLibraryItems = computed(() =>
    this.libraryItems().filter((item) => item.asset && SUPPORTED_TRIGGER_MEDIA_TYPES.has(item.asset.mediaType))
  );
  readonly selectedTriggerFormItem = computed(() => {
    const libraryItemId = this.triggerForm().libraryItemID;
    return this.libraryItems().find((item) => item._id === libraryItemId) || null;
  });
  readonly displayedLibraryItems = computed(() => {
    const query = this.librarySearch().trim().toLowerCase();
    const filter = this.mediaFilter();

    return this.libraryItems().filter((item) => {
      const asset = item.asset;
      if (!asset) {
        return false;
      }

      if (filter !== 'all' && asset.mediaType !== filter) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack = [item.localAlias, asset.displayName, asset.ownerChannelName, asset.mediaType]
        .filter(Boolean)
        .map((value) => String(value).replace(/_+/g, ' ').trim())
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  });
  readonly triggerFormErrors = computed(() => {
    const form = this.triggerForm();
    return {
      name: form.name.trim().length === 0,
      invalidName: form.name.trim().length > 0 && !TRIGGER_NAME_REGEX.test(form.name.trim()),
      libraryItemID: this.triggerFormMode() === 'create' && form.libraryItemID.trim().length === 0,
      volume: !Number.isFinite(form.volume) || form.volume < 0 || form.volume > 100,
      rewardTitle: form.reward.enabled && form.reward.title.trim().length === 0,
      rewardCost: form.reward.enabled && (!Number.isFinite(form.reward.cost) || form.reward.cost < 0),
      rewardCooldown: form.reward.enabled && (!Number.isFinite(form.reward.cooldown) || form.reward.cooldown < 0),
      rewardDuration: form.reward.enabled && (!Number.isFinite(form.reward.duration) || form.reward.duration < 0),
      rewardCostChange: form.reward.enabled && !Number.isFinite(form.reward.costChange)
    };
  });
  readonly uploadLimitLabel = computed(() => this.formatBytes(this.getUploadLimitBytes(this.planTier())));
  readonly isDeleteModalOpen = computed(() => this.pendingDelete() !== null);
  readonly filterOptions: MediaFilter[] = ['all', 'video', 'audio', 'image', 'gif'];
  readonly editingTrigger = computed(() => this.triggers().find((item) => item._id === this.editingTriggerId()) || null);
  readonly hasLinkedRewardInEditor = computed(() => Boolean(this.editingTrigger()?.reward?.rewardID));

  async ngOnInit(): Promise<void> {
    const routeStreamer = this.streamer()?.trim() || '';
    if (!routeStreamer) {
      this.pageError.set(this.t('triggers.errors.missingStreamer'));
      this.toastService.error(this.t('triggers.errors.loadTitle'), this.t('triggers.errors.missingStreamer'));
      return;
    }

    const resolvedChannelId = await firstValueFrom(this.sessionAuth.resolveChannelID(routeStreamer));
    if (!resolvedChannelId) {
      this.pageError.set(this.t('triggers.errors.loadMessage'));
      this.toastService.error(this.t('triggers.errors.loadTitle'), this.t('triggers.errors.loadMessage'));
      return;
    }

    this.channelID.set(resolvedChannelId);
    this.loadAll();
    this.startCooldownTimer();
  }

  ngOnDestroy(): void {
    this.stopPreview();
    if (this.cooldownTimer !== null) {
      window.clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  getTriggerAsset(trigger: TriggerRecord): MediaAsset | null {
    const libraryItem = this.libraryItems().find((item) => item._id === trigger.libraryItemID)
      || this.libraryItems().find((item) => item.assetID === trigger.assetID);
    return libraryItem?.asset || null;
  }

  openPreviewModal(event: MouseEvent, asset: MediaAsset): void {
    event.stopPropagation();
    this.stopPreview();
    this.activePreviewAsset.set(asset);
    if (asset.mediaType === 'audio' && asset.playbackUrl) {
      this.playAudioPreview(asset.playbackUrl);
    }
  }

  closePreviewModal(): void {
    this.stopPreview();
    this.activePreviewAsset.set(null);
  }

  toggleAudioPlayPause(): void {
    if (!this.previewAudio) {
      const asset = this.activePreviewAsset();
      if (asset && asset.playbackUrl) {
        this.playAudioPreview(asset.playbackUrl);
      }
      return;
    }
    if (this.previewAudio.paused) {
      this.previewAudio.play();
    } else {
      this.previewAudio.pause();
    }
  }

  stopPreview(): void {
    if (this.previewAudio) {
      this.previewAudio.pause();
      this.previewAudio = null;
    }
    this.isAudioPlaying.set(false);
  }

  private playAudioPreview(url: string): void {
    try {
      this.previewAudio = new Audio(url);
      this.previewAudio.volume = 0.5;
      this.previewAudio.addEventListener('play', () => this.isAudioPlaying.set(true));
      this.previewAudio.addEventListener('pause', () => this.isAudioPlaying.set(false));
      this.previewAudio.addEventListener('ended', () => {
        this.isAudioPlaying.set(false);
        this.previewAudio = null;
      });
      this.previewAudio.addEventListener('error', () => {
        this.isAudioPlaying.set(false);
        this.previewAudio = null;
        this.toastService.error(this.t('triggers.marketplace.errorTitle'), 'Failed to play audio asset.');
      });
      this.previewAudio.play();
    } catch (err) {
      this.isAudioPlaying.set(false);
      this.toastService.error(this.t('triggers.marketplace.errorTitle'), 'Failed to play audio asset.');
    }
  }

  handleEscape(): void {
    if (this.isTriggerModalOpen()) {
      this.closeTriggerModal();
      return;
    }

    if (this.isUploadModalOpen()) {
      this.closeUploadModal();
      return;
    }

    if (this.isTestModalOpen()) {
      this.closeTestModal();
      return;
    }

    if (this.isPublicLibraryModalOpen()) {
      this.closePublicLibraryModal();
      return;
    }

    if (this.pendingDelete()) {
      this.pendingDelete.set(null);
    }
  }

  goBack(): void {
    const streamer = this.streamer();
    void this.router.navigate(streamer ? ['/', streamer, 'modules'] : ['/']);
  }

  loadAll(force = false): void {
    const channelId = this.channelID();
    if (!channelId) {
      return;
    }

    this.loadTriggers(channelId, force);
    this.loadLibrary(channelId, force);
  }

  refreshAll(): void {
    if (this.refreshCooldown() > 0) {
      this.toastService.warning(
        this.t('triggers.cooldownTitle'),
        this.t('triggers.cooldownMessage', { seconds: this.refreshCooldown() })
      );
      return;
    }

    this.loadAll(true);
    this.refreshCooldown.set(20);
    this.toastService.success(this.t('triggers.refreshTitle'), this.t('triggers.refreshMessage'));
  }

  copyObsLink(): void {
    const url = this.obsOverlayUrl();
    if (!url) {
      return;
    }

    const onSuccess = () => {
      this.copiedObsLink.set(true);
      window.setTimeout(() => this.copiedObsLink.set(false), 1800);
      this.toastService.success(this.t('triggers.obsCopiedTitle'), this.t('triggers.obsCopiedMessage'));
    };

    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url).then(onSuccess).catch(() => this.fallbackCopy(url, onSuccess));
      return;
    }

    this.fallbackCopy(url, onSuccess);
  }

  openCreateModal(): void {
    const firstLibraryItem = this.triggerCapableLibraryItems()[0];
    this.triggerFormMode.set('create');
    this.editingTriggerId.set(null);
    this.triggerForm.set({
      ...this.createDefaultTriggerForm(),
      libraryItemID: firstLibraryItem?._id || '',
      reward: this.createDefaultRewardForm('')
    });
    this.isTriggerModalOpen.set(true);
  }

  openEditModal(trigger: TriggerRecord): void {
    this.triggerFormMode.set('edit');
    this.editingTriggerId.set(trigger._id);
    this.triggerForm.set({
      name: trigger.name,
      libraryItemID: trigger.libraryItemID || '',
      volume: trigger.volume,
      reward: trigger.reward
        ? {
            enabled: true,
            title: trigger.reward.title || trigger.name,
            prompt: trigger.reward.prompt || '',
            cost: trigger.reward.cost,
            message: trigger.reward.message || this.buildTriggerCommand(trigger.name),
            cooldown: trigger.reward.cooldown,
            userInput: false,
            skipQueue: false,
            costChange: trigger.reward.costChange,
            returnToOriginalCost: trigger.reward.returnToOriginalCost,
            duration: trigger.reward.duration,
            backgroundColor: trigger.reward.backgroundColor || ''
          }
        : this.createDefaultRewardForm(trigger.name)
    });
    this.isTriggerModalOpen.set(true);
  }

  closeTriggerModal(): void {
    if (this.isSubmittingTrigger()) {
      return;
    }

    this.isTriggerModalOpen.set(false);
    this.editingTriggerId.set(null);
    this.triggerFormMode.set('create');
    this.triggerForm.set(this.createDefaultTriggerForm());
  }

  updateTriggerForm(field: keyof TriggerFormState, value: string): void {
    this.triggerForm.update((state) => {
      const previousName = state.name;
      const normalizedValue = field === 'name' ? this.sanitizeSafeName(value) : value;
      const nextState: TriggerFormState = {
        ...state,
        [field]: field === 'name' || field === 'libraryItemID' ? normalizedValue : Number(normalizedValue)
      } as TriggerFormState;

      if (field === 'name') {
        nextState.reward = {
          ...state.reward,
          message: this.syncRewardMessageWithTriggerName(state.reward.message, previousName, String(normalizedValue))
        };
      }

      return nextState;
    });
  }

  updateRewardForm<K extends keyof TriggerRewardFormState>(field: K, value: TriggerRewardFormState[K]): void {
    this.triggerForm.update((state) => ({
      ...state,
      reward: {
        ...state.reward,
        [field]: value
      }
    }));
  }

  parseNumberInput(value: string): number {
    return Number(value);
  }

  toggleRewardSection(enabled: boolean): void {
    if (this.hasLinkedRewardInEditor()) {
      return;
    }

    this.triggerForm.update((state) => ({
      ...state,
      reward: {
        ...state.reward,
        enabled,
        message: state.reward.message || this.buildTriggerCommand(state.name)
      }
    }));
  }

  submitTriggerForm(): void {
    const channelId = this.channelID();
    if (!channelId || this.isSubmittingTrigger()) {
      return;
    }

    const errors = this.triggerFormErrors();
    if (errors.name || errors.invalidName || errors.libraryItemID || errors.volume || errors.rewardTitle || errors.rewardCost || errors.rewardCooldown || errors.rewardDuration || errors.rewardCostChange) {
      this.toastService.warning(
        this.t('triggers.validationTitle'),
        errors.invalidName ? this.t('triggers.validationNameMessage') : this.t('triggers.validationMessage')
      );
      return;
    }

    const form = this.triggerForm();
    this.isSubmittingTrigger.set(true);

    if (this.triggerFormMode() === 'create') {
      const payload: CreateTriggerRequest = {
        name: form.name.trim(),
        libraryItemID: form.libraryItemID,
        volume: Math.round(form.volume),
        reward: this.buildRewardPayload(form)
      };

      this.triggersService.createTrigger(channelId, payload).subscribe({
        next: (trigger) => {
          this.triggers.update((items) => [trigger, ...items]);
          this.isSubmittingTrigger.set(false);
          this.closeTriggerModal();
          this.toastService.success(this.t('triggers.createSuccessTitle'), this.t('triggers.createSuccessMessage'));
          this.loadTriggers(channelId, true);
        },
        error: (error) => {
          this.isSubmittingTrigger.set(false);
          this.toastService.error(this.t('triggers.errors.createTitle'), this.resolveErrorMessage(error, this.t('triggers.errors.createMessage')));
        }
      });
      return;
    }

    const triggerId = this.editingTriggerId();
    if (!triggerId) {
      this.isSubmittingTrigger.set(false);
      return;
    }

    const payload: UpdateTriggerRequest = {
      name: form.name.trim(),
      libraryItemID: form.libraryItemID,
      volume: Math.round(form.volume),
      reward: this.buildRewardPayload(form)
    };

    this.triggersService.updateTrigger(channelId, triggerId, payload).subscribe({
      next: (updatedTrigger) => {
        this.triggers.update((items) => items.map((item) => (item._id === triggerId ? updatedTrigger : item)));
        this.isSubmittingTrigger.set(false);
        this.closeTriggerModal();
        this.toastService.success(this.t('triggers.updateSuccessTitle'), this.t('triggers.updateSuccessMessage'));
      },
      error: (error) => {
        this.isSubmittingTrigger.set(false);
        this.toastService.error(this.t('triggers.errors.updateTitle'), this.resolveErrorMessage(error, this.t('triggers.errors.updateMessage')));
      }
    });
  }

  toggleTrigger(trigger: TriggerRecord): void {
    const channelId = this.channelID();
    if (!channelId) {
      return;
    }

    const nextValue = !trigger.isEnabled;
    this.triggers.update((items) => items.map((item) => (item._id === trigger._id ? { ...item, isEnabled: nextValue } : item)));

    this.triggersService.updateTrigger(channelId, trigger._id, { isEnabled: nextValue }).subscribe({
      next: (updatedTrigger) => {
        this.triggers.update((items) => items.map((item) => (item._id === trigger._id ? updatedTrigger : item)));
        this.toastService.success(
          nextValue ? this.t('triggers.enabledTitle') : this.t('triggers.disabledTitle'),
          nextValue ? this.t('triggers.enabledMessage') : this.t('triggers.disabledMessage')
        );
      },
      error: (error) => {
        this.triggers.update((items) => items.map((item) => (item._id === trigger._id ? { ...item, isEnabled: trigger.isEnabled } : item)));
        this.toastService.error(this.t('triggers.errors.updateTitle'), this.resolveErrorMessage(error, this.t('triggers.errors.updateMessage')));
      }
    });
  }

  openDeleteTrigger(trigger: TriggerRecord): void {
    this.pendingDelete.set({
      type: 'trigger',
      id: trigger._id,
      label: trigger.name
    });
  }

  openDeleteLibraryItem(item: MediaLibraryItem): void {
    const raw = item.localAlias || item.asset?.displayName || item.asset?.fileName || item._id;
    const label = raw.replace(/_+/g, ' ').trim();
    this.pendingDelete.set({
      type: 'library-item',
      id: item._id,
      label
    });
  }

  confirmDelete(): void {
    const channelId = this.channelID();
    const pending = this.pendingDelete();
    if (!channelId || !pending) {
      return;
    }

    if (pending.type === 'trigger') {
      this.triggersService.deleteTrigger(channelId, pending.id).subscribe({
        next: () => {
          this.triggers.update((items) => items.filter((item) => item._id !== pending.id));
          this.pendingDelete.set(null);
          this.toastService.success(this.t('triggers.deleteTriggerTitle'), this.t('triggers.deleteTriggerMessage'));
        },
        error: (error) => {
          this.pendingDelete.set(null);
          this.toastService.error(this.t('triggers.errors.deleteTitle'), this.resolveErrorMessage(error, this.t('triggers.errors.deleteTriggerMessage')));
        }
      });
      return;
    }

    this.triggersService.removeLibraryItem(channelId, pending.id).subscribe({
      next: () => {
        this.libraryItems.update((items) => items.filter((item) => item._id !== pending.id));
        this.pendingDelete.set(null);
        this.toastService.success(this.t('triggers.deleteMediaTitle'), this.t('triggers.deleteMediaMessage'));
        this.loadLibrary(channelId, true);
      },
      error: (error) => {
        this.pendingDelete.set(null);
        this.toastService.error(this.t('triggers.errors.deleteTitle'), this.resolveErrorMessage(error, this.t('triggers.errors.deleteMediaMessage')));
      }
    });
  }

  closeDeleteModal(): void {
    this.pendingDelete.set(null);
  }

  openUploadModal(): void {
    this.isDraggingUpload.set(false);
    this.uploadForm.set({
      name: '',
      scope: this.planTier() === 'free' ? 'public' : 'private',
      file: null
    });
    this.resetFileInput();
    this.isUploadModalOpen.set(true);
  }

  closeUploadModal(): void {
    if (this.isUploadingMedia()) {
      return;
    }

    this.isUploadModalOpen.set(false);
    this.isDraggingUpload.set(false);
    this.uploadForm.set({
      name: '',
      scope: this.planTier() === 'free' ? 'public' : 'private',
      file: null
    });
    this.resetFileInput();
  }

  onUploadFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.applyUploadFile(file);
  }

  handleUploadDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDraggingUpload.set(true);
  }

  handleUploadDragLeave(event: DragEvent): void {
    event.preventDefault();

    const currentTarget = event.currentTarget as HTMLElement | null;
    const relatedTarget = event.relatedTarget as Node | null;
    if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) {
      return;
    }

    this.isDraggingUpload.set(false);
  }

  handleUploadDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDraggingUpload.set(false);

    const file = event.dataTransfer?.files?.[0] ?? null;
    if (!file) {
      return;
    }

    this.applyUploadFile(file);
  }

  private applyUploadFile(file: File | null): void {
    this.uploadForm.update((state) => ({
      ...state,
      file,
      name: state.name || (file ? this.sanitizeSafeName(file.name.replace(/\.[^.]+$/, '')) : '')
    }));
  }

  updateUploadName(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.uploadForm.update((state) => ({
      ...state,
      name: this.sanitizeSafeName(input.value)
    }));
  }

  updateUploadScope(scope: MediaScope): void {
    if (this.planTier() === 'free') {
      return;
    }

    this.uploadForm.update((state) => ({
      ...state,
      scope
    }));
  }

  submitUpload(): void {
    const channelId = this.channelID();
    const form = this.uploadForm();
    if (!channelId || !form.file || !form.name.trim()) {
      this.toastService.warning(this.t('triggers.validationTitle'), this.t('triggers.upload.validationMessage'));
      return;
    }

    this.isUploadingMedia.set(true);
    this.triggersService.uploadMedia(channelId, {
      file: form.file,
      name: form.name.trim(),
      scope: this.planTier() === 'free' ? 'public' : form.scope
    }).subscribe({
      next: (item) => {
        this.isUploadingMedia.set(false);
        this.libraryItems.update((items) => [item, ...items]);
        this.closeUploadModal();
        this.toastService.success(this.t('triggers.upload.successTitle'), this.t('triggers.upload.successMessage'));
        this.loadLibrary(channelId, true);
      },
      error: (error) => {
        this.isUploadingMedia.set(false);
        this.toastService.error(this.t('triggers.upload.errorTitle'), this.resolveErrorMessage(error, this.t('triggers.upload.errorMessage')));
      }
    });
  }

  openPublicLibraryModal(): void {
    this.isPublicLibraryModalOpen.set(true);
  }

  closePublicLibraryModal(): void {
    this.isPublicLibraryModalOpen.set(false);
  }

  handlePublicLibraryAssetAdded(result: { item: MediaLibraryItem; meta: MediaLibraryMeta }): void {
    this.libraryItems.update((items) => {
      if (items.some((item) => item._id === result.item._id || item.assetID === result.item.assetID)) {
        return items;
      }

      return [result.item, ...items];
    });
    this.libraryMeta.set(result.meta);
  }

  openTestModal(trigger: TriggerRecord): void {
    this.testPreviewReady = false;
    this.pendingPreviewPayload = null;
    this.testingTrigger.set(trigger);
    this.isTestModalOpen.set(true);
    window.setTimeout(() => this.fireTriggerTest(), 180);
  }

  closeTestModal(): void {
    if (this.isSendingTest()) {
      return;
    }

    this.isTestModalOpen.set(false);
    this.testingTrigger.set(null);
    this.testPreviewReady = false;
    this.pendingPreviewPayload = null;
  }

  handleTestPreviewLoad(): void {
    this.testPreviewReady = true;

    if (this.pendingPreviewPayload) {
      const payload = this.pendingPreviewPayload;
      this.pendingPreviewPayload = null;
      this.postPreviewTrigger(payload);
    }
  }

  fireTriggerTest(): void {
    const channelId = this.channelID();
    const trigger = this.testingTrigger();
    if (!channelId || !trigger) {
      return;
    }

    const libraryItem = this.libraryItems().find((item) => item._id === trigger.libraryItemID)
      || this.libraryItems().find((item) => item.assetID === trigger.assetID);
    const asset = libraryItem?.asset;
    if (!asset?.playbackUrl) {
      this.toastService.error(this.t('triggers.test.errorTitle'), this.t('triggers.test.missingAssetMessage'));
      return;
    }

    const payload: TriggerTestPayload = {
      url: asset.playbackUrl,
      mediaType: asset.mimeType,
      volume: trigger.volume
    };

    this.isSendingTest.set(true);
    this.triggersService.sendTrigger(channelId, payload).subscribe({
      next: () => {
        this.isSendingTest.set(false);
        this.postPreviewTrigger(payload);
        this.toastService.success(this.t('triggers.test.successTitle'), this.t('triggers.test.successMessage'));
      },
      error: (error) => {
        this.isSendingTest.set(false);
        this.toastService.error(this.t('triggers.test.errorTitle'), this.resolveErrorMessage(error, this.t('triggers.test.errorMessage')));
      }
    });
  }

  updateLibrarySearch(event: Event): void {
    this.librarySearch.set((event.target as HTMLInputElement).value);
  }

  setMediaFilter(filter: MediaFilter): void {
    this.mediaFilter.set(filter);
  }

  canAttachItem(item: MediaLibraryItem): boolean {
    return Boolean(item.asset && SUPPORTED_TRIGGER_MEDIA_TYPES.has(item.asset.mediaType));
  }

  getMediaIcon(type: MediaType): LucideIconData {
    switch (type) {
      case 'audio':
        return this.audioIcon;
      case 'image':
      case 'gif':
        return this.imageIcon;
      case 'video':
      default:
        return this.videoIcon;
    }
  }

  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exponent;
    return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  }

  formatDate(value: string): string {
    return new Intl.DateTimeFormat(this.languageService.getCurrentLanguage() === 'es' ? 'es-ES' : 'en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(new Date(value));
  }

  getDeleteMessage(): string {
    const pending = this.pendingDelete();
    if (!pending) {
      return '';
    }

    return pending.type === 'trigger'
      ? this.t('triggers.deleteTriggerConfirmation', { name: pending.label })
      : this.t('triggers.deleteMediaConfirmation', { name: pending.label });
  }

  private loadTriggers(channelId: string, _force = false): void {
    this.isLoadingTriggers.set(true);

    this.triggersService.getTriggers(channelId).subscribe({
      next: (triggers) => {
        this.triggers.set(triggers.sort((left, right) => left.name.localeCompare(right.name)));
        this.isLoadingTriggers.set(false);
        this.pageError.set(null);
      },
      error: (error) => {
        this.isLoadingTriggers.set(false);
        this.pageError.set(this.resolveErrorMessage(error, this.t('triggers.errors.loadMessage')));
        this.toastService.error(this.t('triggers.errors.loadTitle'), this.resolveErrorMessage(error, this.t('triggers.errors.loadMessage')));
      }
    });
  }

  private loadLibrary(channelId: string, _force = false): void {
    this.isLoadingLibrary.set(true);

    this.triggersService.getLibrary(channelId).subscribe({
      next: (response) => {
        this.libraryItems.set(response.items);
        this.libraryMeta.set(response.meta);
        this.isLoadingLibrary.set(false);
      },
      error: (error) => {
        this.isLoadingLibrary.set(false);
        this.toastService.error(this.t('triggers.errors.libraryTitle'), this.resolveErrorMessage(error, this.t('triggers.errors.libraryMessage')));
      }
    });
  }

  private startCooldownTimer(): void {
    if (this.cooldownTimer !== null) {
      window.clearInterval(this.cooldownTimer);
    }

    this.cooldownTimer = window.setInterval(() => {
      this.refreshCooldown.update((value) => Math.max(0, value - 1));
    }, 1000);
  }

  private fallbackCopy(text: string, onSuccess: () => void): void {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      onSuccess();
    } catch {
      this.toastService.error(this.t('triggers.errors.copyTitle'), this.t('triggers.errors.copyMessage'));
    } finally {
      document.body.removeChild(textArea);
    }
  }

  private createDefaultTriggerForm(): TriggerFormState {
    return {
      name: '',
      libraryItemID: '',
      volume: 100,
      reward: this.createDefaultRewardForm('')
    };
  }

  private createDefaultRewardForm(triggerName: string): TriggerRewardFormState {
    return {
      enabled: false,
      title: triggerName,
      prompt: '',
      cost: 100,
      message: triggerName ? this.buildTriggerCommand(triggerName) : '',
      cooldown: 0,
      userInput: false,
      skipQueue: false,
      costChange: 0,
      returnToOriginalCost: false,
      duration: 0,
      backgroundColor: ''
    };
  }

  private buildTriggerCommand(name: string): string {
    const trimmed = name.trim();
    return trimmed ? `$(trigger.send ${trimmed})` : '';
  }

  private syncRewardMessageWithTriggerName(message: string, oldName: string, newName: string): string {
    const previousCommand = this.buildTriggerCommand(oldName);
    const nextCommand = this.buildTriggerCommand(newName);

    if (!message.trim()) {
      return nextCommand;
    }

    if (previousCommand && message.includes(previousCommand)) {
      return message.replaceAll(previousCommand, nextCommand);
    }

    return message;
  }

  private buildRewardPayload(form: TriggerFormState): TriggerRewardDraft | null {
    if (!form.reward.enabled) {
      return null;
    }

    return {
      create: true,
      title: form.reward.title.trim() || form.name.trim(),
      prompt: form.reward.prompt.trim(),
      cost: Math.round(form.reward.cost),
      message: form.reward.message.trim() || this.buildTriggerCommand(form.name),
      cooldown: Math.round(form.reward.cooldown),
      userInput: form.reward.userInput,
      skipQueue: form.reward.skipQueue,
      isEnabled: true,
      costChange: Math.round(form.reward.costChange),
      returnToOriginalCost: form.reward.returnToOriginalCost,
      duration: Math.round(form.reward.duration),
      backgroundColor: form.reward.backgroundColor.trim() || undefined
    };
  }

  private sanitizeSafeName(name: string): string {
    return name
      .replace(/[^A-Za-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^\d+/, '')
      .slice(0, SAFE_NAME_MAX_LENGTH);
  }

  private resetFileInput(): void {
    const input = this.fileInput()?.nativeElement;
    if (input) {
      input.value = '';
    }
  }

  private getUploadLimitBytes(planTier: PlanTier): number {
    switch (planTier) {
      case 'premium':
        return 25 * 1024 * 1024;
      case 'pro':
        return 100 * 1024 * 1024;
      case 'free':
      default:
        return 5 * 1024 * 1024;
    }
  }

  private resolveErrorMessage(error: unknown, fallback: string): string {
    if (typeof error === 'object' && error && 'error' in error) {
      const nested = (error as { error?: { message?: string } }).error?.message;
      if (nested) {
        return nested;
      }
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return fallback;
  }

  private postPreviewTrigger(payload: TriggerTestPayload): void {
    const previewWindow = this.testPreviewFrame()?.nativeElement.contentWindow;
    if (!previewWindow || !this.testPreviewReady) {
      this.pendingPreviewPayload = payload;
      return;
    }

    previewWindow.postMessage({
      type: 'trigger-preview',
      payload
    }, '*');
  }
}
