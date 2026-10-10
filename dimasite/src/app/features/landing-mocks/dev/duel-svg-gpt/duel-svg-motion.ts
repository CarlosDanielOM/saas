import { COMBO_HEAL, DuelBattle, DuelCharacter, DuelSide, DuelTurn, otherSide, turnLength } from '../../../widgets/duel/duel-battle';

export const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
export const ease = (n: number) => { const p = clamp(n); return p * p * (3 - 2 * p); };
const out = (n: number) => 1 - Math.pow(1 - clamp(n), 3);
export const baseX = (side: DuelSide) => side === 'left' ? 275 : 685;
export interface VectorPose {
  x: number; y: number; rotation: number; sx: number; sy: number; opacity: number;
  body: number; arm: number; wrist: number; back: number; head: number; cloth: number; leg: number;
  guard: number; glow: number; split: number; action: string;
}
export interface VectorFrame {
  time: number; turn: DuelTurn | null; turnIndex: number; ultimate: DuelTurn | null;
  age: number; impact: number; charge: number; aftermath: number; phase: string;
  hp: Record<DuelSide, number>; heals: Record<DuelSide, number>; poses: Record<DuelSide, VectorPose>;
}

/** A pure timeline: no CSS clocks or remounts. Seeking reconstructs the exact same frame. */
export function vectorFrame(battle: DuelBattle, elapsed: number, started: boolean, reduced = false): VectorFrame {
  const time = started ? elapsed : 0, hp = { left: battle.maxHp ?? 100, right: battle.maxHp ?? 100 };
  const heals = { left: battle.healCharges ?? 5, right: battle.healCharges ?? 5 };
  let turnIndex = -1;
  for (let i = 0; i < battle.turns.length; i++) {
    const t = battle.turns[i];
    if (!started || t.at > time) break;
    turnIndex = i;
    if (t.move === 'heal') heals[t.attacker]--;
    if (t.hitAt > time) continue;
    if (t.move === 'heal') hp[t.attacker] = Math.min(battle.maxHp ?? 100, hp[t.attacker] + (t.heal ?? 0));
    else {
      const side = otherSide(t.attacker); hp[side] = Math.max(0, hp[side] - t.damage);
      if (t.comboHeal && time >= t.hitAt + COMBO_HEAL.delay) {
        hp[side] = Math.min(battle.maxHp ?? 100, hp[side] + t.comboHeal); heals[side]--;
      }
    }
  }
  const latest = battle.turns[turnIndex];
  const turn = latest && time < latest.at + turnLength(latest) ? latest : null;
  const last = battle.turns.at(-1);
  const phase = !started ? 'ready' : time < 1300 ? 'entrance' : time < 3400 ? 'countdown' : time < (last?.hitAt ?? 0) ? 'fight' : time < battle.duration ? 'knockout' : 'winner';
  const ultimate = latest?.move === 'ultimate' && time < battle.duration ? latest : null;
  const age = turn ? time - turn.at : 0;
  const impact = turn && time >= turn.hitAt ? clamp(1 - (time - turn.hitAt) / 500) : 0;
  const charge = ultimate ? clamp((time - ultimate.at) / (ultimate.hitAt - ultimate.at)) : 0;
  const aftermath = ultimate ? clamp((time - ultimate.hitAt) / 1300) : 0;
  const poses = {} as Record<DuelSide, VectorPose>;
  for (const side of ['left', 'right'] as const) {
    const dir = side === 'left' ? 1 : -1, character = battle.fighters[side];
    const p: VectorPose = { x: baseX(side), y: 435, rotation: 0, sx: 1, sy: 1, opacity: 1, body: 0, arm: 0, wrist: 0, back: 0, head: 0, cloth: 0, leg: 0, guard: 0, glow: 0, split: 0, action: 'idle' };
    if (!reduced) {
      p.body = started ? Math.sin(time / 850 + dir) * .8 : 0;
      p.cloth = started ? Math.sin(time / 700 + dir) * 2 : -2;
      if (phase === 'entrance') {
        const walk = ease(time / 1150); p.x -= dir * 220 * (1 - walk);
        p.leg = Math.sin(time / 75) * 12 * (1 - walk); p.body = Math.sin(time / 75) * 2 * (1 - walk);
      }
      if (turn && turn.attacker === side) attackPose(p, character, turn, time, dir);
      if (turn && turn.attacker !== side && turn.move !== 'heal') {
        if (turn.defended && time > turn.at + (turn.hitAt - turn.at) * .35 && time < turn.hitAt + 420) {
          p.guard = ease((time - turn.at) / 160) * (1 - ease((time - turn.hitAt - 130) / 350));
          p.back = character === 'knight' ? -45 * p.guard : -30 * p.guard;
          if (character === 'ronin' && turn.move !== 'special') p.x -= dir * 65 * p.guard;
          p.action = 'guard';
        }
        if (impact > 0 && turn.damage > 0 && turn.move !== 'ultimate') {
          const recoil = Math.sin(clamp((time - turn.hitAt) / 500) * Math.PI);
          p.x -= dir * recoil * (turn.move === 'normal' ? 22 : 45);
          p.body -= recoil * 12; p.head += recoil * 12; p.action = 'hit';
        }
      }
    }
    if (hp[side] === 0) {
      p.action = 'defeated';
      const final = battle.turns.find(t => t.hitAt <= time && t.move !== 'heal' && otherSide(t.attacker) === side && t === last);
      const death = ease((time - (final?.hitAt ?? time)) / 950);
      if (!reduced) {
        const killer = final?.move === 'ultimate' ? battle.fighters[final.attacker] : null;
        if (killer === 'knight') { p.opacity = 1 - death; p.y -= death * 30; p.glow = 1; }
        else if (killer === 'mage') { p.opacity = 1 - death; p.sx = 1 - death; p.sy = 1 + death * .7; p.rotation = dir * death * 160; p.y -= death * 110; }
        else if (killer === 'ronin') { p.split = death; p.opacity = 1 - ease((time - (final?.hitAt ?? time) - 450) / 650); }
        else { p.rotation = -dir * death * 78; p.y += death * 8; p.opacity = 1 - death * .4; }
      } else p.opacity = .3;
    } else if (phase === 'winner' && battle.winner === side) {
      p.action = 'victory'; p.arm = -70; p.head = -4;
      if (!reduced) p.x += dir * 85 * ease((time - (last?.hitAt ?? time)) / 1600);
    }
    poses[side] = p;
  }
  return { time, turn, turnIndex, ultimate, age, impact, charge, aftermath, phase, hp, heals, poses };
}

