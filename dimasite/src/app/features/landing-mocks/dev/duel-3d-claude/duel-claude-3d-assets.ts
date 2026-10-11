import * as T from 'three';

/**
 * Procedural textures and shader materials for the Claude 3D arena. Everything is drawn
 * at runtime (no downloads) and owned by the scene, which disposes it on teardown.
 */
export interface ClaudeAssets {
  noise: T.DataTexture; straw: T.DataTexture; stone: T.CanvasTexture; stoneBump: T.CanvasTexture;
  radial: T.CanvasTexture; glyph: T.CanvasTexture; sigil: T.CanvasTexture; feather: T.CanvasTexture;
  petal: T.CanvasTexture; crack: T.CanvasTexture; streak: T.CanvasTexture;
  engrave: T.CanvasTexture; weave: T.CanvasTexture; runeBand: T.CanvasTexture; mon: T.CanvasTexture;
  dispose(): void;
}

const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

function fbmTexture(size: number, stretchX = 1, stretchY = 1): T.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const lattice = (x: number, y: number, period: number) => hash(((x % period) + period) % period * 57 + (((y % period) + period) % period) * 131 + period * 7.13);
  const value = (x: number, y: number, period: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = lattice(xi, yi, period), b = lattice(xi + 1, yi, period), c = lattice(xi, yi + 1, period), d = lattice(xi + 1, yi + 1, period);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let n = 0, amp = .55, freq = 4;
    for (let o = 0; o < 5; o++) { n += value(x / size * freq * stretchX, y / size * freq * stretchY, freq * Math.max(stretchX, stretchY)) * amp; amp *= .5; freq *= 2; }
    const v = Math.max(0, Math.min(255, Math.round(n * 255)));
    data.set([v, v, v, 255], (y * size + x) * 4);
  }
  const texture = new T.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = T.RepeatWrapping; texture.needsUpdate = true;
  texture.generateMipmaps = true; texture.minFilter = T.LinearMipmapLinearFilter; texture.magFilter = T.LinearFilter;
  return texture;
}

function canvas(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, height = size): T.CanvasTexture {
  const element = document.createElement('canvas'); element.width = size; element.height = height;
  const g = element.getContext('2d')!; draw(g, size);
  const texture = new T.CanvasTexture(element); texture.colorSpace = T.SRGBColorSpace; texture.anisotropy = 4;
  return texture;
}

/** Radial flagstones for the arena floor: rings of cut stone, chipped edges and grout. */
function flagstones(bump: boolean): T.CanvasTexture {
  return canvas(1024, (g, s) => {
    const c = s / 2;
    g.fillStyle = bump ? '#202020' : '#141a29'; g.fillRect(0, 0, s, s);
    const rings = [0, 70, 150, 225, 300, 372, 440, 512];
    for (let r = 0; r < rings.length - 1; r++) {
      const inner = rings[r], outer = rings[r + 1], count = r === 0 ? 1 : 8 + r * 6;
      for (let i = 0; i < count; i++) {
        const a0 = i / count * Math.PI * 2 + r * .37, a1 = (i + 1) / count * Math.PI * 2 + r * .37, gap = 2.6 / Math.max(outer, 1);
        const shade = hash(r * 31 + i * 7.7);
        g.beginPath();
        if (r === 0) g.arc(c, c, outer - 3, 0, Math.PI * 2);
        else { g.arc(c, c, outer - 3, a0 + gap, a1 - gap); g.arc(c, c, inner + 3, a1 - gap * outer / inner, a0 + gap * outer / inner, true); }
        g.closePath();
        if (bump) g.fillStyle = `rgb(${150 + shade * 80},${150 + shade * 80},${150 + shade * 80})`;
        else { const l = 13 + shade * 9; g.fillStyle = `hsl(${228 + shade * 14},${18 + shade * 10}%,${l}%)`; }
        g.fill();
      }
    }
    // Hairline cracks and wear.
    g.lineWidth = 1.2;
    for (let i = 0; i < 90; i++) {
      let x = hash(i * 3.1) * s, y = hash(i * 5.7) * s;
      g.strokeStyle = bump ? '#3a3a3a' : '#0a0e18'; g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (hash(i * 9 + k) - .5) * 40; y += (hash(i * 13 + k) - .5) * 40; g.lineTo(x, y); }
      g.stroke();
    }
    if (!bump) for (let i = 0; i < 2600; i++) {
      g.fillStyle = `rgba(${hash(i) > .5 ? '190,180,255' : '10,12,24'},${hash(i * 2.3) * .08})`;
      g.fillRect(hash(i * 1.7) * s, hash(i * 4.1) * s, 2, 2);
    }
  });
}

