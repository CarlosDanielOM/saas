import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DuelCharacter, DuelMove } from './duel-battle';

/**
 * Original vector characters. Every character shares the same rig (body, head,
 * weapon-arm, back-arm, cloth) so common motions work for all of them, while
 * attacks swap per character. The arena remounts this component for each action,
 * so one-shot animations restart even when a fighter attacks twice in a row.
 */
@Component({
  selector: 'app-duel-fighter',
  template: `
    <svg viewBox="0 0 220 240" aria-hidden="true" focusable="false">
      <ellipse class="shadow" cx="104" cy="221" rx="58" ry="9" fill="#000" opacity=".3" />
      <ellipse class="aura" cx="106" cy="128" rx="78" ry="98" />
      <g class="body">
        @switch (character()) {
          @case ('ronin') {
            <path class="cloth" d="M96 90Q62 84 28 104Q46 102 54 110Q34 120 22 140Q62 122 100 104Z" fill="var(--fighter-light)" stroke="#171724" stroke-width="4" />
            <g class="leg back-leg"><path d="M86 146L62 204H94L102 156Z" fill="var(--fighter-deep)" stroke="#171724" stroke-width="5"/><path d="M58 202H92L93 212H56Z" fill="#232738" stroke="#171724" stroke-width="3"/></g>
            <g class="leg front-leg"><path d="M110 146L138 204H108L102 156Z" fill="var(--fighter-deep)" stroke="#171724" stroke-width="5"/><path d="M108 202H142L145 212H108Z" fill="#232738" stroke="#171724" stroke-width="3"/></g>
            <g class="back-arm"><path d="M48 160L134 140" stroke="#3a2a22" stroke-width="8" stroke-linecap="round"/><path d="M82 100L68 128 86 144" fill="none" stroke="var(--fighter-color)" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/><circle cx="88" cy="145" r="8" fill="#2a2f42" stroke="#171724" stroke-width="3"/></g>
            <path d="M78 92Q105 82 132 92L138 152H74Z" fill="var(--fighter-color)" stroke="#171724" stroke-width="5"/>
            <path d="M92 91L106 120 120 91" fill="none" stroke="var(--fighter-light)" stroke-width="7" stroke-linejoin="round"/>
            <path d="M74 136H138V150H74Z" fill="#232738"/><path d="M122 140L134 158M126 140L120 160" stroke="var(--fighter-deep)" stroke-width="5" stroke-linecap="round"/>
            <g class="head"><path d="M84 62Q84 44 106 44 128 44 128 62V80Q118 92 106 92 94 92 84 80Z" fill="#2a2f42" stroke="#171724" stroke-width="5"/><path d="M95 66H103M115 66H123" class="eyes" stroke="var(--fighter-light)" stroke-width="5" stroke-linecap="round"/><path d="M86 74Q106 82 126 74" fill="none" stroke="var(--fighter-deep)" stroke-width="5"/><path d="M48 52L106 16 164 52Q106 64 48 52Z" fill="#d8b36a" stroke="#171724" stroke-width="5" stroke-linejoin="round"/><path d="M72 42Q106 32 140 42M106 18V30" fill="none" stroke="#a8823f" stroke-width="3"/></g>
            <g class="weapon-arm"><path d="M128 100L150 118" stroke="var(--fighter-color)" stroke-width="20" stroke-linecap="round"/><g class="weapon"><path d="M161 108L198 28 203 24 202 33 167 112Z" fill="#f1f5fc" stroke="#171724" stroke-width="3.5"/><path d="M190 42L166 100" stroke="#9baac4" stroke-width="2.5"/><path d="M146 128L158 112" stroke="#6e4b32" stroke-width="9" stroke-linecap="round"/><ellipse cx="160" cy="110" rx="9" ry="5" transform="rotate(-62 160 110)" fill="#ffe2a5" stroke="#171724" stroke-width="3"/><circle cx="152" cy="121" r="9" fill="#2a2f42" stroke="#171724" stroke-width="3"/></g></g>
            <g class="potion"><rect x="84" y="128" width="8" height="9" rx="2" fill="#a8823f" stroke="#171724" stroke-width="2.5"/><path d="M82 137H94V141Q101 145 100 153 98 162 88 162 78 162 76 153 75 145 82 141Z" fill="#5dff9a" stroke="#171724" stroke-width="3"/><path d="M81 148Q83 144 86 144" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/></g>
          }
          @case ('mage') {
            <path class="cloth" d="M82 118Q50 168 38 208H92Z" fill="var(--fighter-deep)" stroke="#171724" stroke-width="5" stroke-linejoin="round"/>
            <g class="leg back-leg"><path d="M84 196L76 212H98L100 196Z" fill="#232738" stroke="#171724" stroke-width="4"/></g>
            <g class="leg front-leg"><path d="M116 196L118 212H142L134 196Z" fill="#232738" stroke="#171724" stroke-width="4"/></g>
            <g class="back-arm"><path d="M84 100Q66 112 62 132" fill="none" stroke="var(--fighter-color)" stroke-width="20" stroke-linecap="round"/><circle class="cast-hand" cx="60" cy="138" r="9" fill="var(--fighter-light)" stroke="#171724" stroke-width="3"/></g>
            <path d="M78 90Q106 80 134 90L150 206H62Z" fill="var(--fighter-color)" stroke="#171724" stroke-width="5" stroke-linejoin="round"/>
            <path d="M106 96V204" stroke="var(--fighter-light)" stroke-width="7"/><path d="M70 140Q106 152 142 140" fill="none" stroke="#232738" stroke-width="9"/>
            <circle cx="88" cy="176" r="5" fill="var(--fighter-light)"/><circle cx="126" cy="176" r="5" fill="var(--fighter-light)"/><path d="M94 112L100 122M118 112L112 122" stroke="var(--fighter-deep)" stroke-width="4" stroke-linecap="round"/>
            <g class="head"><path d="M76 72Q74 30 108 18Q118 14 126 4Q126 30 140 50Q146 66 138 86Q122 100 106 100Q88 100 76 86Z" fill="var(--fighter-deep)" stroke="#171724" stroke-width="5" stroke-linejoin="round"/><path d="M88 64Q90 48 108 48 126 48 128 64V80Q118 90 108 90 96 90 88 80Z" fill="#14121f"/><g class="eyes"><rect x="96" y="63" width="8" height="5" rx="2" fill="var(--fighter-light)"/><rect x="114" y="63" width="8" height="5" rx="2" fill="var(--fighter-light)"/></g><path d="M84 40Q96 26 112 24" fill="none" stroke="var(--fighter-light)" stroke-width="4" stroke-linecap="round" opacity=".6"/></g>
            <g class="guard ward"><circle cx="106" cy="122" r="100" fill="var(--fighter-light)" fill-opacity=".14" stroke="var(--fighter-light)" stroke-width="4"/><path d="M106 22L193 72V172L106 222 19 172V72Z" fill="none" stroke="var(--fighter-light)" stroke-width="2.5" stroke-opacity=".6"/><path d="M40 90Q106 60 172 90" fill="none" stroke="#fff" stroke-width="3" stroke-opacity=".5" stroke-linecap="round"/></g>
            <g class="weapon-arm"><path d="M130 100L152 124" stroke="var(--fighter-color)" stroke-width="20" stroke-linecap="round"/><g class="weapon"><path d="M154 212L164 42" stroke="#6e4b32" stroke-width="8" stroke-linecap="round"/><path d="M164 44Q172 24 156 16" fill="none" stroke="#6e4b32" stroke-width="7" stroke-linecap="round"/><circle class="orb" cx="161" cy="30" r="13" fill="var(--fighter-light)" stroke="#171724" stroke-width="4"/><circle cx="157" cy="26" r="4" fill="#fff"/><circle cx="158" cy="126" r="9" fill="var(--fighter-light)" stroke="#171724" stroke-width="3"/></g></g>
          }
          @default {
            <path class="cloth" d="M75 85Q44 107 39 179L87 166 111 96Z" fill="var(--fighter-deep)" stroke="#171724" stroke-width="5" />
            <g class="leg back-leg"><path d="M87 155L79 199" stroke="#232738" stroke-width="25" stroke-linecap="round"/><path d="M77 187L69 209H97L98 187Z" fill="var(--fighter-color)" stroke="#171724" stroke-width="5"/></g>
            <g class="leg front-leg"><path d="M121 155L129 199" stroke="#232738" stroke-width="25" stroke-linecap="round"/><path d="M116 187L115 209H148L143 187Z" fill="var(--fighter-color)" stroke="#171724" stroke-width="5"/></g>
            <path d="M75 91Q106 79 135 94L140 150 125 171H82L67 150Z" fill="var(--fighter-color)" stroke="#171724" stroke-width="5"/>
            <path d="M87 103L107 96 127 103 122 137 107 148 92 137Z" fill="var(--fighter-light)"/>
            <path d="M105 103V135M95 119H117" stroke="var(--fighter-deep)" stroke-width="6" stroke-linecap="round"/>
            <path d="M72 148H136" stroke="#232738" stroke-width="10"/><rect x="99" y="141" width="17" height="15" rx="3" fill="#ffe2a5" stroke="#171724" stroke-width="3"/>
            <g class="back-arm"><path d="M77 104L56 128" stroke="var(--fighter-light)" stroke-width="22" stroke-linecap="round"/><path d="M32 120L58 110 83 120 79 151 58 170 36 151Z" fill="var(--fighter-deep)" stroke="#171724" stroke-width="5"/><path d="M43 128L58 122 72 128 69 145 58 156 47 145Z" fill="var(--fighter-color)"/><path d="M58 128V149M49 137H67" stroke="var(--fighter-light)" stroke-width="4"/></g>
            <g class="head"><path class="plume" d="M97 32Q89 13 109 7 129 9 131 26L115 43Z" fill="var(--fighter-color)" stroke="#171724" stroke-width="5"/><path d="M71 59Q71 27 105 27 140 27 142 60V85Q124 101 105 101 85 99 70 84Z" fill="#e0e6ef" stroke="#171724" stroke-width="5"/><path d="M74 63H143L138 86 105 94 74 84Z" fill="#30364b"/><path d="M108 33V60H143" fill="none" stroke="#a1b0c9" stroke-width="6"/><path class="eyes" d="M94 70H101M122 70H129" stroke="var(--fighter-light)" stroke-width="5" stroke-linecap="round"/><path d="M108 77V88" stroke="#65748e" stroke-width="4"/><path d="M75 45Q84 32 101 33" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></g>
            <g class="weapon-arm"><path d="M131 104L153 121" stroke="var(--fighter-light)" stroke-width="22" stroke-linecap="round"/><g class="weapon"><path d="M155 118L174 42 184 22 188 45 168 121Z" fill="#f1f5fc" stroke="#171724" stroke-width="4"/><path d="M174 48L163 107" stroke="#9baac4" stroke-width="3"/><path d="M147 112L177 120" stroke="#ffe2a5" stroke-width="9" stroke-linecap="round"/><path d="M159 119L153 139" stroke="#6e4b32" stroke-width="8" stroke-linecap="round"/><circle cx="154" cy="124" r="11" fill="var(--fighter-color)" stroke="#171724" stroke-width="4"/></g></g>
            <path class="guard barrier" d="M176 64Q214 128 176 196" fill="none" stroke="var(--fighter-light)" stroke-width="9" stroke-linecap="round"/>
          }
        }
      </g>
      <path class="slash" d="M153 22Q248 83 175 183Q213 92 153 22Z" fill="var(--fighter-light)" />
    </svg>
  `,
  styles: `
    :host { display:block; width:100%; --fighter-color:#9b7afa; --fighter-light:#d6c7ff; --fighter-deep:#5d399d; --dur:800ms }
    :host([data-side="right"]) { --fighter-color:#efac48; --fighter-light:#ffe1a0; --fighter-deep:#996027 }
    :host([data-move="heavy"]) { --dur:1050ms }
    :host([data-move="special"]) { --dur:1600ms }
    svg { display:block; width:100%; overflow:visible }
    .body { transform-origin:105px 213px; animation:breathe 1.8s ease-in-out infinite }
    .cloth { transform-origin:90px 94px; animation:cloth 2.4s ease-in-out infinite }
    .head { transform-origin:106px 92px }
    .weapon-arm { transform-origin:129px 102px }
    .back-arm { transform-origin:80px 102px }
    .aura { fill:var(--fighter-light); opacity:0; transform-origin:106px 128px; filter:blur(10px) }
    .slash { opacity:0; transform-origin:130px 105px }
    .orb { filter:drop-shadow(0 0 6px var(--fighter-light)); transform-box:fill-box; transform-origin:center }
    .eyes { filter:drop-shadow(0 0 3px var(--fighter-light)) }
    /* Enraged streamer: red pulsing aura and red eyes (move/heal auras still take over). */
    :host([data-enraged="true"]) .aura { fill:#ff3b3b; animation:rage-aura 1s ease-in-out infinite }
    :host([data-enraged="true"]) path.eyes { stroke:#ff4d4d }
    :host([data-enraged="true"]) .eyes rect { fill:#ff4d4d }
    :host([data-enraged="true"]) .eyes { filter:drop-shadow(0 0 5px #ff3b3b) }
    :host([data-low="true"][data-action="idle"]) .body { animation:pant .9s ease-in-out infinite }
    :host([data-low="true"]) svg { filter:drop-shadow(0 0 6px #ff4d5a88) }

    /* Attacks: the strike lands at the move's windup (35% / 43% / 53%). */
    :host([data-action="attack"]) .body { animation:lunge var(--dur) ease both }
    :host([data-action="attack"]) .weapon-arm { animation:swing var(--dur) ease both }
    :host([data-action="attack"]) .slash { animation:slash var(--dur) ease both }
    :host([data-action="attack"][data-move="heavy"]) .body { animation-name:lunge-heavy }
    :host([data-action="attack"][data-move="heavy"]) .weapon-arm { animation-name:swing-heavy }
    :host([data-action="attack"][data-move="heavy"]) .slash { animation-name:slash-heavy }
    :host([data-action="attack"][data-move="special"]) .body { animation-name:lunge-special }
    :host([data-action="attack"][data-move="special"]) .weapon-arm { animation-name:swing-special }
    :host([data-action="attack"][data-move="special"]) .slash { animation-name:slash-special }
    :host([data-action="attack"][data-move="special"]) .aura { animation:aura var(--dur) ease both }
    :host([data-action="attack"][data-move="special"]) .eyes { animation:glow var(--dur) ease both }
    /* The mage casts instead of swinging; the arena draws the spell. */
    :host([data-character="mage"][data-action="attack"]) .slash { animation:none }
    :host([data-character="mage"][data-action="attack"]) .weapon-arm { animation-name:cast }
    :host([data-character="mage"][data-action="attack"][data-move="heavy"]) .weapon-arm { animation-name:cast-heavy }
    :host([data-character="mage"][data-action="attack"][data-move="special"]) .weapon-arm { animation-name:cast-special }
    :host([data-character="mage"][data-action="attack"]) .back-arm { animation:cast-hand var(--dur) ease both }
    :host([data-character="mage"][data-action="attack"]) .orb { animation:orb var(--dur) ease both }

    :host([data-action="hit"]) .body { animation:recoil .5s ease both }
    :host([data-action="hit"][data-move="heavy"]) .body { animation:recoil-heavy .65s ease both }
    :host([data-action="hit"][data-move="special"]) .body { animation:recoil-special .85s ease both }
    :host([data-action="hit"]) svg { animation:hit-flash .36s steps(2) }
    /* Defense skills (arena remounts on 'defend'); the blow lands at ~28%. */
    :host { --def-dur:700ms }
    :host([data-move="heavy"]) { --def-dur:880ms }
    /* Against a special the guard is up for the long windup, then the arena remounts as 'hit'. */
    :host([data-move="special"]) { --def-dur:1800ms }
    .guard { opacity:0; transform-box:fill-box; transform-origin:center }
    .barrier { filter:drop-shadow(0 0 8px var(--fighter-light)) }
    :host([data-action="defend"]) .body { animation:brace var(--def-dur) ease both }
    :host([data-action="defend"]) .guard { animation:guard var(--def-dur) ease both }
    :host([data-action="defend"][data-character="knight"]) .back-arm { animation:shield-up var(--def-dur) ease both }
    :host([data-action="defend"][data-character="ronin"]) .body { animation:ghost-step var(--def-dur) ease both }
    :host([data-action="defend"][data-character="ronin"]) svg { filter:drop-shadow(22px 0 0 color-mix(in srgb,var(--fighter-light) 45%,transparent)) drop-shadow(44px 0 0 color-mix(in srgb,var(--fighter-light) 22%,transparent)) }
    :host([data-action="defend"][data-move="heavy"]) svg { animation:hit-flash .3s steps(2) calc(var(--def-dur) * .28) }
    /* Heals (1.5 s, HP lands at 60%): green glow for all, then per-character poses. */
    .potion { opacity:0; transform-box:fill-box; transform-origin:center }
    :host([data-action="heal"]) svg { animation:heal-glow 1.5s ease both }
    :host([data-action="heal"]) .aura { fill:#5dff9a; animation:aura-heal 1.5s ease both }
    :host([data-action="heal"][data-character="knight"]) .body { animation:pray 1.5s ease both }
    :host([data-action="heal"][data-character="knight"]) .weapon-arm { animation:lower 1.5s ease both }
    :host([data-action="heal"][data-character="knight"]) .head { animation:bow 1.5s ease both }
    :host([data-action="heal"][data-character="ronin"]) .potion { animation:drink 1.5s ease both }
    :host([data-action="heal"][data-character="ronin"]) .head { animation:tilt-back 1.5s ease both }
    :host([data-action="heal"][data-character="ronin"]) .back-arm { animation:lift 1.5s ease both }
    :host([data-action="heal"][data-character="mage"]) .weapon-arm { animation:raise-staff 1.5s ease both }
    :host([data-action="heal"][data-character="mage"]) .orb { fill:#9dffc4; filter:drop-shadow(0 0 12px #5dff9a) }
    :host([data-action="heal"][data-character="mage"]) .eyes { filter:drop-shadow(0 0 6px #5dff9a) }
    :host([data-action="defeated"]) .body { animation:fall 1.1s cubic-bezier(.3,.6,.4,1) forwards }
    :host([data-action="defeated"]) .weapon-arm { animation:drop 1.1s ease forwards }
    :host([data-action="victory"]) .body { animation:celebrate 1.2s ease-in-out infinite }
    :host([data-action="victory"]) .weapon-arm { transform:rotate(-38deg) }
    :host([data-action="victory"][data-character="mage"]) .weapon-arm { transform:rotate(-12deg) translateY(-10px) }
    :host([data-action="victory"][data-character="mage"]) .orb { animation:orb-victory 1.2s ease-in-out infinite }
    :host([data-action="victory"]) .aura { opacity:.18 }
    :host([data-paused="true"]) * { animation-play-state:paused !important }

    @keyframes rage-aura { 0%,100% { opacity:.2; transform:scale(.96) } 50% { opacity:.38; transform:scale(1.04) } }
    @keyframes breathe { 50% { transform:translateY(-3px) rotate(-1deg) } }
    @keyframes pant { 50% { transform:translateY(4px) rotate(4deg) } }
    @keyframes cloth { 50% { transform:rotate(5deg) } }
    @keyframes lunge { 25% { transform:translateX(-8px) rotate(-7deg) } 35%,50% { transform:translateX(16px) rotate(10deg) } 100% { transform:none } }
    @keyframes lunge-heavy { 34% { transform:translate(-14px,6px) rotate(-14deg) scaleY(.94) } 43%,62% { transform:translate(22px,-4px) rotate(15deg) } 100% { transform:none } }
    @keyframes lunge-special { 0% { transform:none } 20%,46% { transform:translateY(-16px) rotate(-6deg) scale(1.06) } 53%,72% { transform:translate(24px,2px) rotate(16deg) scale(1.06) } 100% { transform:none } }
    @keyframes swing { 25% { transform:rotate(-55deg) } 35%,52% { transform:rotate(95deg) } 100% { transform:none } }
    @keyframes swing-heavy { 34% { transform:rotate(-100deg) } 43%,62% { transform:rotate(115deg) } 100% { transform:none } }
    @keyframes swing-special { 20% { transform:rotate(-120deg) } 46% { transform:rotate(-128deg) } 53%,74% { transform:rotate(125deg) } 100% { transform:none } }
    @keyframes slash { 28% { opacity:0; transform:rotate(-30deg) } 36% { opacity:.95; transform:rotate(50deg) } 60%,100% { opacity:0; transform:rotate(100deg) } }
    @keyframes slash-heavy { 36% { opacity:0; transform:rotate(-40deg) scale(1.15) } 44% { opacity:1; transform:rotate(55deg) scale(1.3) } 70%,100% { opacity:0; transform:rotate(110deg) scale(1.3) } }
    @keyframes slash-special { 46% { opacity:0; transform:rotate(-40deg) scale(1.4) } 54% { opacity:1; transform:rotate(60deg) scale(1.6) } 78%,100% { opacity:0; transform:rotate(120deg) scale(1.6) } }
    @keyframes aura { 0% { opacity:0; transform:scale(.6) } 15% { opacity:.35 } 30% { opacity:.6; transform:scale(1) } 40% { opacity:.4; transform:scale(.95) } 50% { opacity:.75; transform:scale(1.08) } 60% { opacity:.3 } 100% { opacity:0; transform:scale(1.2) } }
    @keyframes glow { 10%,55% { filter:drop-shadow(0 0 8px #fff) brightness(1.6) } 100% { filter:none } }
    @keyframes cast { 22% { transform:rotate(-22deg) } 35%,55% { transform:rotate(52deg) } 100% { transform:none } }
    @keyframes cast-heavy { 30% { transform:rotate(-40deg) translateY(-6px) } 43%,62% { transform:rotate(64deg) } 100% { transform:none } }
    @keyframes cast-special { 15%,48% { transform:rotate(-18deg) translateY(-16px) } 53%,74% { transform:rotate(70deg) } 100% { transform:none } }
    @keyframes cast-hand { 30%,55% { transform:rotate(-40deg) } 100% { transform:none } }
    @keyframes orb { 0% { transform:none } 30% { transform:scale(1.5); filter:drop-shadow(0 0 14px var(--fighter-light)) brightness(1.5) } 55% { transform:scale(1.2) } 100% { transform:none } }
    @keyframes orb-victory { 50% { filter:drop-shadow(0 0 16px var(--fighter-light)) brightness(1.6) } }
    @keyframes recoil { 30% { transform:translateX(-18px) rotate(-12deg) } 65% { transform:translateX(-10px) rotate(-5deg) } }
    @keyframes recoil-heavy { 25% { transform:translate(-30px,-6px) rotate(-20deg) } 60% { transform:translateX(-16px) rotate(-8deg) } }
    @keyframes recoil-special { 18% { transform:translate(-44px,-18px) rotate(-30deg) } 40% { transform:translate(-30px,0) rotate(-16deg) } 55% { transform:translateX(-24px) rotate(-12deg) } 75% { transform:translateX(-10px) rotate(-4deg) } }
    @keyframes hit-flash { 50% { filter:brightness(2.4) saturate(.4) } }
    @keyframes brace { 20%,70% { transform:translateX(-5px) rotate(-3deg) } 30% { transform:translateX(-12px) rotate(-5deg) } 100% { transform:none } }
    @keyframes guard { 0%,8% { opacity:0; transform:scale(.4) } 20% { opacity:.9; transform:scale(1) } 28% { opacity:1; transform:scale(1.08); filter:brightness(1.8) drop-shadow(0 0 14px #fff) } 36%,72% { opacity:.85; transform:scale(1) } 100% { opacity:0; transform:scale(1.1) } }
    @keyframes shield-up { 18%,75% { transform:translate(88px,-14px) rotate(6deg) } 28% { transform:translate(80px,-12px) rotate(2deg) } 100% { transform:none } }
    @keyframes ghost-step { 0% { transform:none; opacity:1 } 18%,70% { transform:translateX(-52px) skewX(-8deg); opacity:.55 } 100% { transform:none; opacity:1 } }
    @keyframes heal-glow { 0%,40% { filter:none } 58%,78% { filter:drop-shadow(0 0 4px #5dff9a) drop-shadow(0 0 14px #5dff9a) brightness(1.15) } 100% { filter:none } }
    @keyframes aura-heal { 0%,25% { opacity:0; transform:scale(.7) } 60% { opacity:.55; transform:scale(1.05) } 78% { opacity:.35 } 100% { opacity:0; transform:scale(1.15) } }
    @keyframes pray { 15%,80% { transform:translateY(8px) rotate(3deg) } 100% { transform:none } }
    @keyframes lower { 15%,80% { transform:rotate(48deg) } 100% { transform:none } }
    @keyframes bow { 15%,45% { transform:rotate(10deg) } 60%,80% { transform:rotate(-8deg) } 100% { transform:none } }
    @keyframes drink { 0% { opacity:0; transform:none } 12% { opacity:1; transform:none } 35%,60% { opacity:1; transform:translate(22px,-64px) rotate(-130deg) } 75% { opacity:1; transform:translate(4px,-10px) rotate(-20deg) } 88%,100% { opacity:0; transform:none } }
    @keyframes tilt-back { 30%,60% { transform:rotate(-14deg) } 100% { transform:none } }
    @keyframes lift { 30%,60% { transform:rotate(-30deg) } 100% { transform:none } }
    @keyframes raise-staff { 15%,80% { transform:rotate(-16deg) translateY(-14px) } 100% { transform:none } }
    @keyframes fall { 18% { transform:translate(-30px,-10px) rotate(-22deg) } 100% { transform:translate(-20px,14px) rotate(-82deg) } }
    @keyframes drop { 100% { transform:rotate(60deg) } }
    @keyframes celebrate { 50% { transform:translateY(-13px) rotate(-3deg) } }
    @media (prefers-reduced-motion:reduce) {
      * { animation:none !important }
      :host([data-action="defeated"]) .body { opacity:.45; transform:rotate(-15deg) }
      :host([data-action="hit"]) .body { opacity:.65 }
      :host([data-action="defend"]) .guard { opacity:.8 }
    }
  `,
  host: { '[attr.data-side]': 'side()', '[attr.data-character]': 'character()', '[attr.data-action]': 'action()', '[attr.data-move]': 'move()', '[attr.data-low]': 'low()', '[attr.data-enraged]': 'enraged()', '[attr.data-paused]': 'paused()' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DuelFighterComponent {
  readonly side = input.required<'left' | 'right'>();
  readonly character = input<DuelCharacter>('knight');
  readonly action = input('idle');
  readonly move = input<DuelMove>('normal');
  readonly low = input(false);
  readonly enraged = input(false);
  readonly paused = input(false);
}
