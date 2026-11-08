import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The streamer's facecam: a 2D (VTuber-style) streamer with a headset and mic arm in a room lit by an LED strip,
 * with a shelf (and a tiny DomDimaBot figurine), a plant and a poster. Blinks and sways on the scene clock.
 * Colors come from --c-* custom properties set per look.
 */
@Component({
  selector: 'app-demo-cam',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="dcWall" x1="0" y1="0" x2="0" y2="1"><stop class="wall-1" offset="0" /><stop class="wall-2" offset="1" /></linearGradient>
        <radialGradient id="dcLed" cx="0.15" cy="0" r="0.9"><stop class="led" offset="0" stop-opacity="0.75" /><stop class="led" offset="1" stop-opacity="0" /></radialGradient>
        <linearGradient id="dcStrip" x1="0" y1="0" x2="0" y2="1"><stop class="led" offset="0" stop-opacity="0.9" /><stop class="led" offset="1" stop-opacity="0" /></linearGradient>
        <radialGradient id="dcFace" cx="0.42" cy="0.38" r="0.75"><stop class="skin" offset="0.55" /><stop class="skin-shade" offset="1" /></radialGradient>
      </defs>
      <!-- Room -->
      <rect width="400" height="300" fill="url(#dcWall)" />
      <rect width="400" height="300" fill="url(#dcLed)" />
      <rect class="led-bar" x="0" y="0" width="400" height="5" />
      <rect x="0" y="5" width="400" height="60" fill="url(#dcStrip)" opacity="0.35" />
      <rect class="poster" x="54" y="58" width="64" height="84" rx="4" />
      <path class="poster-art" d="M64 120L80 92L92 108L100 98L110 120Z" />
      <circle class="poster-sun" cx="100" cy="78" r="7" />
      <rect class="shelf" x="262" y="112" width="122" height="7" rx="2" />
      <rect class="fig-a" x="276" y="90" width="20" height="22" rx="4" />
      <circle class="fig-b" cx="318" cy="101" r="11" />
      <g class="fig-bot">
        <rect x="340" y="88" width="24" height="18" rx="6" />
        <rect x="345" y="106" width="14" height="6" rx="2" />
        <circle class="fig-eye" cx="347" cy="96" r="2.4" /><circle class="fig-eye" cx="357" cy="96" r="2.4" />
      </g>
      <path class="pot" d="M24 226H64L58 270H30Z" />
      <path class="leaf" d="M44 228C30 206 20 196 14 176C30 186 40 200 44 228ZM44 228C46 200 54 184 66 172C66 194 58 210 44 228ZM44 228C40 210 42 194 48 182C54 198 52 214 44 228Z" />

      <!-- Streamer -->
      <g class="me">
        <path class="hoodie" d="M78 300C84 238 126 212 200 208C274 212 316 238 322 300Z" />
        <path class="hood" d="M128 228C140 210 166 204 200 206C234 204 260 210 272 228C252 222 228 220 200 222C172 220 148 222 128 228Z" />
        <path class="string" d="M184 222V262M216 222V262" />
        <circle class="string-tip" cx="184" cy="264" r="3.5" /><circle class="string-tip" cx="216" cy="264" r="3.5" />
        <rect class="neck" x="182" y="180" width="36" height="34" rx="10" />
        <path class="hair" d="M140 160C130 92 170 70 200 70C232 70 272 92 262 160C258 192 252 204 246 210H154C148 204 142 192 140 160Z" />
        <ellipse cx="200" cy="148" rx="54" ry="60" fill="url(#dcFace)" />
        <path class="hair" d="M146 128C150 92 176 80 202 80C230 80 254 96 256 130C240 116 226 112 214 120C206 108 190 106 178 118C168 110 156 116 146 128Z" />
        <ellipse class="blush" cx="171" cy="170" rx="10" ry="5" /><ellipse class="blush" cx="229" cy="170" rx="10" ry="5" />
        <path class="brow" d="M172 134Q182 128 192 133M208 133Q218 128 228 134" />
        <g class="eyes">
          <ellipse class="eye" cx="182" cy="154" rx="7.5" ry="9.5" /><ellipse class="eye" cx="218" cy="154" rx="7.5" ry="9.5" />
          <circle class="glint" cx="184.5" cy="150" r="2.6" /><circle class="glint" cx="220.5" cy="150" r="2.6" />
        </g>
        <path class="mouth" d="M190 182Q200 191 210 182" />
        <path class="band" d="M144 142C144 70 256 70 256 142" />
        <rect class="cup" x="130" y="126" width="26" height="48" rx="12" /><rect class="cup" x="244" y="126" width="26" height="48" rx="12" />
        <rect class="cup-led" x="134" y="132" width="18" height="36" rx="9" /><rect class="cup-led" x="248" y="132" width="18" height="36" rx="9" />
        <path class="boom" d="M140 172C146 190 160 196 174 194" />
        <ellipse class="mic" cx="180" cy="194" rx="9" ry="6.5" />
      </g>
    </svg>
  `,
  styles: `
    :host { position: absolute; inset: 0; display: block; }
    svg { display: block; width: 100%; height: 100%; }
    .wall-1 { stop-color: var(--c-wall-1, #1f2330); }
    .wall-2 { stop-color: var(--c-wall-2, #13151c); }
    .led { stop-color: var(--c-led, #8b5cf6); }
    .led-bar { fill: var(--c-led, #8b5cf6); }
    .skin { stop-color: var(--c-skin, #f1c6a4); }
    .skin-shade { stop-color: var(--c-skin-shade, #d9a58a); }
    .poster { fill: var(--c-poster, #8b5cf6); opacity: 0.85; }
    .poster-art { fill: rgba(0, 0, 0, 0.35); }
    .poster-sun { fill: rgba(255, 255, 255, 0.7); }
    .shelf { fill: var(--c-shelf, #2a2f3d); }
    .fig-a { fill: var(--c-led, #8b5cf6); }
    .fig-b { fill: var(--c-pot, #fbbf24); }
    .fig-bot rect { fill: #e9e7f2; }
    .fig-eye { fill: #1b1b22; }
    .pot { fill: var(--c-pot, #8b5cf6); }
    .leaf { fill: var(--c-plant, #34d399); }

    .me { transform-box: view-box; transform-origin: 200px 300px; animation: sway 5.5s ease-in-out infinite alternate; }
    .hoodie { fill: var(--c-hoodie, #262b39); }
    .hood { fill: rgba(0, 0, 0, 0.22); }
    .string { fill: none; stroke: var(--c-string, #c4b5fd); stroke-width: 3; stroke-linecap: round; }
    .string-tip { fill: var(--c-string, #c4b5fd); }
    .neck { fill: var(--c-skin-shade, #d9a58a); }
    .hair { fill: var(--c-hair, #2a2238); }
    .blush { fill: #f49aa6; opacity: 0.4; }
    .brow { fill: none; stroke: var(--c-hair, #2a2238); stroke-width: 3.5; stroke-linecap: round; }
    .eyes { transform-box: fill-box; transform-origin: center; animation: blink 4.2s linear infinite; }
    .eye { fill: #1b1b22; }
    .glint { fill: #fff; }
    .mouth { fill: none; stroke: #8a3b45; stroke-width: 3; stroke-linecap: round; }
    .band { fill: none; stroke: #22232b; stroke-width: 11; stroke-linecap: round; }
    .cup { fill: #2a2b34; }
    .cup-led { fill: none; stroke: var(--c-led, #8b5cf6); stroke-width: 3; }
    .boom { fill: none; stroke: #2a2b34; stroke-width: 5; stroke-linecap: round; }
    .mic { fill: #111216; }

    @keyframes sway { from { transform: rotate(-1.4deg); } to { transform: rotate(1.4deg); } }
    @keyframes blink { 0%, 93%, 100% { transform: scaleY(1); } 95.5% { transform: scaleY(0.08); } }
  `
})
export class DemoCamComponent {}