/** Soft, gamma-friendly glow sprite. */
function radial(): T.CanvasTexture {
  return canvas(256, (g, s) => {
    const gradient = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(.18, 'rgba(255,255,255,.75)');
    gradient.addColorStop(.45, 'rgba(255,255,255,.2)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gradient; g.fillRect(0, 0, s, s);
  });
}

/** A magic circle: nested rings, a hexagram and invented glyphs around the band. */
function glyphCircle(seed: number, star: number): T.CanvasTexture {
  return canvas(1024, (g, s) => {
    const c = s / 2; g.translate(c, c); g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'round';
    const ring = (r: number, w: number) => { g.lineWidth = w; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); };
    ring(500, 6); ring(470, 2.5); ring(372, 3); ring(350, 1.5); ring(150, 3);
    g.lineWidth = 3; g.beginPath();
    for (let i = 0; i <= star; i++) { const a = i * Math.PI * 2 / star * (star === 6 ? 2 : 1) * (star === 5 ? 2 : 1) - Math.PI / 2; g.lineTo(Math.cos(a) * 350, Math.sin(a) * 350); }
    if (star === 6) for (let i = 0; i <= 3; i++) { const a = i * Math.PI * 2 / 3 + Math.PI / 2; g.lineTo(Math.cos(a) * 350, Math.sin(a) * 350); }
    g.stroke();
    // Glyph band between the outer rings.
    for (let i = 0; i < 36; i++) {
      g.save(); g.rotate(i / 36 * Math.PI * 2); g.translate(0, -420); g.lineWidth = 4; g.beginPath();
      for (let k = 0; k < 4; k++) {
        const r = hash(seed + i * 4 + k);
        if (r < .3) { g.moveTo(-14, -16 + k * 8); g.lineTo(14, -16 + k * 8); }
        else if (r < .55) { g.moveTo(-12 + k * 8, -20); g.lineTo(-12 + k * 8, 20); }
        else if (r < .8) { g.moveTo(-14, 18); g.lineTo(0, -20); g.lineTo(14, 18); }
        else { g.moveTo(10, 0); g.arc(0, 0, 10, 0, Math.PI * 2); }
      }
      g.stroke(); g.restore();
    }
    for (let i = 0; i < 12; i++) { g.save(); g.rotate(i / 12 * Math.PI * 2); g.beginPath(); g.arc(0, -150, 10, 0, Math.PI * 2); g.fill(); g.restore(); }
    for (let i = 0; i < 72; i++) { g.save(); g.rotate(i / 72 * Math.PI * 2); g.fillRect(-1.5, -500, 3, i % 6 === 0 ? 30 : 14); g.restore(); }
  });
}

function feather(): T.CanvasTexture {
  return canvas(128, (g, s) => {
    const h = s * 4; g.translate(s / 2, h);
    const gradient = g.createLinearGradient(0, 0, 0, -h);
    gradient.addColorStop(0, 'rgba(255,255,255,.25)'); gradient.addColorStop(.4, 'rgba(255,255,255,.95)'); gradient.addColorStop(1, 'rgba(255,255,255,.85)');
    g.fillStyle = gradient; g.beginPath(); g.moveTo(0, -4);
    g.bezierCurveTo(s * .5, -h * .25, s * .48, -h * .8, 0, -h + 4); g.bezierCurveTo(-s * .38, -h * .75, -s * .45, -h * .3, 0, -4); g.fill();
    g.globalCompositeOperation = 'destination-out'; g.lineWidth = 1.4;
    for (let i = 0; i < 26; i++) { const y = -h * (.12 + i * .032); g.beginPath(); g.moveTo(0, y); g.lineTo((i % 2 ? 1 : -1) * s * .5, y - 18); g.stroke(); }
    g.globalCompositeOperation = 'source-over'; g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -h + 10); g.stroke();
  }, 512);
}

function petal(): T.CanvasTexture {
  return canvas(128, (g, s) => {
    const gradient = g.createRadialGradient(s * .5, s * .8, 4, s * .5, s * .5, s * .6);
    gradient.addColorStop(0, '#fff'); gradient.addColorStop(1, '#ffd6e2');
    g.fillStyle = gradient; g.beginPath(); g.moveTo(s * .5, s * .98);
    g.bezierCurveTo(s * .02, s * .6, s * .2, s * .05, s * .42, s * .08); g.lineTo(s * .5, s * .2); g.lineTo(s * .58, s * .08);
    g.bezierCurveTo(s * .8, s * .05, s * .98, s * .6, s * .5, s * .98); g.fill();
  });
}

