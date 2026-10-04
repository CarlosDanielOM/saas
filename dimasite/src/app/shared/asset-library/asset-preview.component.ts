import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, effect, inject, input, output, signal } from '@angular/core';
import { Music2, LucideAngularModule } from 'lucide-angular';
import { AssetLibraryService } from './asset-library.service';
import { LanguageService } from '../../services/language.service';

@Component({
  selector: 'app-asset-preview', imports: [LucideAngularModule], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (kind() === 'audio' && still()) { <lucide-icon [img]="music" [size]="32" aria-hidden="true" /> }
  @else if (url(); as source) {
    @if (kind() === 'audio') { <audio [src]="source" controls preload="metadata" [attr.aria-label]="name()" (error)="onError()"></audio> }
    @else if (kind() === 'image') { <img [src]="source" [alt]="still() ? '' : name()" loading="lazy" referrerpolicy="no-referrer" (error)="onError()" /> }
    @else if (still()) { <video [src]="source + '#t=0.1'" muted playsinline preload="metadata" tabindex="-1" aria-hidden="true" (error)="onError()"></video> }
    @else { <video [src]="source" [attr.aria-label]="name()" [controls]="controls()" [autoplay]="!controls() && seekTime() === null" (loadedmetadata)="seekVideo()" [loop]="!controls()" muted playsinline preload="metadata" (error)="onError()"></video> }
  } @else { <span role="status">{{ language.translate(broken() ? 'assetLibrary.previewFailed' : 'assetLibrary.loading') }}</span> }`,
  styles: `:host { display:grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items:center; width:100%; height:100%; min-width:0; min-height:0 } audio { width:100%; min-width:0; max-width:100% } img, video { display:block; width:100%; height:100%; min-width:0; min-height:0; max-height:100%; object-fit:contain } span { font-size:.75rem; padding:.5rem; text-align:center; color:inherit }`
})
export class AssetPreviewComponent {
  readonly music = Music2;
  readonly assetId = input.required<string>();
  readonly owner = input('');
  /** Optional scoped renderer URL supplied by the consuming module. */
  readonly accessUrl = input('');
  readonly kind = input<'image' | 'video' | 'audio'>('image');
  readonly name = input('');
  readonly controls = input(false);
  /** Paused first frame for gallery thumbnails, so many videos don't play at once. */
  readonly still = input(false);
  readonly seekTime = input<number | null>(null);
  private videoWasControlled = false;
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly failed = output<void>();
  readonly url = signal('');
  readonly broken = signal(false);
  readonly language = inject(LanguageService);
  private readonly library = inject(AssetLibraryService);
  constructor() {
    afterRenderEffect(() => { this.seekTime(); this.seekVideo(); });
    effect(cleanup => {
      const id = this.assetId(), owner = this.owner(), source = this.accessUrl();
      this.url.set(''); this.broken.set(false);
      if (this.kind() === 'audio' && this.still()) return;
      if (source) { this.url.set(source); return; }
      if (!owner) return;
      let active = true;
      const refresh = () => void this.library.preview(owner, id).then(url => { if (active) { this.url.set(url); this.broken.set(false); } }).catch(() => { if (active) this.onError(); });
      refresh();
      const interval = setInterval(refresh, 10 * 60_000);
      cleanup(() => { active = false; clearInterval(interval); });
    });
  }
  seekVideo(): void {
    const time = this.seekTime(), video = this.host.nativeElement.querySelector('video');
    if (time === null) { if (this.videoWasControlled && video && !this.controls() && !this.still()) void video.play().catch(() => {}); this.videoWasControlled = false; return; }
    this.videoWasControlled = true;
    if (!video || !Number.isFinite(video.duration) || !video.duration) return;
    video.pause(); video.currentTime = time % video.duration;
  }
  onError() { this.broken.set(true); this.url.set(''); this.failed.emit(); }
}
