import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Check, LucideAngularModule, Music, Pause, Play, Search, Upload, X } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { TriggersService } from '../triggers/triggers.service';
import { LazyVideoFrameDirective } from '../triggers/lazy-video-frame.directive';
import { getTriggerUploadIssue, safeMediaName, triggerUploadLimitBytes, type MediaLibraryItem, type MediaScope, type MediaType, type PlanTier } from '../triggers/triggers.model';

export type TriggerMediaKind = 'picture' | 'video' | 'sound';
const KIND_TYPES: Record<TriggerMediaKind, readonly MediaType[]> = { picture: ['image', 'gif'], video: ['video'], sound: ['audio'] };
const KIND_ACCEPT: Record<TriggerMediaKind, string> = { picture: 'image/*', video: 'video/*', sound: 'audio/*' };
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Picks a file for a trigger look from the channel's trigger library (never the Overlay Studio asset library),
 * filtered by what is being picked. It can upload a new file with the Triggers page's rules and texts, then picks it.
 */
@Component({
  selector: 'app-overlay-trigger-media-picker',
  imports: [LucideAngularModule, LazyVideoFrameDirective],
  templateUrl: './overlay-trigger-media-picker.component.html',
  styleUrl: './overlay-trigger-media-picker.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown)': 'onKeydown($event)' }
})
export class OverlayTriggerMediaPickerComponent {
  readonly channel = input.required<string>();
  readonly kind = input.required<TriggerMediaKind>();
  readonly picked = output<MediaLibraryItem>();
  readonly closed = output<void>();

  readonly icons = { Check, Music, Pause, Play, Search, Upload, X };
  private readonly triggers = inject(TriggersService);
  private readonly auth = inject(SessionAuthService);
  readonly language = inject(LanguageService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  readonly loading = signal(true);
  readonly failed = signal(false);
  readonly items = signal<MediaLibraryItem[]>([]);
  readonly planTier = signal<PlanTier>('free');
  readonly search = signal('');
  readonly canUpload = signal(false);
  readonly view = signal<'list' | 'upload'>('list');
  readonly playing = signal<string | null>(null);
  private audio: HTMLAudioElement | null = null;

  readonly file = signal<File | null>(null);
  readonly fileIssue = signal<string>('');
  readonly name = signal('');
  readonly scope = signal<MediaScope>('private');
  readonly dragging = signal(false);
  readonly uploading = signal(false);
  readonly uploadError = signal('');
  readonly submitted = signal(false);

  readonly matching = computed(() => {
    const types = KIND_TYPES[this.kind()];
    return this.items().filter(item => item.isActive !== false && !!item.asset?.playbackUrl && types.includes(item.asset.mediaType ?? item.mediaType));
  });
  readonly shown = computed(() => {
    const query = this.search().trim().toLocaleLowerCase();
    return query ? this.matching().filter(item => this.itemName(item).toLocaleLowerCase().includes(query)) : this.matching();
  });
  readonly limitLabel = computed(() => this.formatBytes(triggerUploadLimitBytes(this.planTier())));
  readonly accept = computed(() => KIND_ACCEPT[this.kind()]);

  constructor() {
    const opener = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;
    inject(DestroyRef).onDestroy(() => { this.stopSound(); opener?.focus?.({ preventScroll: true }); });
    afterNextRender(() => { void this.load(); (this.host.querySelector('[data-autofocus]') as HTMLElement | null)?.focus(); });
  }

  t(key: string, params?: Record<string, string | number>): string { this.language.currentLanguage(); return this.language.translate('overlayStudio.' + key, params); }
  tr(key: string, params?: Record<string, string | number>): string { this.language.currentLanguage(); return this.language.translate(key, params); }

  async load(): Promise<void> {
    this.loading.set(true); this.failed.set(false);
    try {
      const [library, upload] = await Promise.all([
        firstValueFrom(this.triggers.getLibrary(this.channel())),
        firstValueFrom(this.auth.checkPermission(this.channel(), 'triggers:upload')).catch(() => false)
      ]);
      this.items.set(library.items); this.planTier.set(library.meta.planTier || 'free'); this.canUpload.set(!!upload);
      this.scope.set(this.planTier() === 'free' ? 'public' : 'private');
    } catch { this.failed.set(true); }
    finally { this.loading.set(false); }
  }

  itemName(item: MediaLibraryItem): string { return (item.localAlias || item.asset?.displayName || '').replace(/_/g, ' '); }
  itemType(item: MediaLibraryItem): MediaType { return item.asset?.mediaType ?? item.mediaType; }
  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'], exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1), value = bytes / 1024 ** exponent;
    return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  }