/** Radial shatter decal for ultimate impacts. */
function crack(): T.CanvasTexture {
  return canvas(1024, (g, s) => {
    const c = s / 2; g.translate(c, c); g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 0; i < 22; i++) {
      let a = i / 22 * Math.PI * 2 + hash(i) * .2, r = 30 + hash(i * 3) * 30, x = Math.cos(a) * r, y = Math.sin(a) * r;
      g.lineWidth = 7; g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 9; k++) {
        a += (hash(i * 17 + k) - .5) * .45; r += 32 + hash(i * 7 + k) * 30; x = Math.cos(a) * r; y = Math.sin(a) * r;
        g.lineWidth = Math.max(1.2, 7 - k * .7); g.lineTo(x, y);
        if (hash(i * 11 + k) > .72) { g.stroke(); g.beginPath(); g.moveTo(x, y); const b = a + (hash(k + i) - .5) * 1.4; g.lineTo(x + Math.cos(b) * 60, y + Math.sin(b) * 60); g.stroke(); g.beginPath(); g.moveTo(x, y); }
      }
      g.stroke();
    }
    g.lineWidth = 4; for (const r of [70, 150, 250]) { g.beginPath(); for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI * 2, j = r + (hash(i + r) - .5) * 20; g.lineTo(Math.cos(a) * j, Math.sin(a) * j); } g.globalAlpha = .45; g.stroke(); g.globalAlpha = 1; }
  });
}

/** Filigree scrollwork for engraved armour (bump only). */
function engrave(): T.CanvasTexture {
  const texture = canvas(512, (g, s) => {
    g.fillStyle = '#808080'; g.fillRect(0, 0, s, s); g.lineCap = 'round';
    for (let tile = 0; tile < 4; tile++) {
      const ox = (tile % 2) * s / 2, oy = Math.floor(tile / 2) * s / 2;
      for (let k = 0; k < 2; k++) {
        const cx = ox + s / 4 + (k ? 60 : -60), cy = oy + s / 4 + (k ? -40 : 40), dir = k ? -1 : 1;
        g.strokeStyle = '#d8d8d8'; g.lineWidth = 5; g.beginPath();
        for (let a = 0; a < 9.5; a += .1) { const r = 6 + a * 7, x = cx + Math.cos(a * dir) * r, y = cy + Math.sin(a * dir) * r; a ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke(); g.strokeStyle = '#3a3a3a'; g.lineWidth = 2; g.stroke();
        for (let l = 0; l < 6; l++) {
          const a = l * 1.4 + 1, r = 8 + a * 7, x = cx + Math.cos(a * dir) * r, y = cy + Math.sin(a * dir) * r;
          g.fillStyle = '#d0d0d0'; g.beginPath(); g.ellipse(x, y, 11, 4, a * dir + .8, 0, Math.PI * 2); g.fill();
        }
      }
    }
    g.strokeStyle = '#b8b8b8'; g.lineWidth = 6; for (const y of [3, s / 2 - 3, s / 2 + 3, s - 3]) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
  });
  texture.colorSpace = T.NoColorSpace; texture.wrapS = texture.wrapT = T.RepeatWrapping; return texture;
}

/** Fine twill weave for cloth (bump only). */
function weave(): T.CanvasTexture {
  const texture = canvas(256, (g, s) => {
    g.fillStyle = '#7a7a7a'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 4) for (let x = 0; x < s; x += 4) {
      const v = 110 + ((x / 4 + y / 4) % 4 < 2 ? 70 : 0) + hash(x * 3 + y * 7) * 30;
      g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, y, 4, 3);
    }
  });
  texture.colorSpace = T.NoColorSpace; texture.wrapS = texture.wrapT = T.RepeatWrapping; texture.repeat.set(6, 6); return texture;
}

/** A scrolling band of glyphs for glowing hems. */
function runeBand(): T.CanvasTexture {
  const texture = canvas(1024, (g, s) => {
    g.clearRect(0, 0, s, 64); g.strokeStyle = '#fff'; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath(); g.moveTo(0, 6); g.lineTo(s, 6); g.moveTo(0, 58); g.lineTo(s, 58); g.stroke();
    for (let i = 0; i < 40; i++) {
      const x = i * s / 40 + 12; g.beginPath();
      for (let k = 0; k < 3; k++) {
        const r = hash(i * 5 + k);
        if (r < .33) { g.moveTo(x, 16 + k * 12); g.lineTo(x + 14, 16 + k * 12); }
        else if (r < .66) { g.moveTo(x + k * 6, 14); g.lineTo(x + k * 6, 50); }
        else { g.moveTo(x, 48); g.lineTo(x + 7, 16); g.lineTo(x + 14, 48); }
      }
      g.stroke();
    }
  }, 64);
  texture.wrapS = T.RepeatWrapping; return texture;
}

