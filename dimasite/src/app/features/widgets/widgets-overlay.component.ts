import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { io } from 'socket.io-client';
import { LinksService } from '../../services/links.service';
import { WidgetCatalog, WidgetState, normalizeWidgetState } from './widgets-api.service';
import { WidgetDisplayComponent } from './widget-display.component';
@Component({ selector: 'app-widgets-overlay', imports: [WidgetDisplayComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (catalog(); as catalog) { @if (state(); as state) { @if (state.visible) { <app-widget-display animate.leave="widget-leave" [catalog]="catalog" [state]="state" /> } } }`,
  styles: `:host { display:block; width:100%; max-width:1920px; margin:0; padding:0; box-sizing:border-box; } .widget-leave { animation:widget-leave .45s ease-in both; } @keyframes widget-leave { to { opacity:0; transform:translateY(16px); } } @media (prefers-reduced-motion:reduce) { .widget-leave { animation:none; } }` })
export class WidgetsOverlayComponent {
  readonly state = signal<WidgetState | null>(null);
  readonly catalog = signal<WidgetCatalog | null>(null);
  constructor() {
    const route = inject(ActivatedRoute).snapshot, doc = inject(DOCUMENT);
    const oldBody = doc.body.style.background, oldRoot = doc.documentElement.style.background;
    doc.body.style.background = 'transparent'; doc.documentElement.style.background = 'transparent';
    const channel = route.paramMap.get('channelID') ?? '', token = route.fragment ?? '';
    const socket = /^[0-9]{1,30}$/.test(channel) && /^[\w-]{43}$/.test(token) ? io(`${inject(LinksService).getApiUrl()}/overlays/widgets/${channel}`, { auth: { token }, transports: ['websocket'], reconnection: true }) : null;
    socket?.on('widgets-catalog', (catalog: WidgetCatalog) => this.catalog.set(catalog));
    socket?.on('widgets-state', (state: WidgetState) => this.state.set(normalizeWidgetState(state)));
    socket?.on('disconnect', () => this.state.set(null)); socket?.on('connect_error', () => this.state.set(null)); socket?.on('widgets-error', () => this.state.set(null));
    inject(DestroyRef).onDestroy(() => { socket?.disconnect(); doc.body.style.background = oldBody; doc.documentElement.style.background = oldRoot; });
  }
}
