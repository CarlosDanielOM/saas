import * as T from 'three';
import { hash } from './duel-claude-3d-assets';

/**
 * What the finishers leave of the victim, built from a frozen snapshot of their model:
 * - Blood Moon: the body splits along the main cut, then falls apart along the drawn slash
 *   lines, seams glowing red-hot. The cuts live in the shaders (no clipping-plane variants),
 *   so every program can be compiled ahead of time.
 * - Divine Judgment / Black Hole: the body dissolves into points that rise as golden ash or
 *   spiral into the singularity.
 * Everything is a pure function of the ultimate's clock, so scrubbing lands on the same frame.
 */
export const SLASHES = 15, FRACTURE_PLANES = 5, MAX_PIECES = 1 << FRACTURE_PLANES;

/** A slash's center (relative to the victim's feet) and orientation; the drawn cut lies in its local XZ plane... */
export function slashTransform(i: number): { position: T.Vector3; rotation: T.Euler } {
  return {
    position: new T.Vector3((hash(i) - .5) * .5, .7 + hash(i * 3) * 1.4, .35 + (hash(i * 5) - .5) * .4),
    rotation: new T.Euler((hash(i * 7) - .5) * .5, (hash(i * 9) - .5) * .8, hash(i * 11) * Math.PI),
  };
}

/** ...so the plane it cuts through the body contains the slash line and the slash's facing. */
export function slashPlane(i: number, offset: T.Vector3): T.Plane {
  const { position, rotation } = slashTransform(i);
  return new T.Plane().setFromNormalAndCoplanarPoint(new T.Vector3(0, 1, 0).applyEuler(rotation), position.add(offset));
}

export interface Fracture { pieces: number; centers: T.Vector3[]; center: T.Vector3 }

/**
 * Split a snapshot into pieces by which side of each plane its triangles lie on. Vertices are
 * duplicated only where triangles of different pieces meet, so the geometry stays indexed and
 * small. Adds `aPiece` and `aEdge` (distance to the nearest cut, for the glowing seams).
 * Triangle order (and so every group range) is unchanged.
 */
export function fracture(geometry: T.BufferGeometry, planes: T.Plane[]): { geometry: T.BufferGeometry; fracture: Fracture } {
  const position = geometry.attributes['position'] as T.BufferAttribute, vertices = position.count;
  const index = geometry.index ? geometry.index.array as ArrayLike<number> : Uint32Array.from({ length: vertices }, (_, i) => i);
  const remap = new Map<number, number>(), source: number[] = [], pieceOfVertex: number[] = [], newIndex = new Uint32Array(index.length);
  const ids = new Map<number, number>(), sums: T.Vector3[] = [], weights: number[] = [];
  const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), centroid = new T.Vector3();
  const center = new T.Box3().setFromBufferAttribute(position).getCenter(new T.Vector3());
  for (let t = 0; t < index.length; t += 3) {
    a.fromBufferAttribute(position, index[t]); b.fromBufferAttribute(position, index[t + 1]); c.fromBufferAttribute(position, index[t + 2]);
    centroid.copy(a).add(b).add(c).divideScalar(3);
    let bits = 0; for (let i = 0; i < planes.length; i++) if (planes[i].distanceToPoint(centroid) > 0) bits |= 1 << i;
    let id = ids.get(bits); if (id === undefined) { id = ids.size; ids.set(bits, id); sums.push(new T.Vector3()); weights.push(0); }
    sums[id].add(centroid); weights[id]++;
    for (let k = 0; k < 3; k++) {
      const v = index[t + k], key = v * MAX_PIECES + id;
      let n = remap.get(key); if (n === undefined) { n = source.length; remap.set(key, n); source.push(v); pieceOfVertex.push(id); }
      newIndex[t + k] = n;
    }
  }
  const out = new T.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes) as [string, T.BufferAttribute][]) {
    const size = attribute.itemSize, data = new Float32Array(source.length * size);
    source.forEach((v, n) => { for (let k = 0; k < size; k++) data[n * size + k] = attribute.getComponent(v, k); });
    out.setAttribute(name, new T.BufferAttribute(data, size));
  }
  const edge = new Float32Array(source.length), p = new T.Vector3();
  source.forEach((v, n) => { p.fromBufferAttribute(position, v); let d = Infinity; for (const plane of planes) d = Math.min(d, Math.abs(plane.distanceToPoint(p))); edge[n] = d; });
  out.setAttribute('aPiece', new T.BufferAttribute(Float32Array.from(pieceOfVertex), 1)); out.setAttribute('aEdge', new T.BufferAttribute(edge, 1));
  out.setIndex(new T.BufferAttribute(newIndex, 1));
  for (const group of geometry.groups) out.addGroup(group.start, group.count, group.materialIndex);
  const centers = sums.map((sum, i) => sum.divideScalar(weights[i]));
  return { geometry: out, fracture: { pieces: centers.length, centers, center } };
}