  choose(item: MediaLibraryItem): void { this.stopSound(); this.picked.emit(item); }
  close(): void { if (!this.uploading()) this.closed.emit(); }

  toggleSound(item: MediaLibraryItem): void {
    if (this.playing() === item._id) { this.stopSound(); return; }
    this.stopSound();
    const url = item.asset?.playbackUrl; if (!url) return;
    const audio = new Audio(url); audio.volume = .5; this.audio = audio; this.playing.set(item._id);
    const stop = () => { if (this.audio === audio) { this.audio = null; this.playing.set(null); } };
    audio.addEventListener('ended', stop); audio.addEventListener('error', stop);
    void audio.play().catch(stop);
  }
  private stopSound(): void { this.audio?.pause(); this.audio = null; this.playing.set(null); }

  openUpload(): void {
    this.stopSound(); this.view.set('upload'); this.file.set(null); this.fileIssue.set(''); this.name.set(''); this.uploadError.set(''); this.submitted.set(false);
    this.scope.set(this.planTier() === 'free' ? 'public' : 'private');
    setTimeout(() => (this.host.querySelector('.tmp-drop') as HTMLElement | null)?.focus(), 0);
  }
  backToList(): void { if (!this.uploading()) { this.view.set('list'); setTimeout(() => (this.host.querySelector('[data-autofocus]') as HTMLElement | null)?.focus(), 0); } }

  onFile(event: Event): void { this.useFile((event.target as HTMLInputElement).files?.[0] ?? null); }
  onDragOver(event: DragEvent): void { event.preventDefault(); this.dragging.set(true); }
  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement | null, related = event.relatedTarget as Node | null;
    if (!target || !related || !target.contains(related)) this.dragging.set(false);
  }
  onDrop(event: DragEvent): void { event.preventDefault(); this.dragging.set(false); const file = event.dataTransfer?.files?.[0]; if (file) this.useFile(file); }
  private useFile(file: File | null): void {
    this.uploadError.set('');
    // Same rules as the Triggers page upload: iPhone formats, SVG and types OBS can't play are refused before uploading.
    const issue = file ? getTriggerUploadIssue(file) : null;
    const wrongKind = file && !issue && !this.fileFits(file);
    const tooLarge = file && !issue && !wrongKind && file.size > triggerUploadLimitBytes(this.planTier());
    this.fileIssue.set(issue === 'iphone' ? this.tr('triggers.upload.iphoneFormat') : issue ? this.tr('triggers.upload.unsupportedFormat')
      : wrongKind ? this.t('lookPickerWrongKind_' + this.kind()) : tooLarge ? this.t('lookPickerTooLarge', { size: this.limitLabel() }) : '');
    if (!file || this.fileIssue()) { this.file.set(null); const input = this.fileInput()?.nativeElement; if (input) input.value = ''; return; }
    this.file.set(file);
    if (!this.name()) this.name.set(safeMediaName(file.name.replace(/\.[^.]+$/, '')));
  }
  private fileFits(file: File): boolean {
    const type = file.type.toLowerCase();
    return this.kind() === 'picture' ? type.startsWith('image/') : this.kind() === 'video' ? type.startsWith('video/') : type.startsWith('audio/');
  }
  setName(event: Event): void { const input = event.target as HTMLInputElement, name = safeMediaName(input.value); this.name.set(name); if (input.value !== name) input.value = name; }
  setScope(scope: MediaScope): void { if (this.planTier() !== 'free') this.scope.set(scope); }

  async upload(): Promise<void> {
    this.submitted.set(true);
    const file = this.file(), name = this.name().trim();
    if (!file || !name || this.uploading()) { if (!file || !name) this.uploadError.set(this.tr('triggers.upload.validationMessage')); return; }
    this.uploading.set(true); this.uploadError.set('');
    try {
      const item = await firstValueFrom(this.triggers.uploadMedia(this.channel(), { file, name, scope: this.planTier() === 'free' ? 'public' : this.scope() }));
      this.items.update(all => [item, ...all.filter(other => other._id !== item._id)]);
      this.uploading.set(false);
      this.choose(item);
    } catch (error) {
      const message = (error as { error?: { message?: string } })?.error?.message || (error instanceof Error ? error.message : '');
      this.uploadError.set(message || this.tr('triggers.upload.errorMessage'));
      this.uploading.set(false);
    }
  }

  /** Escape closes only the picker; Tab stays inside it. */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
    if (event.key !== 'Tab') return;
    const panel = this.host.querySelector('.tmp-panel'); if (!panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1], active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !panel.contains(active))) { event.preventDefault(); first.focus(); }
  }
}