/** Family crest for the ronin's haori: a crescent over three tomoe-like commas. */
function mon(): T.CanvasTexture {
  return canvas(256, (g, s) => {
    const c = s / 2; g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 10;
    g.beginPath(); g.arc(c, c, 112, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 3; i++) {
      g.save(); g.translate(c, c); g.rotate(i * Math.PI * 2 / 3); g.beginPath(); g.arc(0, -40, 26, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(26, -40); g.quadraticCurveTo(40, 10, -10, 30); g.quadraticCurveTo(14, -6, -26, -40); g.fill(); g.restore();
    }
  });
}

/** Horizontal light streak (lens flare bar / slash glint). */
function streak(): T.CanvasTexture {
  return canvas(512, (g, s) => {
    const gradient = g.createLinearGradient(0, 0, s, 0);
    gradient.addColorStop(0, 'rgba(255,255,255,0)'); gradient.addColorStop(.5, 'rgba(255,255,255,1)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gradient; g.fillRect(0, 0, s, 64);
    const vertical = g.createLinearGradient(0, 0, 0, 64);
    vertical.addColorStop(0, 'rgba(0,0,0,1)'); vertical.addColorStop(.5, 'rgba(0,0,0,0)'); vertical.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out'; g.fillStyle = vertical; g.fillRect(0, 0, s, 64);
  }, 64);
}

export function createAssets(): ClaudeAssets {
  const noise = fbmTexture(256), straw = fbmTexture(256, 18, 1);
  const stone = flagstones(false), stoneBump = flagstones(true);
  stoneBump.colorSpace = T.NoColorSpace;
  const assets: ClaudeAssets = {
    noise, straw, stone, stoneBump, radial: radial(), glyph: glyphCircle(3, 6), sigil: glyphCircle(11, 5),
    feather: feather(), petal: petal(), crack: crack(), streak: streak(), engrave: engrave(), weave: weave(), runeBand: runeBand(), mon: mon(),
    dispose: () => { for (const texture of [noise, straw, stone, stoneBump, assets.radial, assets.glyph, assets.sigil, assets.feather, assets.petal, assets.crack, assets.streak, assets.engrave, assets.weave, assets.runeBand, assets.mon]) texture.dispose(); },
  };
  return assets;
}

/** Additive, unlit material used by nearly every effect. */
export function additive(color: T.ColorRepresentation, map?: T.Texture | null, opacity = 1): T.MeshBasicMaterial {
  return new T.MeshBasicMaterial({ color, map: map ?? null, transparent: true, opacity, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false });
}

export function sprite(map: T.Texture, color: T.ColorRepresentation, scale = 1): T.Sprite {
  const s = new T.Sprite(new T.SpriteMaterial({ map, color, transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }));
  s.scale.setScalar(scale); return s;
}

const NOISE_GLSL = `
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1,0)),u.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*vnoise(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
`;
export const GLSL_NOISE = NOISE_GLSL;

/** Night sky dome: nebula bands, stars and an ultimate tint. */
export function skyMaterial(): T.ShaderMaterial {
  return new T.ShaderMaterial({
    side: T.BackSide, depthWrite: false, fog: false,
    uniforms: { uTime: { value: 0 }, uTint: { value: new T.Color('#000000') }, uTintAmount: { value: 0 }, uDark: { value: 0 }, uRed: { value: 0 } },
    vertexShader: 'varying vec3 vDir;void main(){vDir=normalize(position);vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_Position=p.xyww;}',
    fragmentShader: `varying vec3 vDir;uniform float uTime;uniform vec3 uTint;uniform float uTintAmount;uniform float uDark;uniform float uRed;${NOISE_GLSL}
    void main(){vec3 d=normalize(vDir);float h=d.y;
      vec3 col=mix(vec3(.05,.045,.11),vec3(.012,.016,.04),smoothstep(-.05,.6,h));
      col+=vec3(.22,.12,.38)*exp(-abs(h-.06)*9.)*.3;
      vec2 uv=vec2(atan(d.x,d.z)*1.6,h*3.);
      float n=fbm(uv*1.4+vec2(uTime*.01,0.));float bd=(h-.32+sin(uv.x*.7)*.12)*3.2;float band=exp(-bd*bd);
      col+=mix(vec3(.18,.08,.32),vec3(.05,.12,.3),fbm(uv*2.3-3.))*smoothstep(.35,.85,n)*band*.55;
      col+=vec3(.5,.28,.2)*smoothstep(.55,.95,fbm(uv*3.1+7.))*band*.18;
      vec2 sp=uv*58.;vec2 cell=floor(sp);float star=h21(cell);vec2 f=fract(sp)-.5;
      float tw=.6+.4*sin(uTime*(1.+star*3.)+star*40.);
      col+=vec3(.85,.85,1.)*step(.985,star)*smoothstep(.12,0.,length(f))*tw*smoothstep(-.05,.15,h);
      col=mix(col,col*.4+uTint*(.003+.05*smoothstep(.3,.85,h)*fbm(uv*2.+uTime*.05)),uTintAmount);
      col*=1.-uDark*.7;col=mix(col,vec3(.55,.03,.07)*(.55+.6*fbm(uv*1.7+uTime*.04))*(.7+.5*smoothstep(-.1,.5,h)),uRed);gl_FragColor=vec4(col,1.);}`,
  });
}

/** The original rune floor, rebuilt with glyph ticks, a pulse and ultimate charge. */
export function runeFloorMaterial(): T.ShaderMaterial {
  return new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color('#7b63e6') }, uPower: { value: 0 }, uPulse: { value: -1 } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;uniform float uTime;uniform vec3 uColor;uniform float uPower;uniform float uPulse;${NOISE_GLSL}
    void main(){vec2 p=(vUv-.5)*2.;float r=length(p);float a=atan(p.y,p.x);
      float ring=exp(-abs(r-.9)*320.)+exp(-abs(r-.84)*260.)*.35+exp(-abs(r-.6)*220.)*.25+exp(-abs(r-.3)*260.)*.18;
      float ticks=step(.93,cos(a*72.))*smoothstep(.85,.86,r)*(1.-smoothstep(.885,.89,r));
      float glyph=step(.55,h21(vec2(floor(a*18./3.14159),3.)))*step(.5,h21(floor(vec2(a*120.,r*80.))))*smoothstep(.6,.62,r)*(1.-smoothstep(.82,.84,r))*.35;
      float spokes=pow(max(0.,cos(a*4.)),400.)*smoothstep(.3,.32,r)*(1.-smoothstep(.6,.62,r));
      float lines=pow(max(0.,cos(p.x*24.)),60.)+pow(max(0.,cos(p.y*24.)),60.);
      float wave=exp(-abs(r-fract(uTime*.11)*1.2)*60.)*.15;
      float pulse=uPulse>=0.?exp(-abs(r-uPulse*1.4)*24.)*(1.-uPulse):0.;
      float shimmer=.75+.25*fbm(p*4.+uTime*.2);
      float alpha=(ring*.6+ticks*.6+glyph+spokes*.25+lines*.035+wave+pulse*1.4)*shimmer*smoothstep(1.,.93,r);
      gl_FragColor=vec4(uColor*(1.+uPower*2.5)*alpha,1.);}`,
  });
}

/** Animated eclipse corona behind the moon gate. */
export function coronaMaterial(): T.ShaderMaterial {
  return new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color('#c7a6ff') }, uIntensity: { value: 1 } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;uniform float uTime;uniform vec3 uColor;uniform float uIntensity;${NOISE_GLSL}
    void main(){vec2 p=(vUv-.5)*2.;float r=length(p);float a=atan(p.y,p.x);
      float rays=fbm(vec2(a*3.,r*2.-uTime*.15))*.8+fbm(vec2(a*9.,uTime*.08))*.4;
      float halo=exp(-max(0.,r-.47)*(6.-rays*3.))*smoothstep(.45,.475,r);
      float rim=exp(-abs(r-.475)*120.);
      gl_FragColor=vec4(uColor*(halo*.55+rim*1.6)*uIntensity,1.);}`,
  });
}