/** Closed-form flight of one piece, s seconds after it breaks loose (offset and spin). */
export function pieceMotion(i: number, center: T.Vector3, body: T.Vector3, s: number, floor: number, offset: T.Vector3, spin: T.Quaternion): void {
  if (s <= 0) { offset.set(0, 0, 0); spin.identity(); return; }
  const out = new T.Vector3(center.x - body.x, 0, center.z - body.z); if (out.lengthSq() < 1e-6) out.set(hash(i) - .5, 0, hash(i * 2) - .5);
  out.normalize().multiplyScalar(.9 + hash(i * 3) * 1.6);
  const drag = (1 - Math.exp(-s * 2.2)) / 2.2, up = .5 + hash(i * 5) * 1.6 + Math.max(0, center.y - body.y) * .6;
  offset.set(out.x * drag, up * s - 4.2 * s * s, out.z * drag);
  // Pieces settle on the floor instead of sinking through it.
  offset.y = Math.max(offset.y, floor - center.y);
  const axis = new T.Vector3(hash(i * 7) - .5, hash(i * 11) - .5, hash(i * 13) - .5).normalize();
  spin.setFromAxisAngle(axis, (2 + hash(i * 17) * 6) * (1 - Math.exp(-s * 1.8)) / 1.8);
}

/** Shared per-frame state of the shattering victim (both halves read it). */
export interface ShatterUniforms {
  uPieceOffset: T.IUniform<T.Vector3[]>; uPieceQuat: T.IUniform<T.Vector4[]>; uPieceCenter: T.IUniform<T.Vector3[]>; uSeam: T.IUniform<number>;
}

export function shatterUniforms(): ShatterUniforms {
  return {
    uPieceOffset: { value: Array.from({ length: MAX_PIECES }, () => new T.Vector3()) },
    uPieceQuat: { value: Array.from({ length: MAX_PIECES }, () => new T.Vector4(0, 0, 0, 1)) },
    uPieceCenter: { value: Array.from({ length: MAX_PIECES }, () => new T.Vector3()) },
    uSeam: { value: 0 },
  };
}

/**
 * One half of the split victim: keeps the side of its cut (a local-space plane) and carries
 * its pieces. Built-in materials stay as they are; the cut and pieces are injected.
 */
export function shatterMaterial(material: T.Material, cut: T.Vector4, shared: ShatterUniforms): void {
  const uniforms = { ...shared, uCut: { value: cut } };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `attribute float aPiece;attribute float aEdge;uniform vec3 uPieceOffset[${MAX_PIECES}];uniform vec4 uPieceQuat[${MAX_PIECES}];uniform vec3 uPieceCenter[${MAX_PIECES}];
varying vec3 vCutLocal;varying float vEdge;
vec3 pieceRotate(vec3 v){vec4 q=uPieceQuat[int(aPiece+.5)];return v+2.*cross(q.xyz,cross(q.xyz,v)+q.w*v);}
` + shader.vertexShader
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal=pieceRotate(objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCutLocal=position;vEdge=aEdge;{int pi=int(aPiece+.5);transformed=uPieceCenter[pi]+pieceRotate(transformed-uPieceCenter[pi])+uPieceOffset[pi];}');
    shader.fragmentShader = 'uniform vec4 uCut;uniform float uSeam;varying vec3 vCutLocal;varying float vEdge;\n' + shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nfloat cutSide=dot(uCut.xyz,vCutLocal)+uCut.w;if(cutSide<0.)discard;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance+=uSeam*vec3(1.,.1,.18)*smoothstep(.035,0.,min(vEdge,abs(cutSide)))*6.;');
  };
  material.customProgramCacheKey = () => 'duel-shatter';
  material.needsUpdate = true;
}

