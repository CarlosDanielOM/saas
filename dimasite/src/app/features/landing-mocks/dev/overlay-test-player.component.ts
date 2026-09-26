import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, effect, input, output, signal, viewChild } from '@angular/core';
import { TestMedia } from './overlay-test-media.service';

@Component({
  selector: 'app-overlay-test-player',
  template: `
    @if (media().type === 'image') {
      <img [src]="media().url" [alt]="media().title" (load)="started.emit(undefined)" (error)="failed.emit()" />
    } @else {
      <video #player [src]="media().url" playsinline preload="auto" [muted]="muted()" [volume]="muted() ? 0 : media().volume"
        (canplay)="play()" (playing)="onPlaying()" (ended)="ended.emit()" (error)="failed.emit()"></video>
      @if (blocked()) { <button type="button" (pointerdown)="$event.stopPropagation()" (click)="$event.stopPropagation(); play()">{{ playLabel() }}</button> }
      @if (media().type === 'audio') { <span class="audio-label">{{ media().title }}</span> }
    }
    <span class="media-title">{{ media().title }}</span>
  `,
  styles: `
    :host { position:absolute; inset:0; display:block; overflow:hidden; border-radius:inherit; background:#10121a }
    video,img { width:100%; height:100%; object-fit:contain; display:block }
    .media-title { position:absolute; bottom:0; left:0; right:0; padding:4px 6px; color:white; background:#10121acc; font:10px/1.3 sans-serif; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:none }
    .audio-label { position:absolute; inset:15%; display:grid; place-content:center; color:white; font:12px/1.5 sans-serif; overflow-wrap:anywhere }
    button { position:absolute; z-index:1; inset:0; margin:auto; width:max-content; max-width:100%; height:44px; min-width:44px; padding:8px; border:1px solid #ddd; border-radius:8px; background:#22143f; color:#fff; cursor:pointer }
    button:focus-visible { outline:3px solid #c4b5fd }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OverlayTestPlayerComponent {
  readonly media = input.required<TestMedia>();
  readonly muted = input(false);
  readonly playLabel = input.required<string>();
  readonly ended = output<void>();
  readonly failed = output<void>();
  readonly started = output<number | undefined>();
  readonly blocked = signal(false);
  private readonly player = viewChild<ElementRef<HTMLVideoElement>>('player');
  private startedOnce = false;
  private attempting = false;

  constructor() {
    afterNextRender(() => this.play());
    effect(onCleanup => {
      const element = this.player()?.nativeElement;
      onCleanup(() => { element?.pause(); element?.removeAttribute('src'); element?.load(); });
    });
  }
  play(): void {
    const element = this.player()?.nativeElement;
    if (!element || this.attempting || !element.paused) return;
    this.attempting = true;
    void element.play().then(() => this.blocked.set(false)).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'NotAllowedError') this.blocked.set(true);
      else if (!(error instanceof DOMException && error.name === 'AbortError')) this.failed.emit();
    }).finally(() => { this.attempting = false; });
  }
  onPlaying(): void {
    if (!this.startedOnce) { this.startedOnce = true; this.started.emit(this.player()?.nativeElement.duration); }
    this.blocked.set(false);
  }
}
