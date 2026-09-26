import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { AssetLibraryService } from './asset-library.service';
import { LanguageService } from '../../services/language.service';

@Component({
  selector: 'app-asset-preview', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (url(); as source) {
    @if (kind() === 'image') { <img [src]="source" [alt]="name()" loading="lazy" referrerpolicy="no-referrer" (error)="onError()" /> }
    @else { <video [src]="source" [attr.aria-label]="name()" [controls]="controls()" [autoplay]="!controls()" [loop]="!controls()" muted playsinline preload="metadata" (error)="onError()"></video> }
  } @else { <span role="status">{{ language.translate(broken() ? 'assetLibrary.previewFailed' : 'assetLibrary.loading') }}</span> }`,
  styles: `:host { display:grid; place-items:center; width:100%; height:100%; min-width:0 } img, video { width:100%; height:100%; max-height:100%; object-fit:contain } span { font-size:.75rem; padding:.5rem; text-align:center; color:inherit }`
})
export class AssetPreviewComponent {
  readonly assetId = input.required<string>();
  readonly owner = input('');
  /** Optional scoped renderer URL supplied by the consuming module. */
  readonly accessUrl = input('');
  readonly kind = input<'image' | 'video'>('image');
  readonly name = input('');
  readonly controls = input(false);
  readonly failed = output<void>();
  readonly url = signal('');
  readonly broken = signal(false);
  readonly language = inject(LanguageService);
  private readonly library = inject(AssetLibraryService);
  constructor() {
    effect(cleanup => {
      const id = this.assetId(), owner = this.owner(), source = this.accessUrl();
      this.url.set(''); this.broken.set(false);
      if (source) { this.url.set(source); return; }
      if (!owner) return;
      let active = true;
      const refresh = () => void this.library.preview(owner, id).then(url => { if (active) { this.url.set(url); this.broken.set(false); } }).catch(() => { if (active) this.onError(); });
      refresh();
      const interval = setInterval(refresh, 10 * 60_000);
      cleanup(() => { active = false; clearInterval(interval); });
    });
  }
  onError() { this.broken.set(true); this.url.set(''); this.failed.emit(); }
}