/** The victim as points: golden ash rising (knight) or matter spiralling into the singularity (mage). */
export class Dissolve {
  readonly points: T.Points;
  readonly material: T.ShaderMaterial;
  constructor(geometry: T.BufferGeometry, map: T.Texture | null, origin: T.Vector3, maxPoints = 7000) {
    const position = geometry.attributes['position'], uv = geometry.attributes['uv'], stride = Math.max(1, Math.ceil(position.count / maxPoints));
    const count = Math.ceil(position.count / stride), positions = new Float32Array(count * 3), uvs = new Float32Array(count * 2), seeds = new Float32Array(count * 4);
    const box = new T.Box3().setFromBufferAttribute(position as T.BufferAttribute), height = Math.max(.1, box.max.y - box.min.y);
    for (let n = 0, i = 0; i < position.count && n < count; i += stride, n++) {
      positions.set([position.getX(i), position.getY(i), position.getZ(i)], n * 3);
      if (uv) uvs.set([uv.getX(i), uv.getY(i)], n * 2);
      // x: start delay (top first), y-w: noise.
      seeds.set([1 - (position.getY(i) - box.min.y) / height, hash(n * 1.3), hash(n * 2.7), hash(n * 4.1)], n * 4);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(positions, 3)); g.setAttribute('uv', new T.BufferAttribute(uvs, 2)); g.setAttribute('aSeed', new T.BufferAttribute(seeds, 4));
    this.material = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false,
      uniforms: { uMap: { value: map }, uAge: { value: 0 }, uMode: { value: 0 }, uCenter: { value: new T.Vector3() }, uGlow: { value: new T.Color('#ffd27a') }, uScale: { value: 600 }, uOpacity: { value: 1 } },
      vertexShader: `attribute vec4 aSeed;uniform float uAge;uniform int uMode;uniform vec3 uCenter;uniform float uScale;varying vec2 vUv;varying float vK;varying float vFade;
        void main(){vUv=uv;float k=clamp((uAge-aSeed.x*.35)/(1.1+aSeed.y*.5),0.,1.);vK=k;vec3 p=position;
          if(uMode==0){float lift=k*k*(2.2+aSeed.z*2.);p+=vec3(sin(k*6.+aSeed.w*20.)*.25*k,lift,cos(k*5.+aSeed.y*17.)*.25*k);}
          else{vec3 d=p-uCenter;float a=k*k*(7.+aSeed.z*5.);float c=cos(a),s=sin(a);d.xz=mat2(c,-s,s,c)*d.xz;p=uCenter+d*(1.-k*k*k);}
          vFade=(1.-smoothstep(.55,1.,k))*smoothstep(0.,.04,uAge-aSeed.x*.35+.04);
          vec4 mv=modelViewMatrix*vec4(p,1.);gl_PointSize=min(24.,(.022+aSeed.w*.02)*uScale/max(.5,-mv.z)*(1.-k*.4));gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `uniform sampler2D uMap;uniform vec3 uGlow;uniform float uOpacity;varying vec2 vUv;varying float vK;varying float vFade;
        void main(){vec2 c=gl_PointCoord-.5;float r=dot(c,c)*4.;if(r>1.||vFade<=0.)discard;vec3 body=texture2D(uMap,vUv).rgb;
          vec3 col=mix(body*1.6+uGlow*.15,uGlow*1.8,smoothstep(.0,.45,vK));gl_FragColor=vec4(col*(1.-r)*vFade*uOpacity,1.);}`,
    });
    this.points = new T.Points(g, this.material); this.points.position.copy(origin); this.points.frustumCulled = false; this.points.visible = false;
  }
  dispose(): void { this.points.geometry.dispose(); this.material.dispose(); }
}
