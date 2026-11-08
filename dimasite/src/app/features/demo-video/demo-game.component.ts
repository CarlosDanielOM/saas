import { ChangeDetectionStrategy, Component } from '@angular/core';

/** One stylised pine: three stacked tiers and a trunk, as a single path. */
function pine(x: number, base: number, h: number): string {
  const tiers = [0, 1, 2].map((i) => {
    const top = base - h + i * h * 0.27, bottom = top + h * 0.46, w = h * (0.34 + 0.13 * i);
    return `M${x} ${top}L${x + w / 2} ${bottom}L${x - w / 2} ${bottom}Z`;
  });
  return tiers.join('') + `M${x - h * 0.05} ${base - h * 0.08}h${h * 0.1}v${h * 0.12}h${-h * 0.1}Z`;
}

const RIDGE = [
  [40, 742, 92], [118, 730, 120], [190, 738, 84], [262, 724, 132], [336, 731, 98], [420, 745, 70], [520, 740, 110], [610, 748, 76],
  [1290, 714, 104], [1360, 709, 140], [1436, 716, 96], [1510, 724, 122], [1590, 734, 88], [1676, 744, 116], [1760, 740, 82], [1840, 728, 128],
  [1930, 716, 100], [2010, 712, 136], [2080, 712, 90]
];

/** Fireflies / pollen: position, size, timing (seconds). */
const MOTES = [
  [210, 610, 9, 6.2, -1.1], [380, 700, 7, 5.1, -3.4], [560, 560, 11, 7.4, -0.6], [690, 650, 8, 5.8, -4.2], [820, 520, 7, 6.6, -2.3],
  [1080, 600, 10, 5.4, -1.8], [1190, 690, 8, 7.0, -5.1], [1330, 560, 9, 6.0, -0.2], [1460, 650, 12, 7.8, -3.0], [1600, 590, 7, 5.6, -2.7],
  [1720, 690, 9, 6.8, -4.6], [1840, 610, 8, 5.2, -1.4], [470, 820, 6, 6.4, -2.0], [1530, 830, 7, 5.9, -3.7]
];

/**
 * The game on the fake stream: a layered landscape with slow parallax, a little explorer on the path,
 * drifting clouds and motes, and an in-game HUD. 1920x1080 canvas. Colors come from --g-* / --h-* custom
 * properties set per look; every motion is a CSS animation driven by the scene clock.
 */
