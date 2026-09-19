import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild
} from '@angular/core';

import type { ClipDesignVariant } from '../clips.model';

@Component({
  selector: 'app-clip-design-mock',
  templateUrl: './clip-design-mock.component.html',
  styleUrl: './clip-design-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ClipDesignMockComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly frameRef = viewChild<ElementRef<HTMLElement>>('frame');

  readonly variant = input.required<ClipDesignVariant>();
  readonly accent = input<string>('#8b5cf6');
  readonly streamer = input<string>('Your Channel');
  readonly game = input<string>('Just Chatting');
  readonly title = input<string>('Your clip title');
  readonly caption = input<string>('Your caption appears here');

  readonly scale = signal(0.42);

  private resizeObserver: ResizeObserver | null = null;
  private frameHandle = 0;

  constructor() {
    afterNextRender(() => this.bindScale());
    this.destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      cancelAnimationFrame(this.frameHandle);
    });
  }

  initials(): string {
    const name = this.streamer().trim();
    if (!name) {
      return 'CL';
    }
    const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
    return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || 'CL';
  }

  private bindScale(): void {
    const frame = this.frameRef()?.nativeElement;
    if (!frame || typeof ResizeObserver === 'undefined') {
      return;
    }

    const update = () => {
      const width = frame.clientWidth - 28;
      const height = frame.clientHeight - 28;
      if (width <= 0 || height <= 0) {
        return;
      }
      const next = Math.min(width / 800, height / 225);
      this.scale.set(Math.max(next, 0.2));
    };

    this.resizeObserver = new ResizeObserver(update);
    this.resizeObserver.observe(frame);

    let attempts = 0;
    const kick = () => {
      update();
      if (attempts < 10 && (frame.clientWidth === 0 || frame.clientHeight === 0)) {
        attempts += 1;
        this.frameHandle = requestAnimationFrame(kick);
      }
    };
    kick();
  }
}
