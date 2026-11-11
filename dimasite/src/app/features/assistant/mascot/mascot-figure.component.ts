import { ChangeDetectionStrategy, Component } from '@angular/core';

import { MASCOT_PATHS, MASCOT_VIEWBOX } from './mascot-paths';

let nextId = 0;

/**
 * The docs character as articulated SVG parts (same structure as dimadocs MascotFigure.astro). Decorative: the button
 * around it carries the label. Motion follows state attributes on any ancestor (`data-am-state`, `data-am-pose`, …,
 * see mascot-figure.component.css), so the panel can reuse it (e.g. in its header) by setting `data-am-state` on a wrapper.
 */
@Component({
  selector: 'app-mascot-figure',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './mascot-figure.component.css',
  template: `
    <svg class="am-figure" [attr.viewBox]="viewBox" fill-rule="evenodd" aria-hidden="true" focusable="false">
      <defs>
        <path [attr.id]="id + '-head'" [attr.d]="paths.head" />
        <clipPath [attr.id]="id + '-hat'"><rect x="0" y="0" width="944" height="161" /></clipPath>
        <clipPath [attr.id]="id + '-face'"><rect x="0" y="161" width="944" height="380" /></clipPath>
      </defs>
      <g class="am-figure__float">
        <path class="am-figure__body" [attr.d]="paths.body" />
        <path class="am-figure__arm am-figure__arm--left" [attr.d]="paths.armLeft" />
        <path class="am-figure__arm am-figure__arm--right" [attr.d]="paths.armRight" />
        <g class="am-figure__head">
          <g [attr.clip-path]="'url(#' + id + '-face)'"><use [attr.href]="'#' + id + '-head'" /></g>
          <g class="am-figure__hat"><g [attr.clip-path]="'url(#' + id + '-hat)'"><use [attr.href]="'#' + id + '-head'" /></g></g>
          <path class="am-figure__eyes" [attr.d]="paths.eyes" />
          <path class="am-figure__moustache" [attr.d]="paths.moustache" />
        </g>
      </g>
    </svg>
  `,
})
export class MascotFigureComponent {
  readonly id = `am-fig-${nextId++}`;
  readonly viewBox = MASCOT_VIEWBOX;
  readonly paths = MASCOT_PATHS;
}
