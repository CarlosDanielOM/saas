import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Original vector character; each limb can animate independently at any overlay size. */
@Component({
  selector: 'app-duel-fighter',
  template: `
    <svg viewBox="0 0 220 240" aria-hidden="true" focusable="false">
      <ellipse class="shadow" cx="104" cy="221" rx="58" ry="9" fill="#000" opacity=".3" />
      <g class="body">
        <path class="cape" d="M75 85Q44 107 39 179L87 166 111 96Z" fill="var(--fighter-deep)" stroke="#171724" stroke-width="5" />
        <g class="leg back-leg"><path d="M87 155L79 199" stroke="#232738" stroke-width="25" stroke-linecap="round"/><path d="M77 187L69 209H97L98 187Z" fill="var(--fighter-color)" stroke="#171724" stroke-width="5"/></g>
        <g class="leg front-leg"><path d="M121 155L129 199" stroke="#232738" stroke-width="25" stroke-linecap="round"/><path d="M116 187L115 209H148L143 187Z" fill="var(--fighter-color)" stroke="#171724" stroke-width="5"/></g>
        <path d="M75 91Q106 79 135 94L140 150 125 171H82L67 150Z" fill="var(--fighter-color)" stroke="#171724" stroke-width="5"/>
        <path d="M87 103L107 96 127 103 122 137 107 148 92 137Z" fill="var(--fighter-light)"/>
        <path d="M105 103V135M95 119H117" stroke="var(--fighter-deep)" stroke-width="6" stroke-linecap="round"/>
        <path d="M72 148H136" stroke="#232738" stroke-width="10"/><rect x="99" y="141" width="17" height="15" rx="3" fill="#ffe2a5" stroke="#171724" stroke-width="3"/>
        <g class="shield-arm"><path d="M77 104L56 128" stroke="var(--fighter-light)" stroke-width="22" stroke-linecap="round"/><path d="M32 120L58 110 83 120 79 151 58 170 36 151Z" fill="var(--fighter-deep)" stroke="#171724" stroke-width="5"/><path d="M43 128L58 122 72 128 69 145 58 156 47 145Z" fill="var(--fighter-color)"/><path d="M58 128V149M49 137H67" stroke="var(--fighter-light)" stroke-width="4"/></g>
        <g class="head"><path d="M97 32Q89 13 109 7 129 9 131 26L115 43Z" fill="var(--fighter-color)" stroke="#171724" stroke-width="5"/><path d="M71 59Q71 27 105 27 140 27 142 60V85Q124 101 105 101 85 99 70 84Z" fill="#e0e6ef" stroke="#171724" stroke-width="5"/><path d="M74 63H143L138 86 105 94 74 84Z" fill="#30364b"/><path d="M108 33V60H143" fill="none" stroke="#a1b0c9" stroke-width="6"/><path d="M94 70H101M122 70H129" stroke="var(--fighter-light)" stroke-width="5" stroke-linecap="round"/><path d="M108 77V88" stroke="#65748e" stroke-width="4"/><path d="M75 45Q84 32 101 33" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></g>
        <g class="sword-arm"><path d="M131 104L153 121" stroke="var(--fighter-light)" stroke-width="22" stroke-linecap="round"/><g class="sword"><path d="M155 118L174 42 184 22 188 45 168 121Z" fill="#f1f5fc" stroke="#171724" stroke-width="4"/><path d="M174 48L163 107" stroke="#9baac4" stroke-width="3"/><path d="M147 112L177 120" stroke="#ffe2a5" stroke-width="9" stroke-linecap="round"/><path d="M159 119L153 139" stroke="#6e4b32" stroke-width="8" stroke-linecap="round"/><circle cx="154" cy="124" r="11" fill="var(--fighter-color)" stroke="#171724" stroke-width="4"/></g></g>
      </g>
      <path class="slash" d="M153 22Q248 83 175 183Q213 92 153 22Z" fill="var(--fighter-light)" />
    </svg>
  `,
  styles: `
    :host { display:block; width:100%; --fighter-color:#9b7afa; --fighter-light:#d6c7ff; --fighter-deep:#5d399d }
    :host([data-side="right"]) { --fighter-color:#efac48; --fighter-light:#ffe1a0; --fighter-deep:#996027 }
    svg { display:block; width:100%; overflow:visible }
    .body { transform-origin:105px 213px; animation:breathe 1.8s ease-in-out infinite }
    .cape { transform-origin:84px 94px; animation:cape 2.4s ease-in-out infinite }
    .sword-arm { transform-origin:129px 103px }
    .slash { opacity:0; transform-origin:130px 105px }
    :host([data-action="attack"]) .body { animation:lunge .65s ease both }
    :host([data-action="attack"]) .sword-arm { animation:swing .65s ease both }
    :host([data-action="attack"]) .slash { animation:slash .65s ease both }
    :host([data-action="hit"]) .body { animation:recoil .65s ease both }
    :host([data-action="hit"]) .head { animation:hit-flash .4s steps(2) }
    :host([data-action="defeated"]) .body { animation:fall .7s ease forwards }
    :host([data-action="victory"]) .body { animation:celebrate 1.2s ease-in-out infinite }
    :host([data-action="victory"]) .sword-arm { transform:rotate(-35deg) }
    :host([data-paused="true"]) * { animation-play-state:paused !important }
    @keyframes breathe { 50% { transform:translateY(-3px) rotate(-1deg) } }
    @keyframes cape { 50% { transform:rotate(5deg) } }
    @keyframes lunge { 20% { transform:translateX(-10px) rotate(-8deg) } 48% { transform:translateX(26px) rotate(12deg) } 100% { transform:translateX(0) } }
    @keyframes swing { 20% { transform:rotate(-55deg) } 48%,65% { transform:rotate(95deg) } 100% { transform:rotate(0) } }
    @keyframes slash { 30% { opacity:0; transform:rotate(-30deg) } 48% { opacity:.9; transform:rotate(50deg) } 75%,100% { opacity:0; transform:rotate(100deg) } }
    @keyframes recoil { 35% { transform:translateX(-20px) rotate(-14deg) } 65% { transform:translateX(-12px) rotate(-7deg) } }
    @keyframes hit-flash { 25%,75% { filter:brightness(2) } }
    @keyframes fall { 100% { transform:translate(-15px,14px) rotate(-78deg) } }
    @keyframes celebrate { 50% { transform:translateY(-13px) rotate(-3deg) } }
    @media (prefers-reduced-motion:reduce) {
      * { animation:none !important }
      :host([data-action="defeated"]) .body { opacity:.45; transform:rotate(-15deg) }
      :host([data-action="hit"]) .body { opacity:.65 }
    }
  `,
  host: { '[attr.data-side]': 'side()', '[attr.data-action]': 'action()', '[attr.data-paused]': 'paused()' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DuelFighterComponent {
  readonly side = input.required<'left' | 'right'>();
  readonly action = input('idle');
  readonly paused = input(false);
}
