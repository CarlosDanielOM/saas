import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import type { OverlayWidget } from './overlay.model';
@Component({
  selector: 'app-overlay-layer', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@switch (layer().kind) {
    @case ('text') { <span [style.color]="layer().color || '#ffffff'" [style.font-size.px]="layer().fontSize || 40">{{ layer().text }}</span> }
    @case ('image') { @if (layer().mediaUrl) { <img [src]="layer().mediaUrl" alt="" (error)="failed.emit()" /> } }
    @case ('video') { @if (layer().mediaUrl) { <video [src]="layer().mediaUrl" autoplay muted loop playsinline (error)="failed.emit()"></video> } }
    @case ('animation') { <span class="spark" [style.color]="layer().color || '#a78bfa'">✦</span> }
  }`,
  styles: `:host { display:flex; width:100%; height:100%; align-items:center; justify-content:center; overflow:hidden } img,video { width:100%; height:100%; object-fit:contain } span { white-space:pre-wrap; overflow-wrap:anywhere; text-align:center; font-family:inherit; line-height:1.2 } .spark { font-size:100px; animation:pulse 1s ease-in-out infinite alternate } @keyframes pulse { to { transform:scale(.7) rotate(20deg); opacity:.5 } } @media(prefers-reduced-motion:reduce){ .spark { animation:none } }`
})
export class OverlayLayerComponent { readonly layer = input.required<OverlayWidget>(); readonly failed = output<void>(); }
