import type { DuelBattle, DuelCharacter, DuelSide, DuelTurn } from '../../../widgets/duel/duel-battle';
import { COMBO_HEAL, otherSide, turnLength } from '../../../widgets/duel/duel-battle';
import type { ArmJoint } from './duel-claude-3d-rig';

/**
 * Keyframed choreography. Every pose is a pure function of the battle clock, so pause,
 * scrub and replay always land on the same frame. Attack clips run on a phase p where
 * p = 1 is the exact contact frame (windup before, recovery after) and contact holds for
 * a short hit-stop so blows read with weight.
 */
export type V3 = [number, number, number];
type Ease = 'lin' | 'io' | 'out' | 'in' | 'snap' | 'back';
const EASE: Record<Ease, (x: number) => number> = {
  lin: x => x, io: x => x * x * (3 - 2 * x), out: x => 1 - (1 - x) ** 3, in: x => x ** 3,
  snap: x => 1 - (1 - x) ** 5, back: x => { const c = 1.9; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; },
};
type Joints = Partial<Record<ArmJoint, V3>>;
export interface Key extends Joints { p: number; e?: Ease; r?: V3; h?: V3; yaw?: number; tilt?: number; fR?: V3; fL?: V3; wind?: number; sheathed?: boolean; gourd?: boolean; hidden?: boolean }
export interface Pose {
  r: V3; h: V3; yaw: number; tilt: number; fR: V3; fL: V3; j: Record<ArmJoint, V3>; scale: V3;
  wind: number; sheathed: boolean; gourd: boolean; hidden: boolean; flash: number; flashColor: string; glow: number;
}
const JOINT_NAMES: ArmJoint[] = ['hp', 'sp', 'ch', 'nk', 'hd', 'sR', 'eR', 'wR', 'sL', 'eL', 'wL'];
const VEC_FIELDS = ['r', 'h', 'fR', 'fL'] as const;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (x: number) => EASE.io(clamp(x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: V3, b: V3, t: number): V3 => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

const STANCE: Record<DuelCharacter, Key> = {
  knight: { p: 0, h: [0, -.05, 0], hp: [0, .15, 0], sp: [.04, 0, 0], ch: [.06, -.15, 0], nk: [0, 0, 0], hd: [-.04, 0, 0], sR: [-.45, 0, -.25], eR: [-1.0, 0, 0], wR: [.55, 0, 0], sL: [-.7, 0, .2], eL: [-1.1, 0, 0], wL: [1.75, 0, 0], fR: [-.18, .08, -.26], fL: [.16, .08, .28] },
  ronin: { p: 0, h: [0, -.14, -.02], hp: [0, .35, 0], sp: [.1, 0, 0], ch: [.08, -.25, 0], nk: [0, 0, 0], hd: [-.08, .15, 0], sR: [-.5, 0, -.18], eR: [-.45, 0, 0], wR: [1.25, 0, 0], sL: [-.35, 0, .15], eL: [-1.3, 0, 0], wL: [0, 0, 0], fR: [-.2, .08, -.36], fL: [.18, .08, .36] },
  mage: { p: 0, h: [0, 0, 0], hp: [0, .1, 0], sp: [0, 0, 0], ch: [0, -.1, 0], nk: [0, 0, 0], hd: [0, .05, 0], sR: [-.3, 0, -.3], eR: [-1.25, 0, 0], wR: [0, 0, 0], sL: [-.2, 0, .25], eL: [-.7, 0, 0], wL: [0, 0, 0], fR: [-.14, .08, -.08], fL: [.14, .08, .12] },
};

// Attack clips: p 0 → 1 windup, p 1 = contact, p 1 → 2 recovery.
const CLIPS: Record<DuelCharacter, Record<'normal' | 'heavy' | 'special' | 'heal', Key[]>> = {
  knight: {
    normal: [
      { p: 0 },
      { p: .45, e: 'out', r: [-.12, 0, 0], h: [0, -.12, -.05], ch: [-.12, -.55, 0], sR: [-2.5, 0, -.45], eR: [-.7, 0, 0], wR: [.3, 0, 0], sL: [-.4, 0, .5], eL: [-.6, 0, 0], wL: [1, 0, 0] },
      { p: .82, e: 'in', r: [2.2, .06, 0], h: [0, -.06, 0], ch: [0, -.4, 0], sR: [-2.8, 0, -.4], eR: [-.4, 0, 0], wR: [.2, 0, 0], sL: [-.4, 0, .5], eL: [-.6, 0, 0], wL: [1, 0, 0], fR: [-.18, .2, -.12], fL: [.16, .08, .45] },
      { p: 1, e: 'snap', r: [2.85, 0, 0], h: [0, -.2, .08], hp: [0, .4, 0], ch: [.45, .5, 0], hd: [.15, 0, 0], sR: [-.8, 0, -.15], eR: [-.15, 0, 0], wR: [.7, 0, 0], sL: [.2, 0, .45], eL: [-.4, 0, 0], wL: [1, 0, 0], fR: [-.18, .08, -.52], fL: [.18, .08, .62] },
      { p: 1.3, r: [2.85, 0, 0], h: [0, -.24, .1], hp: [0, .5, 0], ch: [.55, .65, 0], hd: [.15, 0, 0], sR: [-.25, 0, -.25], eR: [-.1, 0, 0], wR: [.9, 0, 0], sL: [.2, 0, .45], eL: [-.4, 0, 0], wL: [1, 0, 0], fR: [-.18, .08, -.52], fL: [.18, .08, .62] },
      { p: 1.65, e: 'io', r: [1.0, .08, 0], h: [0, -.05, 0], fR: [-.18, .16, -.2], fL: [.16, .08, .3] },
      { p: 2, e: 'io' },
    ],
    heavy: [
      { p: 0 },
      { p: .5, e: 'out', r: [-.2, 0, 0], h: [0, -.2, 0], yaw: -.8, ch: [.1, -.5, 0], sR: [-.3, 0, -1.3], eR: [-.4, 0, 0], wR: [.2, 0, 0], sL: [-.5, 0, .6], eL: [-.8, 0, 0], fR: [-.2, .08, -.32], fL: [.18, .08, .34] },
      { p: .78, e: 'in', r: [1.7, .1, 0], h: [0, -.15, 0], yaw: 2.6, ch: [.1, -.2, 0], sR: [-.5, 0, -1.4], eR: [-.15, 0, 0], wR: [0, 0, 0], sL: [-.5, 0, .9], eL: [-.4, 0, 0] },
      { p: 1, e: 'snap', r: [2.75, 0, 0], h: [0, -.24, .05], yaw: 6.53, ch: [.25, .2, 0], sR: [-.6, 0, -1.35], eR: [-.1, 0, 0], wR: [0, 0, 0], sL: [-.4, 0, .9], eL: [-.4, 0, 0], fR: [-.24, .08, -.45], fL: [.22, .08, .5] },
      { p: 1.35, r: [2.75, 0, 0], h: [0, -.26, .05], yaw: 7.1, ch: [.25, .55, 0], sR: [-.9, 0, -.5], eR: [-.2, 0, 0], wR: [.3, 0, 0], sL: [-.4, 0, .9], eL: [-.4, 0, 0], fR: [-.24, .08, -.45], fL: [.22, .08, .5] },
      { p: 1.7, e: 'io', r: [1.0, .06, 0], yaw: 6.28 },
      { p: 2, e: 'io', yaw: 6.28 },
    ],
    special: [
      { p: 0 },
      { p: .3, e: 'out', h: [0, -.34, -.05], ch: [.35, -.2, 0], sR: [-.6, 0, -.4], eR: [-.4, 0, 0], wR: [1.2, 0, 0], sL: [-.3, 0, .4], fR: [-.18, .08, -.32], fL: [.16, .08, .32] },
      { p: .62, e: 'out', r: [1.7, 1.25, 0], h: [0, 0, 0], ch: [-.3, -.1, 0], hd: [-.2, 0, 0], sR: [-3.0, 0, -.2], eR: [-.6, 0, 0], wR: [0, 0, 0], sL: [-2.6, 0, .3], eL: [-.5, 0, 0], wL: [1, 0, 0], fR: [-.18, .45, -.25], fL: [.16, .62, .15], wind: .5 },
      { p: .86, e: 'in', r: [2.6, .7, 0], h: [0, 0, 0], ch: [-.2, 0, 0], sR: [-3.1, 0, -.2], eR: [-.4, 0, 0], wR: [0, 0, 0], sL: [-2.4, 0, .3], eL: [-.4, 0, 0], wL: [1, 0, 0], fR: [-.18, .3, -.2], fL: [.16, .35, .2], wind: .8 },
      { p: 1, e: 'snap', r: [2.9, 0, 0], h: [0, -.38, .1], ch: [.7, 0, 0], hd: [.2, 0, 0], sR: [-.7, 0, -.1], eR: [0, 0, 0], wR: [1.0, 0, 0], sL: [-.6, 0, .3], eL: [-.5, 0, 0], wL: [1, 0, 0], fR: [-.2, .08, -.45], fL: [.18, .08, .5], wind: .4 },
      { p: 1.4, r: [2.9, 0, 0], h: [0, -.36, .1], ch: [.65, 0, 0], hd: [.2, 0, 0], sR: [-.7, 0, -.1], eR: [0, 0, 0], wR: [1.0, 0, 0], sL: [-.6, 0, .3], eL: [-.5, 0, 0], wL: [1, 0, 0], fR: [-.2, .08, -.45], fL: [.18, .08, .5] },
      { p: 1.75, e: 'io', r: [.9, .35, 0], fR: [-.18, .2, -.2], fL: [.16, .16, .25] },
      { p: 2, e: 'io' },
    ],
    heal: [
      { p: 0 },
      { p: .35, e: 'io', h: [0, -.5, .05], hp: [0, .1, 0], ch: [.25, 0, 0], hd: [.45, 0, 0], sR: [-.5, 0, -.1], eR: [-.9, 0, 0], wR: [2.9, 0, 0], sL: [-1.2, 0, -.2], eL: [-1.6, 0, 0], wL: [1.6, 0, 0], fR: [-.18, .08, -.55], fL: [.16, .08, .35] },
      { p: .75, h: [0, -.5, .05], hp: [0, .1, 0], ch: [.2, 0, 0], hd: [.35, 0, 0], sR: [-.5, 0, -.1], eR: [-.9, 0, 0], wR: [2.9, 0, 0], sL: [-1.2, 0, -.2], eL: [-1.6, 0, 0], wL: [1.6, 0, 0], fR: [-.18, .08, -.55], fL: [.16, .08, .35] },
      { p: 1, e: 'out', h: [0, -.45, .05], hp: [0, .1, 0], ch: [-.1, 0, 0], hd: [-.4, 0, 0], sR: [-.5, 0, -.1], eR: [-.9, 0, 0], wR: [2.9, 0, 0], sL: [-2.5, 0, .4], eL: [-.2, 0, 0], wL: [1, 0, 0], fR: [-.18, .08, -.55], fL: [.16, .08, .35], wind: .6 },
      { p: 1.55, h: [0, -.42, .05], ch: [-.1, 0, 0], hd: [-.35, 0, 0], sR: [-.5, 0, -.1], eR: [-.9, 0, 0], wR: [2.9, 0, 0], sL: [-2.4, 0, .4], eL: [-.2, 0, 0], wL: [1, 0, 0], fR: [-.18, .08, -.55], fL: [.16, .08, .35], wind: .5 },
      { p: 2, e: 'io' },
    ],
  },
  ronin: {
    normal: [
      { p: 0 },
      { p: .4, e: 'out', r: [-.15, 0, 0], h: [0, -.24, -.05], ch: [.25, -.6, 0], sR: [-.2, 0, -.5], eR: [-.2, 0, 0], wR: [1.6, 0, 0] },
      { p: .85, e: 'in', r: [2.4, 0, 0], h: [0, -.3, 0], ch: [.3, -.55, 0], sR: [-.2, 0, -.5], eR: [-.2, 0, 0], wR: [1.6, 0, 0], fR: [-.2, .16, -.4], fL: [.18, .08, .5], wind: .6 },
      { p: 1, e: 'snap', r: [3.0, 0, 0], h: [0, -.25, .08], ch: [-.05, .55, 0], sR: [-2.3, 0, -.5], eR: [-.1, 0, 0], wR: [.4, 0, 0], sL: [-.6, 0, .6], eL: [-.4, 0, 0], fR: [-.2, .08, -.55], fL: [.18, .08, .6], wind: .3 },
      { p: 1.3, r: [3.0, 0, 0], h: [0, -.22, .08], ch: [-.1, .7, 0], sR: [-2.7, 0, -.6], eR: [-.1, 0, 0], wR: [.3, 0, 0], sL: [-.6, 0, .6], eL: [-.4, 0, 0], fR: [-.2, .08, -.55], fL: [.18, .08, .6] },
      { p: 1.7, e: 'io', r: [.8, .05, 0], fR: [-.2, .18, -.3] },
      { p: 2, e: 'io' },
    ],
    heavy: [
      { p: 0 },
      { p: .45, e: 'out', r: [-.1, 0, 0], h: [0, -.36, -.05], ch: [.4, -.45, 0], sR: [-.1, 0, -.3], eR: [-.1, 0, 0], wR: [1.9, 0, 0], fR: [-.22, .08, -.45], fL: [.2, .08, .4] },
      { p: .85, e: 'in', r: [2.2, .2, 0], h: [0, -.2, 0], yaw: -.6, ch: [.3, -.4, 0], sR: [-.3, 0, -.4], eR: [-.1, 0, 0], wR: [1.8, 0, 0], wind: .8 },
      { p: 1, e: 'snap', r: [2.9, .65, 0], h: [0, 0, 0], yaw: .8, ch: [-.3, .6, 0], hd: [-.2, 0, 0], sR: [-3.0, 0, -.3], eR: [0, 0, 0], wR: [.2, 0, 0], sL: [-.8, 0, .9], eL: [-.3, 0, 0], fR: [-.2, .3, -.2], fL: [.18, .48, .2], wind: 1 },
      { p: 1.35, r: [2.9, .3, 0], yaw: 1.2, ch: [-.2, .7, 0], sR: [-2.8, 0, -.5], eR: [0, 0, 0], wR: [.4, 0, 0], sL: [-.8, 0, .9], eL: [-.3, 0, 0], fR: [-.2, .2, -.2], fL: [.18, .25, .2], wind: .7 },
      { p: 1.7, e: 'io', r: [1, 0, 0], yaw: 0 },
      { p: 2, e: 'io' },
    ],
    special: [
      { p: 0 },
      { p: .35, e: 'out', h: [0, -.32, 0], ch: [.35, -.7, 0], hd: [0, .5, 0], sR: [-.35, 0, .4], eR: [-1.2, 0, 0], wR: [.4, 0, 0], sL: [-.2, 0, .1], eL: [-1.0, 0, 0], fR: [-.22, .08, -.5], fL: [.2, .08, .5] },
      { p: .82, h: [0, -.36, 0], ch: [.4, -.75, 0], hd: [0, .5, 0], sR: [-.35, 0, .45], eR: [-1.25, 0, 0], wR: [.4, 0, 0], sL: [-.2, 0, .1], eL: [-1.0, 0, 0], fR: [-.22, .08, -.5], fL: [.2, .08, .5], wind: .3 },
      { p: 1, e: 'snap', r: [5.6, 0, 0], h: [0, -.34, .1], ch: [.2, .75, 0], hd: [0, -.2, 0], sR: [-1.6, 0, -1.3], eR: [0, 0, 0], wR: [0, 0, 0], sL: [-.4, 0, .6], eL: [-.6, 0, 0], fR: [-.2, .08, -.6], fL: [.18, .08, .6], wind: 1.2 },
      { p: 1.5, r: [5.6, 0, 0], h: [0, -.3, .1], ch: [.15, .8, 0], hd: [0, -.2, 0], sR: [-1.5, 0, -1.35], eR: [0, 0, 0], wR: [0, 0, 0], sL: [-.4, 0, .6], eL: [-.6, 0, 0], fR: [-.2, .08, -.6], fL: [.18, .08, .6], wind: .5 },
      { p: 1.8, e: 'in', r: [.6, 0, 0] },
      { p: 2, e: 'io' },
    ],
    heal: [
      { p: 0 },
      { p: .3, e: 'io', gourd: true, sL: [-1.2, 0, .2], eL: [-1.9, 0, 0], wL: [0, 0, 0] },
      { p: .6, e: 'io', gourd: true, nk: [-.2, 0, 0], hd: [-.55, 0, 0], ch: [-.15, -.1, 0], sL: [-1.7, 0, .15], eL: [-2.2, 0, 0], wL: [.6, 0, 0], h: [0, -.06, 0] },
      { p: 1, gourd: true, nk: [-.2, 0, 0], hd: [-.5, 0, 0], ch: [-.15, -.1, 0], sL: [-1.7, 0, .15], eL: [-2.2, 0, 0], wL: [.6, 0, 0], h: [0, -.06, 0] },
      { p: 1.35, e: 'io', gourd: true, hd: [.05, 0, 0], sL: [-.8, 0, .3], eL: [-1.6, 0, 0] },
      { p: 1.6, gourd: false },
      { p: 2, e: 'io' },
    ],
  },
  mage: {
    normal: [
      { p: 0 },
      { p: .5, e: 'out', ch: [-.1, -.4, 0], sR: [-.6, 0, -.5], eR: [-1.6, 0, 0], wR: [.1, 0, 0], sL: [-1.2, 0, .4], eL: [-.8, 0, 0] },
      { p: .8, e: 'in', r: [.3, 0, 0], ch: [.15, .3, 0], sR: [-1.3, 0, -.25], eR: [-.6, 0, 0], wR: [-.3, 0, 0], sL: [-.7, 0, .6], eL: [-.4, 0, 0] },
      { p: 1, r: [.3, 0, 0], ch: [.2, .35, 0], sR: [-1.35, 0, -.2], eR: [-.6, 0, 0], wR: [-.4, 0, 0], sL: [-.6, 0, .6], eL: [-.4, 0, 0] },
      { p: 1.4, r: [.25, 0, 0], ch: [.15, .3, 0], sR: [-1.2, 0, -.2], eR: [-.7, 0, 0], wR: [-.3, 0, 0], sL: [-.6, 0, .6], eL: [-.4, 0, 0] },
      { p: 2, e: 'io' },
    ],
    heavy: [
      { p: 0 },
      { p: .55, e: 'out', r: [0, .15, 0], h: [0, .05, 0], ch: [-.15, -.2, 0], hd: [-.15, 0, 0], sR: [-2.6, 0, -.4], eR: [-.4, 0, 0], wR: [1.2, 0, 0], sL: [-2.0, 0, .5], eL: [-.4, 0, 0], wind: .4 },
      { p: .8, e: 'in', r: [.2, .1, 0], ch: [.2, .3, 0], sR: [-1.4, 0, -.3], eR: [-.4, 0, 0], wR: [-.2, 0, 0], sL: [-1.5, 0, .3], eL: [0, 0, 0] },
      { p: 1, r: [.2, .05, 0], ch: [.25, .3, 0], sR: [-1.4, 0, -.3], eR: [-.4, 0, 0], wR: [-.2, 0, 0], sL: [-1.5, 0, .3], eL: [0, 0, 0] },
      { p: 1.4, r: [.15, 0, 0], ch: [.15, .25, 0], sR: [-1.2, 0, -.3], eR: [-.5, 0, 0], wR: [-.1, 0, 0], sL: [-1.2, 0, .3], eL: [-.2, 0, 0] },
      { p: 2, e: 'io' },
    ],
    special: [
      { p: 0 },
      { p: .45, e: 'out', r: [0, .4, 0], ch: [-.25, 0, 0], hd: [-.35, 0, 0], sR: [-2.9, 0, -.25], eR: [-.2, 0, 0], wR: [1.5, 0, 0], sL: [-2.4, 0, .6], eL: [-.3, 0, 0], fR: [-.14, .2, -.1], fL: [.14, .14, .12], wind: .8 },
      { p: .8, r: [0, .5, 0], ch: [-.3, 0, 0], hd: [-.4, 0, 0], sR: [-3.0, 0, -.3], eR: [-.15, 0, 0], wR: [1.5, 0, 0], sL: [-2.5, 0, .7], eL: [-.3, 0, 0], fR: [-.14, .2, -.1], fL: [.14, .14, .12], wind: 1.1 },
      { p: 1, e: 'out', r: [0, .45, 0], ch: [.2, .1, 0], hd: [.1, 0, 0], sR: [-1.5, 0, -.2], eR: [-.2, 0, 0], wR: [.1, 0, 0], sL: [-1.2, 0, .6], eL: [-.3, 0, 0], fR: [-.14, .18, -.1], fL: [.14, .12, .12], wind: .9 },
      { p: 1.5, r: [0, .3, 0], ch: [.15, .1, 0], sR: [-1.4, 0, -.2], eR: [-.3, 0, 0], wR: [.1, 0, 0], sL: [-1.0, 0, .6], eL: [-.3, 0, 0], wind: .5 },
      { p: 2, e: 'io' },
    ],
    heal: [
      { p: 0 },
      { p: .5, e: 'io', r: [0, .35, 0], ch: [-.12, 0, 0], hd: [-.25, 0, 0], sR: [-.45, 0, -1.15], eR: [-.5, 0, 0], wR: [.9, 0, 0], sL: [-.4, 0, 1.2], eL: [-.4, 0, 0], fR: [-.14, .16, -.08], fL: [.14, .12, .12], wind: .5 },
      { p: 1.3, r: [0, .4, 0], ch: [-.15, 0, 0], hd: [-.3, 0, 0], sR: [-.45, 0, -1.15], eR: [-.5, 0, 0], wR: [.9, 0, 0], sL: [-.4, 0, 1.25], eL: [-.4, 0, 0], fR: [-.14, .16, -.08], fL: [.14, .12, .12], wind: .7 },
      { p: 2, e: 'io' },
    ],
  },
};

/** The three finishers. p = age / windup until contact, then 1 + (age - windup) / 1.9 s. */
const ULTIMATE: Record<DuelCharacter, Key[]> = {
  knight: [
    { p: 0 },
    { p: .12, e: 'io', h: [0, -.5, .05], ch: [.25, 0, 0], hd: [.45, 0, 0], sR: [-.5, 0, -.1], eR: [-.9, 0, 0], wR: [2.9, 0, 0], sL: [-1.2, 0, -.2], eL: [-1.6, 0, 0], wL: [1.6, 0, 0], fR: [-.18, .08, -.55], fL: [.16, .08, .35] },
    { p: .3, h: [0, -.5, .05], ch: [.2, 0, 0], hd: [.4, 0, 0], sR: [-.5, 0, -.1], eR: [-.9, 0, 0], wR: [2.9, 0, 0], sL: [-1.2, 0, -.2], eL: [-1.6, 0, 0], wL: [1.6, 0, 0], fR: [-.18, .08, -.55], fL: [.16, .08, .35], wind: .4 },
    { p: .45, e: 'out', h: [0, .02, 0], ch: [-.2, 0, 0], hd: [-.45, 0, 0], sR: [-3.05, 0, -.15], eR: [-.05, 0, 0], wR: [1.55, 0, 0], sL: [-.6, 0, .6], eL: [-.4, 0, 0], wL: [1.4, 0, 0], fR: [-.2, .08, -.3], fL: [.18, .08, .3], wind: 1 },
    { p: .82, h: [0, .02, 0], ch: [-.22, 0, 0], hd: [-.5, 0, 0], sR: [-3.08, 0, -.15], eR: [-.05, 0, 0], wR: [1.55, 0, 0], sL: [-.7, 0, .7], eL: [-.4, 0, 0], wL: [1.4, 0, 0], fR: [-.2, .08, -.3], fL: [.18, .08, .3], wind: 1.3 },
    { p: .94, e: 'in', h: [0, -.15, .05], ch: [.25, .3, 0], hd: [.1, 0, 0], sR: [-1.5, 0, -.1], eR: [0, 0, 0], wR: [1.5, 0, 0], sL: [-.5, 0, .5], eL: [-.4, 0, 0], wL: [1.4, 0, 0], fR: [-.2, .08, -.45], fL: [.18, .08, .45], wind: 1.2 },
    { p: 1, e: 'snap', h: [0, -.2, .08], ch: [.35, .35, 0], hd: [.1, 0, 0], sR: [-1.5, 0, -.1], eR: [0, 0, 0], wR: [1.5, 0, 0], sL: [-.4, 0, .5], eL: [-.4, 0, 0], wL: [1.4, 0, 0], fR: [-.2, .08, -.45], fL: [.18, .08, .45], wind: 1.5 },
    { p: 1.5, h: [0, -.16, .06], ch: [.3, .3, 0], sR: [-1.45, 0, -.1], eR: [0, 0, 0], wR: [1.5, 0, 0], sL: [-.4, 0, .5], eL: [-.4, 0, 0], wL: [1.4, 0, 0], fR: [-.2, .08, -.45], fL: [.18, .08, .45], wind: 1 },
  ],
  mage: [
    { p: 0 },
    { p: .15, e: 'out', r: [0, .5, 0], ch: [-.1, 0, 0], hd: [-.2, 0, 0], sR: [-2.9, 0, -.3], eR: [-.2, 0, 0], wR: [1.5, 0, 0], sL: [-1.6, 0, .3], eL: [-.1, 0, 0], fR: [-.14, .2, -.1], fL: [.14, .14, .12], wind: .6 },
    { p: .5, e: 'io', r: [0, .9, 0], ch: [-.2, .2, 0], hd: [-.1, 0, 0], sR: [-2.95, 0, -.35], eR: [-.15, 0, 0], wR: [1.5, 0, 0], sL: [-1.7, 0, .25], eL: [-.05, 0, 0], fR: [-.14, .25, -.1], fL: [.14, .18, .12], wind: 1.1 },
    { p: .86, e: 'io', r: [0, 1.0, 0], ch: [-.15, .25, 0], hd: [-.05, 0, 0], sR: [-2.6, 0, -.6], eR: [-.2, 0, 0], wR: [1.4, 0, 0], sL: [-1.5, 0, .1], eL: [-.3, 0, 0], fR: [-.14, .3, -.1], fL: [.14, .2, .12], wind: 1.4 },
    { p: 1, e: 'snap', r: [0, .9, 0], ch: [.25, 0, 0], hd: [.1, 0, 0], sR: [-1.9, 0, -1.0], eR: [-.1, 0, 0], wR: [1.2, 0, 0], sL: [-1.4, 0, 1.2], eL: [0, 0, 0], fR: [-.14, .25, -.1], fL: [.14, .18, .12], wind: 1.6 },
    { p: 1.6, e: 'io', r: [0, .4, 0], ch: [.1, 0, 0], sR: [-1.2, 0, -.8], eR: [-.4, 0, 0], wR: [.6, 0, 0], sL: [-.8, 0, .9], eL: [-.3, 0, 0], wind: .5 },
  ],
  ronin: [
    { p: 0 },
    { p: .18, e: 'io', sheathed: true, h: [0, -.32, 0], ch: [.3, -.5, 0], hd: [0, .4, 0], sR: [-.25, 0, .4], eR: [-1.25, 0, 0], wR: [.2, 0, 0], sL: [-.2, 0, .1], eL: [-1.0, 0, 0], fR: [-.22, .08, -.5], fL: [.2, .08, .5], wind: .4 },
    { p: .465, sheathed: true, h: [0, -.36, 0], ch: [.35, -.55, 0], hd: [0, .45, 0], sR: [-.25, 0, .42], eR: [-1.25, 0, 0], wR: [.2, 0, 0], sL: [-.2, 0, .1], eL: [-1.0, 0, 0], fR: [-.22, .08, -.5], fL: [.2, .08, .5], wind: .8 },
    { p: .47, hidden: true, r: [6.0, 0, 0], sheathed: false, h: [0, -.36, .1], ch: [.2, .7, 0], hd: [0, -.15, 0], sR: [-1.5, 0, -1.4], eR: [0, 0, 0], wR: [0, 0, 0], sL: [-.4, 0, .6], eL: [-.6, 0, 0], fR: [-.2, .08, -.6], fL: [.18, .08, .6], wind: 1.4 },
    { p: .786, hidden: true, r: [6.0, 0, 0], h: [0, -.36, .1], ch: [.2, .7, 0], hd: [0, -.15, 0], sR: [-1.5, 0, -1.4], eR: [0, 0, 0], wR: [0, 0, 0], sL: [-.4, 0, .6], eL: [-.6, 0, 0], fR: [-.2, .08, -.6], fL: [.18, .08, .6], wind: 1.4 },
    { p: .79, r: [6.0, 0, 0], h: [0, -.36, .1], ch: [.2, .7, 0], hd: [0, -.15, 0], sR: [-1.5, 0, -1.4], eR: [0, 0, 0], wR: [0, 0, 0], sL: [-.4, 0, .6], eL: [-.6, 0, 0], fR: [-.2, .08, -.6], fL: [.18, .08, .6], wind: 1.2 },
    { p: .86, e: 'io', r: [6.0, 0, 0], h: [0, -.3, .05], ch: [.2, .4, 0], hd: [.1, 0, 0], sR: [-1.2, 0, -.9], eR: [-.2, 0, 0], wR: [.2, 0, 0], sL: [-.3, 0, .4], eL: [-.9, 0, 0], fR: [-.2, .08, -.55], fL: [.18, .08, .55], wind: .8 },
    { p: .985, e: 'io', r: [6.0, 0, 0], h: [0, -.26, .05], ch: [.15, -.2, 0], hd: [.15, 0, 0], sR: [-.3, 0, .38], eR: [-1.2, 0, 0], wR: [.3, 0, 0], sL: [-.2, 0, .1], eL: [-1.0, 0, 0], fR: [-.2, .08, -.5], fL: [.18, .08, .5], wind: .6 },
    { p: 1, sheathed: true, r: [6.0, 0, 0], h: [0, -.24, .05], ch: [.15, -.2, 0], hd: [.2, 0, 0], sR: [-.25, 0, .4], eR: [-1.25, 0, 0], wR: [.2, 0, 0], sL: [-.2, 0, .1], eL: [-1.0, 0, 0], fR: [-.2, .08, -.5], fL: [.18, .08, .5], wind: 1.5 },
    { p: 1.6, e: 'io', sheathed: true, r: [6.0, 0, 0], h: [0, -.05, 0], ch: [.05, -.2, 0], hd: [.25, 0, 0], sR: [-.25, 0, .4], eR: [-1.25, 0, 0], wR: [.2, 0, 0], sL: [-.2, 0, .1], eL: [-1.0, 0, 0], wind: .6 },
  ],
};

const VICTORY: Record<DuelCharacter, Key> = {
  knight: { p: 0, h: [0, .02, 0], ch: [-.12, .25, 0], hd: [-.3, .1, 0], sR: [-2.95, 0, -.35], eR: [-.15, 0, 0], wR: [1.45, 0, 0], sL: [-.3, 0, .35], eL: [-.4, 0, 0], wL: [1.4, 0, 0], fR: [-.2, .08, -.18], fL: [.18, .08, .2], wind: .9 },
  mage: { p: 0, r: [0, .25, 0], ch: [-.08, .1, 0], hd: [-.2, 0, 0], sR: [-.3, 0, -.3], eR: [-1.25, 0, 0], wR: [0, 0, 0], sL: [-2.3, 0, .7], eL: [-.5, 0, 0], fR: [-.14, .14, -.08], fL: [.14, .1, .12], wind: .7 },
  ronin: { p: 0, sheathed: true, yaw: -.5, h: [0, 0, 0], ch: [.05, -.2, 0], hd: [.2, -.3, 0], sR: [-.25, 0, .4], eR: [-1.25, 0, 0], wR: [.2, 0, 0], sL: [-.2, 0, .1], eL: [-1.0, 0, 0], fR: [-.16, .08, -.12], fL: [.16, .08, .14], wind: .9 },
};

function emptyPose(stance: Key): Pose {
  return {
    r: [0, 0, 0], h: [...stance.h!], yaw: 0, tilt: 0, fR: [...stance.fR!], fL: [...stance.fL!], scale: [1, 1, 1],
    j: Object.fromEntries(JOINT_NAMES.map(name => [name, [...(stance[name] ?? [0, 0, 0])]])) as Record<ArmJoint, V3>,
    wind: 0, sheathed: false, gourd: false, hidden: false, flash: 0, flashColor: '#ffffff', glow: 1,
  };
}

/** Resolve a clip at phase p; joints a key omits fall back to the stance. */
function sample(clip: Key[], p: number, stance: Key, out: Pose): void {
  let i = 0; while (i < clip.length - 2 && clip[i + 1].p <= p) i++;
  const a = clip[i], b = clip[Math.min(i + 1, clip.length - 1)];
  const span = b.p - a.p, f = span > 0 ? EASE[b.e ?? 'io'](clamp((p - a.p) / span)) : 1;
  const zero: V3 = [0, 0, 0];
  for (const field of VEC_FIELDS) out[field] = mix3(a[field] ?? (field === 'r' ? zero : stance[field]!), b[field] ?? (field === 'r' ? zero : stance[field]!), f);
  for (const name of JOINT_NAMES) out.j[name] = mix3(a[name] ?? stance[name] ?? zero, b[name] ?? stance[name] ?? zero, f);
  out.yaw = mix(a.yaw ?? 0, b.yaw ?? 0, f); out.tilt = mix(a.tilt ?? 0, b.tilt ?? 0, f); out.wind = mix(a.wind ?? 0, b.wind ?? 0, f);
  const key = p >= b.p ? b : a; out.sheathed = key.sheathed ?? false; out.gourd = key.gourd ?? false; out.hidden = key.hidden ?? false;
}

function blend(target: Pose, other: Pose, w: number): void {
  if (w <= 0) return;
  for (const field of VEC_FIELDS) target[field] = mix3(target[field], other[field], w);
  for (const name of JOINT_NAMES) target.j[name] = mix3(target.j[name], other.j[name], w);
  target.yaw = mix(target.yaw, other.yaw, w); target.tilt = mix(target.tilt, other.tilt, w); target.wind = mix(target.wind, other.wind, w);
  if (w > .5) { target.sheathed = other.sheathed; target.gourd = other.gourd; }
}

export const HITSTOP = { normal: 70, heavy: 95, special: 120, heal: 0, ultimate: 160 } as const;

/** Attack phase with hit-stop: contact freezes for a few frames, then recovery resumes. */
export function attackPhase(turn: DuelTurn, time: number): number {
  const age = time - turn.at, windup = turn.hitAt - turn.at;
  if (turn.move === 'ultimate') return age < windup ? age / windup : 1 + (age - windup) / 1900;
  if (age < windup) return age / windup;
  const stop = turn.move === 'heal' ? 0 : HITSTOP[turn.move] * (turn.crit ? 1.5 : 1), length = turnLength(turn) - windup;
  return age - windup < stop ? 1 : 1 + clamp((age - windup - stop) / Math.max(1, length - stop));
}

export function activeTurn(battle: DuelBattle, time: number): DuelTurn | null {
  for (let i = battle.turns.length - 1; i >= 0; i--) { const turn = battle.turns[i]; if (turn.at <= time) return time < turn.at + (turn.move === 'ultimate' ? 5000 : turnLength(turn)) ? turn : null; }
  return null;
}

export interface MotionContext { battle: DuelBattle; time: number; started: boolean; world: number; health: Record<DuelSide, number> }

/** The full pose of one fighter at one instant. */
export function fighterPose(side: DuelSide, ctx: MotionContext): Pose {
  const { battle, time, started, world } = ctx, character = battle.fighters[side], stance = STANCE[character];
  const pose = emptyPose(stance), t = started ? time / 1000 : world, seed = side === 'left' ? 0 : 1.7;
  // Breathing, weight shift and idle weapon drift.
  const breathe = Math.sin(t * 2.1 + seed);
  pose.h[1] += breathe * .012; pose.j.ch[0] += breathe * .025; pose.j.hd[0] -= breathe * .02;
  pose.j.sR[0] += Math.sin(t * 1.3 + seed) * .03; pose.j.sL[0] += Math.sin(t * 1.1 + seed + 1) * .03;
  if (character === 'mage') pose.r[1] = .06 + Math.sin(t * 1.6 + seed) * .04;
  pose.wind = .1;
  if (!started) return pose;

  const last = battle.turns.at(-1)!, loser = otherSide(battle.winner), ended = time >= last.hitAt;
  if (time < 1300) {
    // Entrance: a confident walk in, feet planted by the IK.
    const p = smooth(time / 1150), stride = (1 - p) * Math.sin(time * .0105 + seed);
    pose.r[0] = -(1 - p) * 3.6; pose.fR[2] += stride * .32; pose.fL[2] -= stride * .32;
    pose.fR[1] += Math.max(0, stride) * .12; pose.fL[1] += Math.max(0, -stride) * .12; pose.h[1] += Math.abs(stride) * -.03;
    pose.j.sR[0] -= stride * .2; pose.j.sL[0] += stride * .2; pose.wind = .3 + (1 - p) * .4;
    return pose;
  }
  if (time < 3700) {
    // Countdown flourish: each class squares up in its own way.
    const p = clamp((time - 1500) / 1700), w = Math.sin(p * Math.PI);
    if (character === 'knight') { pose.j.sR[0] -= w * 2.1; pose.j.wR[0] += w * 1.0; pose.j.ch[1] -= w * .2; pose.j.hd[0] -= w * .2; }
    else if (character === 'mage') { pose.r[1] += w * .3; pose.j.sL[0] -= w * 1.6; pose.j.sL[2] += w * .4; pose.wind = w * .8; }
    else { pose.h[1] -= w * .12; pose.j.wR[0] += w * .5; pose.j.ch[1] -= w * .35; pose.j.hd[1] += w * .2; }
  }

  const turn = activeTurn(battle, time);
  if (turn) {
    const age = time - turn.at, hitAge = time - turn.hitAt;
    if (turn.attacker === side) {
      const clip = turn.move === 'ultimate' ? ULTIMATE[character] : CLIPS[character][turn.move];
      sample(clip, attackPhase(turn, time), stance, pose);
      if (turn.move === 'ultimate' && character === 'mage') pose.r[1] += Math.sin(t * 3) * .04;
    } else if (ended && side === loser) {
      // The knockout below owns the loser's final moments.
    } else if (turn.move === 'ultimate') {
      victimOfUltimate(pose, battle.fighters[turn.attacker], age / 1000, (turn.hitAt - turn.at) / 1000);
    } else if (turn.move !== 'heal') {
      react(pose, character, turn, age, hitAge);
    }
    if (turn.comboHeal && turn.attacker !== side && hitAge > COMBO_HEAL.delay - 100 && hitAge < COMBO_HEAL.delay + 500) {
      const w = Math.sin(clamp((hitAge - COMBO_HEAL.delay + 100) / 600) * Math.PI);
      pose.flash = Math.max(pose.flash, w * .5); pose.flashColor = '#7dffc4'; pose.j.hd[0] -= w * .2; pose.j.ch[0] -= w * .1;
    }
    if (turn.move === 'heal' && turn.attacker === side && hitAge > 0 && hitAge < 600) { pose.flash = Math.max(pose.flash, Math.sin(hitAge / 600 * Math.PI) * .45); pose.flashColor = '#7dffc4'; }
  }

  if (ended) {
    const hitAge = time - last.hitAt;
    if (side === loser) {
      if (last.move === 'ultimate') victimOfUltimate(pose, battle.fighters[last.attacker], (time - last.at) / 1000, (last.hitAt - last.at) / 1000);
      else { react(pose, character, last, time - last.at, hitAge); knockout(pose, character, hitAge); }
    } else {
      // The winner finishes the motion, then settles into a victory pose.
      const w = smooth((hitAge - (last.move === 'ultimate' ? 900 : 650)) / 800), victory = emptyPose(stance);
      sample([VICTORY[character], VICTORY[character]], 0, stance, victory);
      victory.r = [pose.r[0], VICTORY[character].r?.[1] ?? 0, pose.r[2]];
      if (character === 'mage') victory.r[1] += Math.sin(t * 1.6) * .05;
      victory.j.ch[0] += breathe * .02; victory.wind = (VICTORY[character].wind ?? 0) + Math.sin(t * .9) * .15;
      blend(pose, victory, w);
    }
  }
  return pose;
}

/** Hit reactions, blocks, dodges and barrier braces for the defender. */
function react(pose: Pose, character: DuelCharacter, turn: DuelTurn, age: number, hitAge: number): void {
  const defended = !!turn.defended, broke = defended && turn.move === 'special';
  const windup = turn.hitAt - turn.at;
  if (defended) {
    const guard = smooth((age - windup + 260) / 200) * (1 - smooth((hitAge - (broke ? 120 : 380)) / 260));
    if (character === 'knight') {
      const g: Joints = { sL: [-1.35, 0, .05], eL: [-1.2, 0, 0], wL: [2.5, 0, 0], ch: [-.05, .3, 0], hd: [.05, 0, 0] };
      for (const [name, value] of Object.entries(g) as [ArmJoint, V3][]) pose.j[name] = mix3(pose.j[name], value, guard);
      pose.h[1] -= guard * .12; if (hitAge > 0) pose.r[0] -= Math.sin(clamp(hitAge / 420) * Math.PI) * .3;
    } else if (character === 'ronin') {
      const sway = smooth((age - windup + 180) / 140) * (1 - smooth((hitAge - 300) / 300));
      if (!broke) { pose.r[0] -= sway * .75; pose.r[2] -= sway * .55; pose.j.ch = mix3(pose.j.ch, [-.35, -.1, -.3], sway); pose.h[1] -= sway * .14; pose.yaw -= sway * .4; }
      else { pose.j.wR = mix3(pose.j.wR, [.2, 0, 0], guard); pose.j.sR = mix3(pose.j.sR, [-1.6, 0, -.1], guard); }
    } else {
      pose.j.sR = mix3(pose.j.sR, [-1.2, 0, -.5], guard); pose.j.eR = mix3(pose.j.eR, [-.5, 0, 0], guard); pose.j.wR = mix3(pose.j.wR, [-.4, 0, 0], guard);
      pose.j.sL = mix3(pose.j.sL, [-1.4, 0, .3], guard); pose.j.eL = mix3(pose.j.eL, [-.2, 0, 0], guard); pose.h[1] -= guard * .06;
    }
    if (!broke) return;
  }
  if (hitAge < 0 || turn.damage <= 0) return;
  const strength = (turn.move === 'special' ? 1.5 : turn.move === 'heavy' ? 1.15 : .8) * (turn.crit ? 1.35 : 1);
  const stop = HITSTOP[turn.move as 'normal' | 'heavy' | 'special'] ?? 0, k = hitAge < stop ? 0 : hitAge - stop;
  const jolt = hitAge < stop ? 1 : Math.exp(-k / 180) * Math.cos(k / 95) * .5 + .5 * (1 - smooth(k / 650));
  const shove = smooth(hitAge / 120) * (1 - smooth((hitAge - 380) / 420));
  pose.r[0] -= shove * .5 * strength; pose.h[1] -= shove * .14;
  pose.j.ch = mix3(pose.j.ch, [-.45 * strength, .25, .12], jolt); pose.j.hd = mix3(pose.j.hd, [-.55 * strength, -.2, .25], jolt);
  pose.j.sR = mix3(pose.j.sR, [-.9, 0, -.8], jolt * .7); pose.j.sL = mix3(pose.j.sL, [-.7, 0, .9], jolt * .7);
  pose.fR[2] -= shove * .1; pose.flash = Math.max(0, 1 - hitAge / 110) * .8; pose.flashColor = turn.crit ? '#ffd27a' : '#ffffff'; pose.wind = shove * .8;
}

function knockout(pose: Pose, character: DuelCharacter, hitAge: number): void {
  if (hitAge < 0) return;
  const buckle = smooth((hitAge - 120) / 420), fall = EASE.in(clamp((hitAge - 420) / 520)), settle = smooth((hitAge - 940) / 260);
  pose.r[0] -= smooth(hitAge / 300) * .7;
  pose.h = mix3(pose.h, [0, -.4, -.05], buckle * (1 - fall));
  pose.j.ch = mix3(pose.j.ch, [.5, .2, .1], buckle); pose.j.hd = mix3(pose.j.hd, [.45, -.3, .2], buckle);
  pose.j.sR = mix3(pose.j.sR, [.15, 0, -.35], buckle); pose.j.eR = mix3(pose.j.eR, [-.3, 0, 0], buckle);
  pose.j.sL = mix3(pose.j.sL, [.1, 0, .35], buckle); pose.j.eL = mix3(pose.j.eL, [-.3, 0, 0], buckle);
  pose.tilt = fall * 1.5 + Math.sin(settle * Math.PI) * -.06; pose.r[1] = fall * .26 + (character === 'mage' ? 0 : 0);
  pose.fR = mix3(pose.fR, [-.2, .08, -.05], fall); pose.fL = mix3(pose.fL, [.2, .08, .12], fall);
  if (fall > 0) { pose.j.ch = mix3(pose.j.ch, [-.15, .1, 0], fall); pose.j.hd = mix3(pose.j.hd, [-.2, .5, 0], fall); pose.j.sR = mix3(pose.j.sR, [-.3, 0, -1.1], fall); pose.j.sL = mix3(pose.j.sL, [-.2, 0, 1.0], fall); pose.h = mix3(pose.h, [0, -.08, 0], fall); }
  pose.flash = Math.max(0, 1 - hitAge / 250); pose.glow = 1 - settle * .7; pose.wind = fall * .6;
}

/** How each finisher handles its victim before the shared HP reaches zero. */
function victimOfUltimate(pose: Pose, attacker: DuelCharacter, age: number, windup: number): void {
  if (attacker === 'knight') {
    const bind = smooth((age - 1.35) / .5);
    pose.r[1] += bind * .3; pose.j.sR = mix3(pose.j.sR, [-.35, 0, -1.25], bind); pose.j.sL = mix3(pose.j.sL, [-.35, 0, 1.25], bind);
    pose.j.eR = mix3(pose.j.eR, [-.2, 0, 0], bind); pose.j.eL = mix3(pose.j.eL, [-.2, 0, 0], bind);
    pose.j.ch = mix3(pose.j.ch, [-.3, 0, 0], bind); pose.j.hd = mix3(pose.j.hd, [-.5, 0, 0], bind);
    pose.fR = mix3(pose.fR, [-.16, .25, -.05], bind); pose.fL = mix3(pose.fL, [.16, .2, .05], bind);
    pose.flash = bind * .35 + Math.max(0, (age - windup + .4) / .4) * .65; pose.flashColor = '#ffe2a0';
    if (age > windup + .12) pose.hidden = true;
  } else if (attacker === 'mage') {
    const pull = EASE.in(clamp((age - 1.25) / (windup - 1.25)));
    pose.r[0] += pull * .2; pose.r[1] += pull * 2.1; pose.tilt = pull * pull * 5.5; pose.yaw += pull * 4;
    pose.scale = [1 - pull * .62, 1 + pull * 1.6, 1 - pull * .62];
    pose.j.sR = mix3(pose.j.sR, [-2.4, 0, -.9], smooth(pull * 3)); pose.j.sL = mix3(pose.j.sL, [-2.2, 0, .9], smooth(pull * 3));
    pose.fR = mix3(pose.fR, [-.2, .3, -.2], smooth(pull * 3)); pose.fL = mix3(pose.fL, [.2, .2, .1], smooth(pull * 3));
    pose.flash = pull * .4; pose.flashColor = '#c9a6ff'; pose.wind = 1.2 * smooth(pull * 4);
    if (age > windup - .06) pose.hidden = true;
  } else {
    // Time stops: the victim freezes mid-stagger while the cuts gather.
    const freeze = smooth((age - 1.25) / .25);
    pose.j.ch = mix3(pose.j.ch, [-.2, .3, .1], freeze); pose.j.hd = mix3(pose.j.hd, [-.15, .4, 0], freeze);
    pose.j.sR = mix3(pose.j.sR, [-.9, 0, -.6], freeze); pose.j.sL = mix3(pose.j.sL, [-.6, 0, .7], freeze); pose.r[0] -= freeze * .15;
    pose.wind = 0; pose.flash = freeze * .15; pose.flashColor = '#ff2d55';
    if (age >= windup) pose.hidden = true;
  }
}

/** Contact-frame poses used to bake the Blood Moon afterimages. */
export function strikePoses(character: DuelCharacter): Pose[] {
  const stance = STANCE[character], picks: ['normal' | 'heavy' | 'special', number][] = [['normal', 1], ['heavy', 1], ['special', 1], ['normal', 1.3], ['heavy', 1.35], ['special', 1.5]];
  return picks.map(([move, p]) => { const pose = emptyPose(stance); sample(CLIPS[character][move], p, stance, pose); pose.r = [0, pose.r[1] * .3, 0]; pose.yaw = 0; pose.wind = 1; return pose; });
}

/** Finisher poses at chosen phases, for baking the Divine Judgment avatar. */
export function ultimatePoses(character: DuelCharacter, phases: number[]): Pose[] {
  const stance = STANCE[character];
  return phases.map(p => { const pose = emptyPose(stance); sample(ULTIMATE[character], p, stance, pose); pose.r = [0, 0, 0]; pose.yaw = 0; pose.wind = 1.4; return pose; });
}
