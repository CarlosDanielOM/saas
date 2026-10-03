import { Component, ChangeDetectionStrategy, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, computed, inject, input, output, signal, viewChild } from '@angular/core';
import type { OverlayWidget } from './overlay.model';
import { AssetPreviewComponent } from '../../shared/asset-library/asset-preview.component';
import { LinksService } from '../../services/links.service';
@Component({
  selector: 'app-overlay-layer', imports: [AssetPreviewComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="layer-content" [style.width.px]="layer().width" [style.height.px]="layer().height" [style.transform]="scale()">@switch (layer().kind) {
    @case ('text') { <span #textElement [style.color]="layer().color || '#ffffff'">{{ text() ?? layer().text }}</span> }
    @case ('image') { @if (layer().assetId; as id) { <app-asset-preview [assetId]="id" [owner]="owner()" [accessUrl]="publicAssetUrl()" (failed)="failed.emit()" /> } @else if (layer().mediaUrl) { <img [src]="layer().mediaUrl" alt="" (error)="failed.emit()" /> } }
    @case ('video') { @if (layer().assetId; as id) { <app-asset-preview [assetId]="id" [owner]="owner()" [accessUrl]="publicAssetUrl()" kind="video" (failed)="failed.emit()" /> } @else if (layer().mediaUrl) { <video [src]="layer().mediaUrl" autoplay muted loop playsinline (error)="failed.emit()"></video> } }
    @case ('animation') { <span class="spark" [style.color]="layer().color || '#a78bfa'">✦</span> }
  }</div>`,
  styles: `:host { position:relative; display:block; width:100%; height:100%; overflow:hidden } .layer-content { position:absolute; top:0; left:0; display:flex; align-items:center; justify-content:center; transform-origin:top left; overflow:hidden } img,video { width:100%; height:100%; object-fit:contain } span { max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; text-align:center; font-family:inherit; font-weight:400; line-height:1.2 } .spark { font-size:100px; animation:pulse 1s ease-in-out infinite alternate } @keyframes pulse { to { transform:scale(.7) rotate(20deg); opacity:.5 } } @media(prefers-reduced-motion:reduce){ .spark { animation:none } }`
})
export class OverlayLayerComponent {
  readonly layer = input.required<OverlayWidget>();
  readonly text = input<string>();
  readonly owner = input('');
  readonly publicId = input('');
  readonly failed = output<void>();
  private readonly textElement = viewChild<ElementRef<HTMLSpanElement>>('textElement');
  private readonly size = signal({ width: 0, height: 0 });
  readonly scale = computed(() => `scale(${this.size().width / this.layer().width}, ${this.size().height / this.layer().height})`);
  private readonly base = inject(LinksService).getApiUrl();
  readonly publicAssetUrl = computed(() => this.publicId() && this.layer().assetId
    ? `${this.base}/overlay-studio/public/${encodeURIComponent(this.publicId())}/assets/${encodeURIComponent(this.layer().assetId!)}` : '');
  constructor() {
    const host = inject(ElementRef<HTMLElement>).nativeElement;
    const destroy = inject(DestroyRef);
    afterRenderEffect(cleanup => {
      const element = this.textElement()?.nativeElement, layer = this.layer();
      this.text();
      if (!element) return;
      const fit = () => {
        const requested = layer.fontSize || 40;
        const fits = () => element.offsetHeight <= layer.height && element.scrollWidth <= layer.width;
        element.style.fontSize = `${requested}px`;
        if (fits()) return;
        // Event names vary in length. Treat the chosen size as a maximum and
        // fit at design resolution, before applying the placement scale.
        let low = 1, high = requested;
        while (high - low > .25) {
          const middle = (low + high) / 2;
          element.style.fontSize = `${middle}px`;
          if (fits()) low = middle; else high = middle;
        }
        element.style.fontSize = `${low}px`;
      };
      fit();
      const observer = new ResizeObserver(fit);
      observer.observe(element);
      cleanup(() => observer.disconnect());
    });
    afterNextRender(() => {
      // Lay out text at design resolution, then scale the entire layer. This
      // preserves wrapping in thumbnails, the editor and resized OBS alerts.
      const observer = new ResizeObserver(([entry]) => this.size.set({ width: entry.contentRect.width, height: entry.contentRect.height }));
      observer.observe(host);
      destroy.onDestroy(() => observer.disconnect());
    });
  }
}