/** Volumetric-looking light shaft: soft cone, scrolling dust, fades at the ends. */
export function shaftMaterial(color: T.ColorRepresentation, opacity = .5): T.ShaderMaterial {
  return new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color(color) }, uOpacity: { value: opacity } },
    vertexShader: 'varying vec2 vUv;varying vec3 vN;varying vec3 vV;void main(){vUv=uv;vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
    fragmentShader: `varying vec2 vUv;varying vec3 vN;varying vec3 vV;uniform float uTime;uniform vec3 uColor;uniform float uOpacity;${NOISE_GLSL}
    void main(){float facing=pow(min(1.,abs(dot(vN,vV))),1.5);float ends=smoothstep(0.,.25,vUv.y)*smoothstep(1.,.55,vUv.y);
      float dust=.65+.35*fbm(vec2(vUv.x*8.,vUv.y*3.-uTime*.4));
      gl_FragColor=vec4(uColor*facing*ends*dust*uOpacity,1.);}`,
  });
}

/** Expanding ring wave on the ground or facing the camera. */
export function ringMaterial(color: T.ColorRepresentation): T.ShaderMaterial {
  return new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
    uniforms: { uProgress: { value: 0 }, uColor: { value: new T.Color(color) }, uOpacity: { value: 1 }, uWidth: { value: .08 } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;uniform float uProgress;uniform vec3 uColor;uniform float uOpacity;uniform float uWidth;${NOISE_GLSL}
    void main(){vec2 p=(vUv-.5)*2.;float r=length(p);float a=atan(p.y,p.x);float edge=uProgress;
      float n=fbm(vec2(a*4.,uProgress*3.))*.08;float d=r-edge+n*uProgress;
      float ring=exp(-d*d/(uWidth*uWidth))*(1.-smoothstep(.98,1.,r));float inner=smoothstep(edge,0.,r)*.12*(1.-uProgress);
      gl_FragColor=vec4(uColor*(ring+inner)*uOpacity*(1.-uProgress*.6),1.);}`,
  });
}

/** Energy beam / pillar with scrolling fbm and fresnel edges. */
export function beamMaterial(color: T.ColorRepresentation): T.ShaderMaterial {
  return new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color(color) }, uOpacity: { value: 1 } },
    vertexShader: 'varying vec2 vUv;varying vec3 vN;varying vec3 vV;void main(){vUv=uv;vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
    fragmentShader: `varying vec2 vUv;varying vec3 vN;varying vec3 vV;uniform float uTime;uniform vec3 uColor;uniform float uOpacity;${NOISE_GLSL}
    void main(){float f=min(1.,abs(dot(vN,vV)));float core=pow(f,2.5);float n=fbm(vec2(vUv.x*6.,vUv.y*4.-uTime*3.));
      float ends=smoothstep(0.,.08,vUv.y)*smoothstep(1.,.8,vUv.y);
      vec3 c=mix(uColor,vec3(1.),core*.8)*(core*1.6+n*.6)*ends;gl_FragColor=vec4(c*uOpacity,1.);}`,
  });
}

/** Fresnel shell with a hex lattice: wards, barriers and the supernova front. */
export function shellMaterial(color: T.ColorRepresentation, hex = true): T.ShaderMaterial {
  return new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color(color) }, uOpacity: { value: 1 }, uHex: { value: hex ? 1 : 0 }, uCrack: { value: 0 } },
    vertexShader: 'varying vec2 vUv;varying vec3 vN;varying vec3 vV;void main(){vUv=uv;vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
    fragmentShader: `varying vec2 vUv;varying vec3 vN;varying vec3 vV;uniform float uTime;uniform vec3 uColor;uniform float uOpacity;uniform float uHex;uniform float uCrack;${NOISE_GLSL}
    void main(){float fr=pow(max(0.,1.-abs(dot(vN,vV))),2.2);vec2 g=vUv*vec2(24.,12.);g.x+=mod(floor(g.y),2.)*.5;vec2 f=abs(fract(g)-.5);
      float hexl=smoothstep(.42,.5,max(f.x*1.15+f.y*.6,f.y*1.2))*uHex;float sweep=exp(-abs(fract(vUv.y-uTime*.6)-.5)*12.);
      float cracks=uCrack*step(.62,fbm(vUv*14.))*1.5;
      gl_FragColor=vec4(uColor*(fr*1.4+hexl*(.35+sweep*.6)+cracks)*uOpacity,1.);}`,
  });
}

/** Painterly flame billboard used by braziers. */
export function flameMaterial(color: T.ColorRepresentation): T.ShaderMaterial {
  return new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color(color) }, uSeed: { value: 0 } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;uniform float uTime;uniform vec3 uColor;uniform float uSeed;${NOISE_GLSL}
    void main(){vec2 p=vUv;float n=fbm(vec2(p.x*3.+uSeed,p.y*2.5-uTime*2.2));float w=(.32-p.y*.24)*(.7+n*.6);
      float body=smoothstep(w,w-.12,abs(p.x-.5+(n-.5)*.18*p.y))*smoothstep(1.,.25,p.y+n*.25)*smoothstep(0.,.08,p.y);
      vec3 c=mix(uColor,vec3(1.,.95,.8),smoothstep(.3,.9,body*(1.-p.y)));gl_FragColor=vec4(c*body*1.6,1.);}`,
  });
}

