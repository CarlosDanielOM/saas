import { Directive, ElementRef, effect, inject, input, type OnDestroy } from '@angular/core';

/**
 * Shows the first frame of a video thumbnail without loading every video up front.
 * The source is attached only when the element nears the viewport, and the `#t=0.1`
 * fragment makes mobile browsers paint a frame instead of a black box.
 */
@Directive({
  selector: 'video[appLazyVideoFrame]',
  host: {
    muted: '',
    playsinline: '',
    preload: 'metadata',
    tabindex: '-1',
    'aria-hidden': 'true'
  }
})
export class LazyVideoFrameDirective implements OnDestroy {
  readonly appLazyVideoFrame = input<string | null | undefined>('');

  private readonly video = inject<ElementRef<HTMLVideoElement>>(ElementRef).nativeElement;
  private observer: IntersectionObserver | null = null;

  constructor() {
    this.video.muted = true;
    effect(() => this.watch(this.appLazyVideoFrame() || ''));
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  private watch(url: string): void {
    this.observer?.disconnect();
    this.video.removeAttribute('src');
    if (!url) return;

    const src = url.includes('#') ? url : `${url}#t=0.1`;
    if (typeof IntersectionObserver === 'undefined') {
      this.video.src = src;
      return;
    }

    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.video.src = src;
        this.observer?.disconnect();
      }
    }, { rootMargin: '200px' });
    this.observer.observe(this.video);
  }
}