function attackPose(p: VectorPose, character: DuelCharacter, turn: DuelTurn, time: number, dir: number): void {
  const age = time - turn.at, windup = turn.hitAt - turn.at, hit = time - turn.hitAt;
  p.action = turn.move === 'heal' ? 'heal' : 'attack';
  if (turn.move === 'heal') {
    const prayer = Math.sin(clamp(age / 1500) * Math.PI); p.arm = -30 * prayer; p.back = -35 * prayer; p.head = 10 * prayer; p.glow = prayer;
    return;
  }
  if (turn.move === 'ultimate') {
    const q = ease(age / 900), finish = ease(hit / 600);
    if (character === 'knight') { p.arm = -100 * q * (1 - finish * .45); p.wrist = 15 * q; p.head = -8 * q; p.back = -20 * q; p.body = -4 * q; }
    if (character === 'mage') { p.arm = -25 * q; p.back = -70 * q; p.y -= Math.sin(clamp(age / 4000) * Math.PI) * 27; p.cloth = -10 * q; }
    if (character === 'ronin') {
      p.body = 9 * q; p.arm = 65 * q; p.wrist = -50 * q; p.head = 8 * q;
      if (age > 1150 && age < 2350) p.opacity = 1 - ease((age - 1150) / 150);
      if (age >= 2350) { p.x = baseX(otherSide(turn.attacker)) + dir * 105; p.opacity = ease((age - 2350) / 200); p.arm = 48; p.wrist = -30; p.body = 2; }
    }
    p.glow = Math.sin(clamp(age / windup) * Math.PI) * .7;
    return;
  }
  // Hold anticipation, strike through contact, then ease back to the stance.
  // The fast 90 ms blade sweep ends exactly at hitAt, including on a scrubbed frame.
  const prepare = ease(age / Math.max(1, windup - 90)), strike = ease((age - windup + 90) / 110);
  const recover = 1 - ease((hit - 110) / Math.max(1, turnLength(turn) - windup - 110));
  const weight = turn.move === 'normal' ? 1 : turn.move === 'heavy' ? 1.25 : 1.5;
  if (character === 'mage') {
    p.arm = (-20 * prepare + 55 * strike) * recover; p.back = -45 * prepare * recover;
    p.body = (-3 * prepare + 6 * strike) * recover; p.y -= turn.move === 'special' ? Math.sin(clamp(age / turnLength(turn)) * Math.PI) * 25 : 0;
  } else {
    const advance = out((age - windup + 160) / 160) * recover;
    p.x += dir * (-14 * prepare + 225 * advance) * (turn.move === 'special' && character === 'ronin' ? 1.2 : 1);
    p.arm = (-70 * prepare + 135 * strike) * recover; p.wrist = (15 * prepare - 30 * strike) * recover;
    p.body = (-7 * prepare + 20 * strike) * recover * weight; p.head = -p.body * .4;
    p.back = (-18 * prepare + 20 * strike) * recover; p.leg = 18 * advance;
    if (turn.move === 'special' && character === 'knight') p.y -= Math.sin(clamp(age / windup) * Math.PI) * 48 * (hit < 0 ? 1 : 0);
  }
  p.cloth = -16 * strike * recover;
}