/** Ground fog sheet. */
export function mistMaterial(): T.ShaderMaterial {
  return new T.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color('#2b2650') }, uOpacity: { value: .55 } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;uniform float uTime;uniform vec3 uColor;uniform float uOpacity;${NOISE_GLSL}
    void main(){vec2 p=vUv*vec2(3.,1.5);float n=fbm(p+vec2(uTime*.03,uTime*.01))*fbm(p*1.7-vec2(uTime*.02,0.));
      float edge=smoothstep(0.,.3,vUv.x)*smoothstep(1.,.7,vUv.x)*smoothstep(0.,.35,vUv.y)*smoothstep(1.,.6,vUv.y);
      gl_FragColor=vec4(uColor,n*edge*uOpacity);}`,
  });
}

/** GPU particles: every position is a closed-form function of age, so scrubbing is exact. */
export class Particles {
  readonly points: T.Points;
  readonly material: T.ShaderMaterial;
  constructor(count: number, map: T.Texture, seed = 1) {
    const geometry = new T.BufferGeometry(), seeds = new Float32Array(count * 4), positions = new Float32Array(count * 3);
    for (let i = 0; i < count * 4; i++) seeds[i] = hash(i * 1.37 + seed * 91.7);
    geometry.setAttribute('position', new T.BufferAttribute(positions, 3)); geometry.setAttribute('aSeed', new T.BufferAttribute(seeds, 4));
    this.material = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false,
      uniforms: {
        uMap: { value: map }, uAge: { value: 0 }, uLife: { value: 1 }, uMode: { value: 0 }, uOrigin: { value: new T.Vector3() }, uDir: { value: new T.Vector3(0, 1, 0) },
        uSpread: { value: 1 }, uSpeed: { value: 4 }, uGravity: { value: -6 }, uSize: { value: 18 }, uColorA: { value: new T.Color('#fff') }, uColorB: { value: new T.Color('#fa0') },
        uRadius: { value: 1 }, uOpacity: { value: 1 }, uScale: { value: 600 }, uMax: { value: 40 },
      },
      vertexShader: `attribute vec4 aSeed;uniform float uAge;uniform float uLife;uniform int uMode;uniform vec3 uOrigin;uniform vec3 uDir;uniform float uSpread;uniform float uSpeed;uniform float uGravity;uniform float uSize;uniform float uRadius;uniform float uScale;uniform float uMax;varying float vFade;varying float vMix;
      void main(){float life=uLife*(.45+.55*aSeed.w);float t=uMode==4?mod(uAge+aSeed.z*uLife*3.,life):uAge-aSeed.z*uLife*(uMode==0?0.:.9);float k=clamp(t/life,0.,1.);vFade=(t<0.||t>life)?0.:(1.-k)*smoothstep(0.,.05,k+.02);vMix=aSeed.x;
        vec3 rnd=normalize(vec3(aSeed.x,aSeed.y,fract(aSeed.x*7.3+aSeed.w))*2.-1.+.0001);vec3 p;
        if(uMode==0){vec3 d=normalize(mix(uDir,rnd,uSpread));float drag=1.-exp(-t*3.);p=uOrigin+d*uSpeed*(.35+.65*aSeed.y)*drag/3.+vec3(0.,uGravity*.5*t*t,0.);}
        else if(uMode==1){float a=aSeed.x*6.2832+uAge*(1.5+aSeed.y*2.)+k*6.;float r=uRadius*(1.-k)*(.4+.6*aSeed.y);p=uOrigin+vec3(cos(a)*r,(aSeed.w-.5)*r*.35,sin(a)*r);vFade*=smoothstep(0.,.3,k)+.2;}
        else if(uMode==2){float a=aSeed.x*6.2832+t*1.5;float r=uRadius*(.2+aSeed.y*.8);p=uOrigin+vec3(cos(a)*r,t*uSpeed*(.5+aSeed.w*.5),sin(a)*r);}
        else if(uMode==4){float a=aSeed.x*6.2832;float r=uRadius*sqrt(aSeed.y);p=uOrigin+vec3(cos(a)*r+sin(t*.7+aSeed.w*9.)*.3,k*uSpeed,sin(a)*r*.6);vFade=sin(k*3.14159);}
        else {float a=aSeed.x*6.2832;float r=uRadius*sqrt(aSeed.y);p=uOrigin+vec3(cos(a)*r,(1.-k)*uSpeed+sin(t*3.+aSeed.x*9.)*.15,sin(a)*r);}
        vec4 mv=modelViewMatrix*vec4(p,1.);float z=-mv.z;gl_PointSize=min(uMax,uSize*.01*(.5+aSeed.w)*uScale/max(.5,z)*(.4+.6*vFade));if(z<1.2)vFade*=smoothstep(.4,1.2,z);gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `uniform sampler2D uMap;uniform vec3 uColorA;uniform vec3 uColorB;uniform float uOpacity;varying float vFade;varying float vMix;
      void main(){vec4 t=texture2D(uMap,gl_PointCoord);if(vFade<=0.)discard;vec3 c=mix(uColorA,uColorB,vMix);gl_FragColor=vec4(c*t.a*vFade*uOpacity*1.6,1.);}`,
    });
    this.points = new T.Points(geometry, this.material); this.points.frustumCulled = false; this.points.visible = false;
  }
  /** mode 0 burst, 1 vortex inflow, 2 rising spiral, 3 falling column, 4 looping ambient drift. */
  set(mode: number, origin: T.Vector3Like, age: number, options: { life?: number; speed?: number; gravity?: number; spread?: number; size?: number; radius?: number; dir?: T.Vector3Like; a?: T.ColorRepresentation; b?: T.ColorRepresentation; opacity?: number } = {}): void {
    const u = this.material.uniforms;
    this.points.visible = true; u['uMode'].value = mode; (u['uOrigin'].value as T.Vector3).copy(origin); u['uAge'].value = age;
    u['uLife'].value = options.life ?? 1; u['uSpeed'].value = options.speed ?? 4; u['uGravity'].value = options.gravity ?? -6; u['uSpread'].value = options.spread ?? 1;
    u['uSize'].value = options.size ?? 18; u['uRadius'].value = options.radius ?? 1; u['uOpacity'].value = options.opacity ?? 1;
    (u['uDir'].value as T.Vector3).copy(options.dir ?? { x: 0, y: 1, z: 0 });
    (u['uColorA'].value as T.Color).set(options.a ?? '#ffffff'); (u['uColorB'].value as T.Color).set(options.b ?? options.a ?? '#ffffff');
  }
  /** Pixels per world unit at distance 1, so point sizes are in world units. */
  setScale(height: number, fov: number): void { this.material.uniforms['uScale'].value = height / (2 * Math.tan(fov * Math.PI / 360)); this.material.uniforms['uMax'].value = height * .045; }
}

