import { Component, ChangeDetectionStrategy, ElementRef, afterRenderEffect, inject, input, untracked } from '@angular/core';
import type { AlertMotion } from './overlay.model';
import type { AlertKeyframes, MotionPhase, MotionProperty } from './overlay-keyframes.model';
import { motionWindows } from './overlay-motion-timing';
import { playKeyframeSequence } from './overlay-keyframe-player';
@Component({
  selector: 'app-overlay-keyframe-phase', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="kf-property" data-kf-property="x"><div class="kf-property" data-kf-property="y"><div class="kf-property" data-kf-property="rotation"><div class="kf-property" data-kf-property="scale"><div class="kf-property" data-kf-property="opacity"><ng-content /></div></div></div></div></div>`,
  styles: `:host,.kf-property { display:block; width:100%; height:100%; transform-origin:center; overflow:visible }`
})
export class OverlayKeyframePhaseComponent {
  readonly keyframes = input<AlertKeyframes>(); readonly phase = input.required<MotionPhase>();
  readonly motion = input.required<AlertMotion>(); readonly duration = input(5);
  readonly playbackKey = input<string | number>(0); readonly seekTime = input<number | null>(null);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private player?: ReturnType<typeof playKeyframeSequence>;
  constructor() {
    afterRenderEffect(cleanup => {
      const keyframes = this.keyframes(), phase = this.phase(), sequence = keyframes?.[phase];
      const motion = this.motion(), total = this.duration(), key = this.playbackKey();
      if (!key || !sequence) return;
      // These first five elements belong to this phase; nested phases project after them.
      const nodes = [...this.host.querySelectorAll<HTMLElement>('.kf-property')].slice(0, 5);
      const elements = Object.fromEntries(nodes.map(node => [node.dataset['kfProperty'], node])) as Record<MotionProperty, HTMLElement>;
      const preference = matchMedia('(prefers-reduced-motion: reduce)');
      const play = () => playKeyframeSequence(elements, sequence, phase, motionWindows(motion, total, keyframes)[phase], total, preference.matches);
      let player = play(); this.player = player;
      const time = untracked(this.seekTime); if (time !== null) player.seek(time);
      const changed = () => { const elapsed = untracked(this.seekTime) ?? player.time(); player.cancel(); player = play(); this.player = player; player.seek(elapsed, untracked(this.seekTime) !== null); };
      preference.addEventListener('change', changed);
      cleanup(() => { player.cancel(); this.player = undefined; preference.removeEventListener('change', changed); });
    });
    afterRenderEffect(() => { const time = this.seekTime(); if (time !== null) this.player?.seek(time); });
  }
}
