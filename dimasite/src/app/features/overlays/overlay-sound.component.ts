import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { AssetLibraryService } from '../../shared/asset-library/asset-library.service';
import { LinksService } from '../../services/links.service';
import { LanguageService } from '../../services/language.service';
import type { AlertSound } from './overlay.model';

export interface AlertTransport { time: number; playing: boolean; seek: number }

/** One instance per alert design/event, shared by preview and the OBS renderer. */
@Component({
  selector: 'app-overlay-sound', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<audio #audio preload="auto" aria-hidden="true"></audio>@if (blocked()) { <button type="button" (click)="retry()">{{ language.translate('overlayStudio.enableSound') }}</button> }`,
  styles: `:host { display:block } audio { display:none } button { min-height:44px; padding:.6rem 1rem; border:1px solid #7c3aed; border-radius:1rem; background:#7c3aed; color:white; font:inherit; cursor:pointer } button:focus-visible { outline:3px solid #c4b5fd; outline-offset:2px }`
})
export class OverlaySoundComponent {
  readonly sound = input.required<AlertSound>();
  readonly duration = input.required<number>();
  readonly playbackKey = input.required<string | number>();
  readonly owner = input('');
  readonly transport = input<AlertTransport | null>(null);
  private syncTimeline?: () => void;
  readonly publicId = input('');
  readonly failed = output<void>();
  readonly playbackBlocked = output<void>();
  readonly started = output<void>();
  readonly blocked = signal(false);
  readonly language = inject(LanguageService);
  private readonly library = inject(AssetLibraryService);
  private readonly base = inject(LinksService).getApiUrl();
  private readonly audio = viewChild.required<ElementRef<HTMLAudioElement>>('audio');
  private playAgain: (() => void) | null = null;
  retry(): void { this.playAgain?.(); }
  constructor() {
    afterRenderEffect(cleanup => {
      const sound = this.sound(), duration = this.duration(), owner = this.owner(), publicId = this.publicId(); this.playbackKey();
      if (untracked(this.transport)) { this.timelineAudio(sound, duration, owner, publicId, cleanup); return; }
      const audio = this.audio().nativeElement, began = performance.now();
      let disposed = false, playing = false, done = false, timer: ReturnType<typeof setTimeout> | undefined;
      this.blocked.set(false); audio.loop = false; audio.volume = 0;
      const elapsed = () => (performance.now() - began) / 1000;
      const stop = () => { done = true; audio.pause(); this.blocked.set(false); clearTimeout(timer); };
      const fail = () => { if (!disposed && !done) { stop(); this.failed.emit(); } };
      const updateVolume = () => {
        if (elapsed() >= duration) { stop(); return; }
        if (!playing || !Number.isFinite(audio.duration)) return;
        const position = audio.currentTime;
        const remaining = Math.max(0, Math.min(audio.duration - position, duration - elapsed()));
        const fadeIn = sound.fadeIn ? Math.min(1, position / sound.fadeIn) : 1;
        const fadeOut = sound.fadeOut ? Math.min(1, remaining / sound.fadeOut) : 1;
        audio.volume = Math.max(0, Math.min(1, sound.volume * Math.min(fadeIn, fadeOut)));
      };
      const play = () => {
        if (disposed || done || playing || elapsed() >= duration) return;
        const position = Math.max(0, elapsed() - sound.delay);
        if (position >= audio.duration) { stop(); return; }
        try { audio.currentTime = position; } catch { fail(); return; }
        playing = true; updateVolume();
        void audio.play().then(() => { if (disposed || done) { audio.pause(); return; } this.blocked.set(false); this.started.emit(); }).catch(error => {
          if (disposed || done) return;
          playing = false;
          if (error?.name === 'NotAllowedError') { this.blocked.set(true); this.playbackBlocked.emit(); }
          else fail();
        });
      };
      this.playAgain = play;
      audio.onloadedmetadata = () => { if (!disposed && !done) timer = setTimeout(play, Math.max(0, sound.delay - elapsed()) * 1000); };
      audio.onerror = fail; audio.onended = stop;
      const interval = setInterval(updateVolume, 40);
      cleanup(() => { disposed = true; done = true; clearTimeout(timer); clearInterval(interval); this.playAgain = null; audio.onloadedmetadata = null; audio.onerror = null; audio.onended = null; audio.pause(); audio.removeAttribute('src'); audio.load(); });
      if (sound.volume === 0 || sound.delay >= duration) return;
      const source = publicId ? Promise.resolve(`${this.base}/overlay-studio/public/${encodeURIComponent(publicId)}/assets/${sound.assetId}`) : this.library.preview(owner, sound.assetId);
      void source.then(url => { if (!disposed && !done) { audio.src = url; audio.load(); } }).catch(fail);
    });
    afterRenderEffect(() => { this.transport(); this.syncTimeline?.(); });
  }
  private timelineAudio(sound: AlertSound, duration: number, owner: string, publicId: string, cleanup: (fn: () => void) => void): void {
    const audio = this.audio().nativeElement;
    let disposed = false, broken = false, ready = false, playing = false, blocked = false, seek = -1, attempt = 0;
    this.blocked.set(false); audio.volume = 0; audio.loop = false;
    const pause = () => { if (playing || !audio.paused) { attempt++; audio.pause(); } playing = false; };
    const fail = () => { if (!disposed && !broken) { broken = true; pause(); this.failed.emit(); } };
    const sync = () => {
      const clock = untracked(this.transport); if (disposed || broken || !clock || !ready) return;
      const position = Math.max(0, clock.time - sound.delay), inside = clock.time >= sound.delay && clock.time < duration && position < audio.duration;
      const target = Math.min(position, Math.max(0, audio.duration - .001));
      if (clock.seek !== seek || !clock.playing || Math.abs(audio.currentTime - target) > .25) { audio.currentTime = target; seek = clock.seek; }
      const remaining = Math.max(0, Math.min(audio.duration - position, duration - clock.time));
      audio.volume = Math.max(0, Math.min(1, sound.volume * Math.min(sound.fadeIn ? position / sound.fadeIn : 1, sound.fadeOut ? remaining / sound.fadeOut : 1, 1)));
      if (document.hidden || !clock.playing || !inside || sound.volume === 0) { pause(); return; }
      if (playing || blocked) return;
      playing = true; const run = ++attempt;
      void audio.play().then(() => { if (disposed) { audio.pause(); return; } if (run === attempt) { this.blocked.set(false); this.started.emit(); } }).catch(error => {
        if (disposed || run !== attempt) return; playing = false;
        if (error?.name === 'NotAllowedError') { blocked = true; this.blocked.set(true); this.playbackBlocked.emit(); }
        else if (error?.name !== 'AbortError') fail();
      });
    };
    const visibility = () => { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', visibility);
    this.syncTimeline = sync; this.playAgain = () => { blocked = false; sync(); };
    audio.onloadedmetadata = () => { ready = Number.isFinite(audio.duration) && audio.duration > 0; if (ready) sync(); else fail(); };
    audio.onerror = fail;
    cleanup(() => { document.removeEventListener('visibilitychange', visibility); disposed = true; attempt++; this.syncTimeline = undefined; this.playAgain = null; audio.onloadedmetadata = null; audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); });
    const source = publicId ? Promise.resolve(`${this.base}/overlay-studio/public/${encodeURIComponent(publicId)}/assets/${sound.assetId}`) : this.library.preview(owner, sound.assetId);
    void source.then(url => { if (!disposed) { audio.src = url; audio.load(); } }).catch(fail);
  }
}