export { hash };

/**
 * Velocity-stretched sparks: camera-facing ribbons from each spark's position a moment
 * ago to now, so fast embers read as streaks. Closed-form in time like Particles.
 */
export class Streaks {
  readonly mesh: T.Mesh;
  readonly material: T.ShaderMaterial;
  constructor(count: number, seed = 1) {
    const quad = new T.PlaneGeometry(1, 1), geometry = new T.InstancedBufferGeometry(), seeds = new Float32Array(count * 4);
    geometry.index = quad.index; geometry.setAttribute('position', quad.attributes['position']); geometry.setAttribute('uv', quad.attributes['uv']);
    for (let i = 0; i < count * 4; i++) seeds[i] = hash(i * 2.13 + seed * 57.3);
    geometry.setAttribute('aSeed', new T.InstancedBufferAttribute(seeds, 4)); geometry.instanceCount = count;
    this.material = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
      uniforms: {
        uAge: { value: 0 }, uLife: { value: 1 }, uOrigin: { value: new T.Vector3() }, uDir: { value: new T.Vector3(0, 1, 0) }, uSpread: { value: 1 }, uSpeed: { value: 8 },
        uGravity: { value: -8 }, uWidth: { value: .025 }, uTrail: { value: .05 }, uColorA: { value: new T.Color('#fff') }, uColorB: { value: new T.Color('#fa0') }, uOpacity: { value: 1 },
      },
      vertexShader: `attribute vec4 aSeed;uniform float uAge;uniform float uLife;uniform vec3 uOrigin;uniform vec3 uDir;uniform float uSpread;uniform float uSpeed;uniform float uGravity;uniform float uWidth;uniform float uTrail;
        varying vec2 vUv;varying float vFade;varying float vMix;
        vec3 at(float t,vec3 d,float speed){return uOrigin+d*speed*(1.-exp(-t*2.6))/2.6+vec3(0.,uGravity*.5*t*t,0.);}
        void main(){vec3 rnd=normalize(vec3(aSeed.x,aSeed.y,fract(aSeed.x*7.3+aSeed.w))*2.-1.+.0001);vec3 d=normalize(mix(uDir,rnd,uSpread));
          float speed=uSpeed*(.3+.7*aSeed.y),life=uLife*(.35+.65*aSeed.w),t=max(uAge,0.),k=clamp(t/life,0.,1.);
          vFade=(uAge<0.||t>life)?0.:pow(1.-k,1.3);vMix=aSeed.z;vUv=uv;
          vec4 head=modelViewMatrix*vec4(at(t,d,speed),1.),tail=modelViewMatrix*vec4(at(max(0.,t-uTrail*(.6+aSeed.x)),d,speed),1.);
          vec3 axis=head.xyz-tail.xyz;vec3 side=normalize(cross(axis+vec3(0.,1e-5,0.),head.xyz))*uWidth*(.5+aSeed.w)*(.4+.6*vFade);
          vec3 p=mix(tail.xyz,head.xyz,position.x+.5)+side*position.y*2.;gl_Position=projectionMatrix*vec4(p,1.);}`,
      fragmentShader: `uniform vec3 uColorA;uniform vec3 uColorB;uniform float uOpacity;varying vec2 vUv;varying float vFade;varying float vMix;
        void main(){if(vFade<=0.)discard;float across=1.-abs(vUv.y-.5)*2.;float along=vUv.x;float a=across*across*(.25+.75*along)*vFade;
          vec3 c=mix(uColorB,uColorA,along*.7+vMix*.3);gl_FragColor=vec4(c*a*uOpacity*2.,1.);}`,
    });
    this.mesh = new T.Mesh(geometry, this.material); this.mesh.frustumCulled = false; this.mesh.visible = false;
  }
  set(origin: T.Vector3Like, age: number, options: { life?: number; speed?: number; gravity?: number; spread?: number; width?: number; trail?: number; dir?: T.Vector3Like; a?: T.ColorRepresentation; b?: T.ColorRepresentation; opacity?: number } = {}): void {
    const u = this.material.uniforms; this.mesh.visible = age >= 0;
    (u['uOrigin'].value as T.Vector3).copy(origin); u['uAge'].value = age; u['uLife'].value = options.life ?? .6; u['uSpeed'].value = options.speed ?? 8;
    u['uGravity'].value = options.gravity ?? -8; u['uSpread'].value = options.spread ?? 1; u['uWidth'].value = options.width ?? .02; u['uTrail'].value = options.trail ?? .05;
    u['uOpacity'].value = options.opacity ?? 1; (u['uDir'].value as T.Vector3).copy(options.dir ?? { x: 0, y: 1, z: 0 });
    (u['uColorA'].value as T.Color).set(options.a ?? '#ffffff'); (u['uColorB'].value as T.Color).set(options.b ?? options.a ?? '#ffffff');
  }
}
