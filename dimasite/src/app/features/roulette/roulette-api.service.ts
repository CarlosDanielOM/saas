import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LinksService } from '../../services/links.service';
export interface RouletteItem {
  id: string;
  label: string;
  multiplier: number;
  weight: number;
  copies: string[];
}
export interface RouletteSlot {
  key: string;
  itemId: string;
  label: string;
  weight: number;
  copy: number;
  multiplier: number;
}
export interface Roulette {
  id: string;
  alias: string;
  name: string;
  design: 'wheel' | 'cards' | 'reel';
  cardSize: 'large' | 'medium' | 'small';
  colors: string[];
  durationSeconds: number;
  items: RouletteItem[];
  order: string[];
  settings: {
    insertion: 'append' | 'random';
    duplicate: 'separate' | 'increase';
    shuffleBeforeDraw: boolean;
    showOnStart: boolean;
    hideAfterSeconds: number | null;
    winnerAction: 'keep' | 'remove-copy' | 'remove-item';
  };
}
export interface RouletteDraw {
  id: string;
  rouletteId: string;
  startedAt: number;
  endsAt: number;
  completedAt: number | null;
  winner: RouletteSlot;
  slots: RouletteSlot[];
  design: Roulette['design'];
  cardSize: Roulette['cardSize'];
  colors: string[];
}
export interface RouletteState {
  revision: number;
  serverTime: number;
  roulettes: Roulette[];
  activeId: string | null;
  visible: boolean;
  draw: RouletteDraw | null;
  history: Omit<RouletteDraw, 'slots'>[];
  hideAt: number | null;
}
export interface RouletteOverlayState {
  revision: number;
  serverTime: number;
  visible: boolean;
  roulette: Roulette | null;
  draw: RouletteDraw | null;
  hideAt: number | null;
}
export function slotsFor(r: Roulette): RouletteSlot[] {
  const entries = new Map(
    r.items.flatMap((item) =>
      item.copies.map(
        (key, i) =>
          [
            key,
            {
              key,
              itemId: item.id,
              label: item.label,
              weight: item.weight,
              copy: i + 1,
              multiplier: item.multiplier,
            },
          ] as const,
      ),
    ),
  );
  return r.order.flatMap((key) => {
    const slot = entries.get(key);
    return slot ? [slot] : [];
  });
}
@Injectable({ providedIn: 'root' })
export class RouletteApi {
  private readonly http = inject(HttpClient);
  readonly base = inject(LinksService).getApiUrl();
  async read(channel: string): Promise<RouletteState> {
    return (
      await firstValueFrom(
        this.http.get<{ data: RouletteState }>(`${this.base}/roulettes/${channel}`),
      )
    ).data;
  }
  async write<T = { result: string }>(
    channel: string,
    method: string,
    path: string,
    body: unknown,
    revision?: number,
  ): Promise<T> {
    return (
      await firstValueFrom(
        this.http.request<{ data: T }>(method, `${this.base}/roulettes/${channel}${path}`, {
          body,
          headers: {
            'Idempotency-Key': crypto.randomUUID(),
            ...(revision === undefined ? {} : { 'If-Match': String(revision) }),
          },
        }),
      )
    ).data;
  }
}