@Component({
  selector: 'app-demo-game',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sky"></div>
    <div class="sun"><i></i></div>
    <svg class="layer clouds" viewBox="0 0 2200 400" aria-hidden="true">
      <g class="cloud"><ellipse cx="260" cy="150" rx="120" ry="38" /><ellipse cx="330" cy="128" rx="80" ry="44" /><ellipse cx="200" cy="138" rx="64" ry="30" /></g>
      <g class="cloud"><ellipse cx="980" cy="90" rx="150" ry="34" /><ellipse cx="1060" cy="70" rx="90" ry="40" /><ellipse cx="900" cy="80" rx="70" ry="28" /></g>
      <g class="cloud"><ellipse cx="1720" cy="170" rx="130" ry="32" /><ellipse cx="1790" cy="150" rx="78" ry="38" /></g>
    </svg>
    <svg class="layer far" viewBox="0 0 2304 1080" preserveAspectRatio="none" aria-hidden="true">
      <path class="far-a" d="M0 640L120 560L210 600L330 470L430 560L520 520L640 410L760 540L860 500L980 430L1100 530L1210 470L1330 390L1450 520L1560 470L1680 420L1800 540L1920 480L2040 430L2160 520L2304 470V1080H0Z" />
      <path class="snow" d="M640 410L606 456L624 450L640 468L657 449L676 457ZM1330 390L1294 440L1314 434L1330 452L1348 432L1368 442ZM980 430L952 466L968 462L982 476L996 460L1010 466ZM1680 420L1650 458L1668 452L1682 466L1696 452L1712 458Z" />
      <path class="far-b" d="M0 700Q160 610 320 660T640 640T960 622T1280 650T1600 615T1920 650T2304 630V1080H0Z" />
      <rect class="haze" x="0" y="560" width="2304" height="200" />
    </svg>
    <svg class="layer mid" viewBox="0 0 2112 1080" preserveAspectRatio="none" aria-hidden="true">
      <path class="hill" d="M0 760C220 690 420 700 640 730C860 760 1060 690 1280 700C1500 710 1700 760 1920 720C2010 705 2060 700 2112 705V1080H0Z" />
      <path class="trees" [attr.d]="trees" />
    </svg>
    <svg class="layer ground" viewBox="0 0 1920 1080" preserveAspectRatio="none" aria-hidden="true">
      <path class="land" d="M0 792C400 770 800 802 1200 786C1500 776 1750 792 1920 780V1080H0Z" />
      <path class="road" d="M926 792C896 862 752 962 588 1080H1332C1176 962 1026 862 994 792Z" />
      <path class="stones" d="M876 868a14 7 0 1 0 28 0a14 7 0 1 0 -28 0M1040 900a17 8 0 1 0 34 0a17 8 0 1 0 -34 0M760 980a20 9 0 1 0 40 0a20 9 0 1 0 -40 0M1176 1010a22 10 0 1 0 44 0a22 10 0 1 0 -44 0M940 820a9 4 0 1 0 18 0a9 4 0 1 0 -18 0" />
      <path class="grass" d="M300 860l10-34l10 34ZM318 862l14-40l8 40ZM1500 850l9-30l9 30ZM1518 852l12-36l8 36ZM1640 900l10-34l10 34ZM640 900l8-28l8 28ZM655 902l12-34l6 34ZM1290 880l8-26l8 26Z" />
    </svg>
    <svg class="layer hero" viewBox="-120 -170 240 240" aria-hidden="true">
      <ellipse class="shadow" cx="0" cy="56" rx="58" ry="12" />
      <g class="body">
        <path class="scarf" d="M-8 -66C-40 -62 -70 -52 -96 -30C-80 -48 -60 -60 -40 -60C-64 -46 -82 -30 -92 -12C-70 -36 -40 -52 -6 -56Z" />
        <path class="cloak" d="M-48 44C-52 -8 -40 -58 0 -68C40 -58 52 -8 48 44C30 54 -30 54 -48 44Z" />
        <rect class="pack" x="-30" y="-52" width="60" height="58" rx="14" />
        <rect class="roll" x="-35" y="-68" width="70" height="20" rx="10" />
        <path class="steel" d="M22 -62L66 -126L74 -120L32 -56Z" />
        <rect class="hilt" x="16" y="-68" width="30" height="8" rx="4" transform="rotate(-55 31 -64)" />
        <path class="hood" d="M-30 -84C-30 -116 30 -116 30 -84C30 -66 18 -58 0 -58C-18 -58 -30 -66 -30 -84Z" />
        <path class="hood-tip" d="M-6 -112C4 -132 18 -138 26 -134C16 -126 14 -116 12 -108Z" />
      </g>
    </svg>
    <svg class="layer fore" viewBox="0 0 1920 1080" preserveAspectRatio="none" aria-hidden="true">
      <path class="fg" d="M0 1080V600C26 610 52 680 62 760C76 850 88 960 106 1080Z" />
      <path class="fg-leaf" d="M-60 470C-20 400 70 392 118 440C170 420 230 450 226 506C262 532 246 590 196 592C168 626 104 618 76 594C20 612 -50 590 -60 540Z" />
      <path class="fg-rim" d="M-30 452C10 412 70 410 104 444C70 430 20 436 -30 470Z" />
      <path class="fg" d="M1700 1080C1712 1010 1760 970 1820 976C1860 940 1920 950 1940 990V1080Z" />
      <path class="fg" d="M140 1080l14-70l12 70ZM180 1080l18-96l12 96ZM230 1080l10-60l12 60ZM1600 1080l12-64l10 64ZM1640 1080l16-90l10 90ZM480 1080l10-50l10 50ZM1420 1080l10-56l10 56Z" />
      <path class="flowers" d="M206 1012a7 7 0 1 0 14 0a7 7 0 1 0 -14 0M262 1040a6 6 0 1 0 12 0a6 6 0 1 0 -12 0M1666 1022a7 7 0 1 0 14 0a7 7 0 1 0 -14 0M1612 1050a5 5 0 1 0 10 0a5 5 0 1 0 -10 0" />
    </svg>
    <div class="motes" aria-hidden="true">
      @for (m of motes; track $index) {
        <i [style.left.px]="m[0]" [style.top.px]="m[1]" [style.width.px]="m[2]" [style.height.px]="m[2]" [style.animation-duration.s]="m[3]" [style.animation-delay.s]="m[4]"></i>
      }
    </div>
    <div class="tone" aria-hidden="true"></div>

    <!-- In-game HUD: hearts, mana, a hotbar and a minimap. -->
    <div class="hud-game" aria-hidden="true">
      <div class="hearts">
        @for (h of [1, 2, 3, 4, 5]; track h) {
          <svg viewBox="0 0 24 22" [class.empty]="h === 5"><path d="M12 21C5 15 1 11 1 6.5A5.5 5.5 0 0 1 12 4a5.5 5.5 0 0 1 11 2.5C23 11 19 15 12 21Z" /></svg>
        }
      </div>
      <div class="mana"><i></i></div>
      <div class="slots">
        <span><svg viewBox="0 0 24 24"><path d="M14.5 4h5v5L9 19.5 4.5 15ZM3 21l3-3M6 15l3 3" /></svg><b>1</b></span>
        <span><svg viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z" /></svg><b>2</b></span>
        <span><svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v5L5 17a3 3 0 0 0 3 4h8a3 3 0 0 0 3-4l-5-9V3" /></svg><b>3</b></span>
        <span><svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z" /></svg><b>4</b></span>
      </div>
    </div>
    <div class="minimap" aria-hidden="true">
      <svg viewBox="0 0 160 160">
        <circle class="mm-bg" cx="80" cy="80" r="76" />
        <path class="mm-land" d="M20 96C40 70 70 84 92 70C112 58 136 66 150 84V140H20Z" />
        <path class="mm-land" d="M30 40C48 28 70 34 76 48C64 58 40 58 30 40Z" />
        <path class="mm-road" d="M80 154C76 124 94 108 86 84C80 66 96 48 118 36" />
        <circle class="mm-quest" cx="118" cy="36" r="6" />
        <path class="mm-you" d="M80 70L90 94L80 88L70 94Z" />
        <circle class="mm-ring" cx="80" cy="80" r="76" />
        <text x="80" y="20">N</text>
      </svg>
    </div>
  `,
  styles: `
    :host { position: absolute; inset: 0; display: block; overflow: hidden; }
    .sky, .sun, .layer, .motes, .tone { position: absolute; }
    .sky { inset: 0; background: linear-gradient(180deg, var(--g-sky-1, #161a24) 0%, var(--g-sky-2, #3a2d5c) 72%); }
    .sun { left: var(--g-sun-x, 1560px); top: var(--g-sun-y, 210px); width: 0; height: 0; }
    .sun::before { content: ''; position: absolute; left: -260px; top: -260px; width: 520px; height: 520px; border-radius: 50%;
      background: radial-gradient(circle, var(--g-sun-glow, rgba(196, 181, 253, 0.35)) 0%, transparent 65%); }
    .sun i { position: absolute; left: calc(var(--g-sun-r, 64px) * -1); top: calc(var(--g-sun-r, 64px) * -1); width: calc(var(--g-sun-r, 64px) * 2);
      aspect-ratio: 1; border-radius: 50%; background: var(--g-sun, #ede9fe); }

    .layer { left: 0; top: 0; height: 1080px; overflow: visible; }
    .clouds { top: 0; width: 2200px; height: 400px; animation: drift-right 48s linear both; }
    .cloud ellipse { fill: var(--g-cloud, rgba(196, 181, 253, 0.16)); }
    .far { width: 2304px; animation: pan-far 40s linear both; }
    .far-a { fill: var(--g-far, #2e2a4a); }
    .far-b { fill: var(--g-far-2, #24213b); }
    .snow { fill: var(--g-snow, #c4b5fd); opacity: 0.85; }
    .haze { fill: var(--g-sky-2, #3a2d5c); opacity: 0.28; }
    .mid { width: 2112px; animation: pan-mid 40s linear both; }
    .hill { fill: var(--g-mid, #1d1f2c); }
    .trees { fill: var(--g-trees, #15161f); }
    .ground { width: 1920px; }
    .land { fill: var(--g-ground, #171923); }
    .road { fill: var(--g-path, #3b3360); }
    .stones { fill: var(--g-stone, #2a2d3c); }
    .grass { fill: var(--g-grass, #232636); }

    .hero { left: 840px; top: 760px; width: 240px; height: 240px; }
    .hero .body { transform-box: view-box; transform-origin: 0 50px; animation: bob 1.3s ease-in-out infinite alternate; }
    .shadow { fill: rgba(0, 0, 0, 0.28); }
    .cloak { fill: var(--g-hero, #8b5cf6); }
    .hood, .hood-tip { fill: var(--g-hero-dark, #5b21b6); }
    .pack { fill: var(--g-pack, #334155); }
    .roll { fill: var(--g-roll, #c4b5fd); }
    .steel { fill: var(--g-steel, #e2e8f0); }
    .hilt { fill: var(--g-accent, #fbbf24); }
    .scarf { fill: var(--g-accent, #fbbf24); transform-box: fill-box; transform-origin: 100% 30%; animation: flutter 0.9s ease-in-out infinite alternate; }

    .fore { width: 1920px; }
    .fg, .fg-leaf { fill: var(--g-fore, #0e0f15); }
    .fg-rim { fill: var(--g-snow, #c4b5fd); opacity: 0.22; }
    .flowers { fill: var(--g-flower, #f9a8d4); }

    .motes { inset: 0; }
    .motes i { position: absolute; border-radius: 50%; background: radial-gradient(circle, var(--g-fire, #c4b5fd) 0 30%, transparent 70%);
      opacity: var(--g-fire-opacity, 0.9); animation: float 6s ease-in-out infinite; }
    .tone { inset: 0; opacity: var(--g-tone, 0); mix-blend-mode: multiply;
      background: radial-gradient(rgba(29, 27, 23, 0.55) 2.4px, transparent 2.9px) 0 0 / 13px 13px; }

    .hud-game { position: absolute; right: 56px; bottom: 52px; display: grid; justify-items: end; gap: 12px; }
    .hearts { display: flex; gap: 8px; }
    .hearts svg { width: 38px; height: 35px; }
    .hearts path { fill: var(--h-heart, #ef4444); stroke: rgba(0, 0, 0, 0.35); stroke-width: 1.2; }
    .hearts .empty path { fill: rgba(0, 0, 0, 0.35); stroke: var(--h-heart, #ef4444); stroke-width: 1.6; }
    .mana { width: 222px; height: 14px; padding: 3px; border-radius: 99px; background: var(--h-panel, rgba(10, 11, 16, 0.55)); }
    .mana i { display: block; width: 72%; height: 100%; border-radius: 99px; background: var(--h-mana, #8b5cf6); }
    .slots { display: flex; gap: 10px; }
    .slots span { position: relative; display: grid; place-items: center; width: 74px; height: 74px; border-radius: 16px;
      background: var(--h-panel, rgba(10, 11, 16, 0.55)); box-shadow: inset 0 0 0 3px rgba(255, 255, 255, 0.22); }
    .slots span:first-child { box-shadow: inset 0 0 0 3px var(--h-mana, #8b5cf6); }
    .slots svg { width: 38px; height: 38px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .slots b { position: absolute; left: 8px; top: 4px; color: rgba(255, 255, 255, 0.8); font: 700 16px/1 'Inter Tight', 'Plus Jakarta Sans', sans-serif; }

    .minimap { position: absolute; right: 56px; top: 56px; width: 168px; height: 168px; }
    .minimap svg { width: 100%; height: 100%; }
    .mm-bg { fill: var(--h-panel, rgba(10, 11, 16, 0.55)); }
    .mm-land { fill: var(--g-mid, #1d1f2c); opacity: 0.9; }
    .mm-road { fill: none; stroke: var(--g-path, #3b3360); stroke-width: 6; stroke-linecap: round; }
    .mm-quest { fill: var(--g-accent, #fbbf24); }
    .mm-you { fill: #fff; }
    .mm-ring { fill: none; stroke: rgba(255, 255, 255, 0.6); stroke-width: 3; }
    .minimap text { fill: #fff; font: 800 15px/1 'Inter Tight', 'Plus Jakarta Sans', sans-serif; text-anchor: middle; }

    @keyframes pan-far { to { transform: translateX(-140px); } }
    @keyframes pan-mid { to { transform: translateX(-220px); } }
    @keyframes drift-right { to { transform: translateX(120px); } }
    @keyframes bob { to { transform: translateY(-7px); } }
    @keyframes flutter { from { transform: rotate(-4deg) skewY(-3deg); } to { transform: rotate(5deg) skewY(4deg); } }
    @keyframes float { 0%, 100% { transform: translate(0, 0); opacity: 0.25; } 50% { transform: translate(14px, -46px); opacity: 1; } }
  `
})
export class DemoGameComponent {
  readonly trees = RIDGE.map(([x, base, h]) => pine(x, base, h)).join('');
  readonly motes = MOTES;
}
