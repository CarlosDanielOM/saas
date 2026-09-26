import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subscription, map, of, switchMap, timeout } from 'rxjs';
import { io } from 'socket.io-client';
import { LinksService } from '../../../services/links.service';
import { ClipsService } from '../../clips/clips.service';
import { TriggersService } from '../../triggers/triggers.service';
import { ApiEnvelope, TriggerRecord } from '../../triggers/triggers.model';

export interface TestChannel { id: string; login: string }
export interface TestMedia {
  url: string;
  type: 'video' | 'audio' | 'image';
  title: string;
  volume: number;
  duration?: number;
}

@Injectable()
export class OverlayTestMediaService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly clips = inject(ClipsService);
  private readonly triggers = inject(TriggersService);

  randomTrigger(channel: TestChannel): Observable<TestMedia | null> {
    return this.http.get<ApiEnvelope<TriggerRecord[]>>(`${this.links.getApiUrl()}/triggers/${channel.id}`).pipe(
      switchMap(response => {
        if (response.error || !Array.isArray(response.data)) throw new Error('Unable to load triggers');
        if (!response.data.length) return of(null);
        const trigger = response.data[Math.floor(Math.random() * response.data.length)];
        return this.triggers.getLibrary(channel.id).pipe(map(library => {
          const asset = (library.items.find(item => item._id === trigger.libraryItemID)
            ?? library.items.find(item => item.assetID === trigger.assetID))?.asset;
          const url = asset?.playbackUrl || asset?.storageUrl || trigger.file;
          if (!url || !/^https?:\/\//i.test(url)) throw new Error('Trigger media is unavailable');
          const mime = asset?.mimeType || trigger.mediaType || '';
          const type: TestMedia['type'] | null = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio'
            : mime.startsWith('image') || mime === 'gif' ? 'image' : null;
          if (!type) throw new Error('Unsupported trigger media');
          return { url, type, title: trigger.name, volume: Math.max(0, Math.min(1, Number(trigger.volume ?? 100) / 100)) };
        }));
      }),
      timeout(20000)
    );
  }

  /** Uses the clip module's existing live namespace and test request. Cleanup acknowledges only the received clip. */
  startClip(channel: TestChannel, ready: (media: TestMedia) => void, failed: () => void): () => void {
    const base = this.links.getApiUrl();
    const socket = io(`${base}/clip/${channel.id}`, { transports: ['websocket'], reconnection: false, autoConnect: false });
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let request: Subscription | undefined;
    let clipID: string | undefined;
    let stopped = false;
    let requested = false;
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.delete(timer); if (!stopped) fn(); }, ms);
      timers.add(timer);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      timers.forEach(timer => clearTimeout(timer));
      clearInterval(heartbeat);
      request?.unsubscribe();
      if (clipID && socket.connected) socket.emit('clip-ended', { channelID: channel.id, clipID });
      socket.removeAllListeners();
      socket.disconnect();
    };
    const fail = () => { if (!stopped) { stop(); failed(); } };
    const send = (attempt = 0) => {
      requested = true;
      request = this.clips.testClip({ channelID: channel.id, streamer: channel.login, timeout: 30 }).pipe(timeout(20000)).subscribe({
        next: response => {
          if (stopped || clipID) return;
          if (response.error && response.status === 409 && attempt < 4) later(() => send(attempt + 1), 600);
          else if (response.error) fail();
        },
        error: fail
      });
    };
    socket.on('connect', () => {
      heartbeat = setInterval(() => socket.emit('ping'), 7000);
      later(() => send(), 700);
    });
    socket.on('connect_error', fail);
    socket.on('error', fail);
    socket.on('disconnect', fail);
    socket.on('play-clip', (data: { clipID?: string; streamerLogin?: string; title?: string; duration?: number }) => {
      if (stopped || !requested || clipID || typeof data?.clipID !== 'string') return;
      if (data.streamerLogin?.toLowerCase() !== channel.login.toLowerCase()) return;
      clipID = data.clipID;
      timers.forEach(timer => clearTimeout(timer));
      timers.clear();
      ready({ url: `${base}/video/clip/${encodeURIComponent(channel.id)}?t=${Date.now()}`, type: 'video',
        title: data.title || channel.login, volume: 1, duration: Math.min(30, Math.max(1, Number(data.duration) || 30)) });
    });
    later(fail, 120000);
    socket.connect();
    return stop;
  }
}
