import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { io } from 'socket.io-client';
import { LinksService } from '../../services/links.service';
import { WidgetCatalog, WidgetState } from './widgets-api.service';
import { WidgetDisplayComponent } from './widget-display.component';
@Component({ selector: 'app-widgets-overlay', imports: [WidgetDisplayComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (catalog(); as catalog) { @if (state(); as state) { @if (state.visible) { <app-widget-display [catalog]="catalog" [state]="state" /> } } }`,
  styles: `:host { display:block; width:min(100%,760px); margin:auto; padding:16px; box-sizing:border-box; }` })
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
    socket?.on('widgets-state', (state: WidgetState) => this.state.set(state));
    socket?.on('disconnect', () => this.state.set(null)); socket?.on('connect_error', () => this.state.set(null)); socket?.on('widgets-error', () => this.state.set(null));
    inject(DestroyRef).onDestroy(() => { socket?.disconnect(); doc.body.style.background = oldBody; doc.documentElement.style.background = oldRoot; });
  }
}
