import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { io } from 'socket.io-client';
import { LinksService } from '../../services/links.service';
import { RouletteOverlayState } from './roulette-api.service';
import { RouletteDisplayComponent } from './roulette-display.component';

@Component({
  selector: 'app-roulette-overlay',
  imports: [RouletteDisplayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (state(); as s) {
    @if (s.visible) {
      <app-roulette-display [roulette]="s.roulette" [draw]="s.draw" [serverTime]="s.serverTime" />
    }
  }`,
  styles: `
    :host {
      display: block;
      width: 100%;
      max-width: 960px;
      margin: auto;
      padding: 16px;
      box-sizing: border-box;
    }
  `,
})
export class RouletteOverlayComponent {
  readonly state = signal<RouletteOverlayState | null>(null);
  constructor() {
    const route = inject(ActivatedRoute).snapshot;
    const doc = inject(DOCUMENT);
    const oldBody = doc.body.style.background;
    const oldRoot = doc.documentElement.style.background;
    doc.body.style.background = 'transparent';
    doc.documentElement.style.background = 'transparent';
    const token = route.fragment ?? '';
    const channel = route.paramMap.get('channelID') ?? '';
    const socket =
      /^[\w-]{43}$/.test(token) && /^[\w-]+$/.test(channel)
        ? io(`${inject(LinksService).getApiUrl()}/overlays/roulette/${channel}`, {
            auth: { token },
            transports: ['websocket'],
            reconnection: true,
          })
        : null;
    socket?.on('roulette-state', (state: RouletteOverlayState) => this.state.set(state));
    socket?.on('disconnect', () => this.state.set(null));
    socket?.on('connect_error', () => this.state.set(null));
    socket?.on('roulette-error', () => this.state.set(null));
    // Explicit server disconnects (revoked token / downgraded plan) remain disconnected.
    inject(DestroyRef).onDestroy(() => {
      socket?.disconnect();
      doc.body.style.background = oldBody;
      doc.documentElement.style.background = oldRoot;
    });
  }
}
