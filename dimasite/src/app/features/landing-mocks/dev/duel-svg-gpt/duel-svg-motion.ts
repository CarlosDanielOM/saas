import { COMBO_HEAL, DuelBattle, DuelCharacter, DuelSide, DuelTurn, otherSide, turnLength } from '../../../widgets/duel/duel-battle';

export const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
export const ease = (n: number) => { const p = clamp(n); return p * p * (3 - 2 * p); };
const out = (n: number) => 1 - Math.pow(1 - clamp(n), 3);
export const baseX = (side: DuelSide) => side === 'left' ? 275 : 685;
export interface VectorPose {
  x: number; y: number; rotation: number; sx: number; sy: number; opacity: number;
  body: number; arm: number; wrist: number; back: number; head: number; cloth: number; leg: number;
  guard: number; glow: number; split: number; heal: number; potion: number; action: string;
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
    const p: VectorPose = { x: baseX(side), y: 435, rotation: 0, sx: 1, sy: 1, opacity: 1, body: 0, arm: 0, wrist: 0, back: 0, head: 0, cloth: 0, leg: 0, guard: 0, glow: 0, split: 0, heal: 0, potion: 0, action: 'idle' };
    if (!reduced) {
      p.body = started ? Math.sin(time / 850 + dir) * .8 : 0;
      p.cloth = started ? Math.sin(time / 700 + dir) * 2 : -2;
      if (phase === 'entrance') {
        const walk = ease(time / 1150); p.x -= dir * 220 * (1 - walk);
        p.leg = Math.sin(time / 75) * 12 * (1 - walk); p.body = Math.sin(time / 75) * 2 * (1 - walk);
      }
      if (turn && turn.attacker === side) attackPose(p, character, turn, time, dir);
      if (turn && turn.attacker !== side && turn.move !== 'heal') {
        if (turn.defended && time > turn.at + (turn.hitAt - turn.at) * .2 && time < turn.hitAt + 540) {
          p.guard = ease((time - turn.at - (turn.hitAt - turn.at) * .2) / 150) * (1 - ease((time - turn.hitAt - 180) / 350));
          if (turn.move === 'special') p.guard *= 1 - ease((time - turn.hitAt) / 150);
          p.back = character === 'knight' ? 0 : -40 * p.guard;
          p.body = -5 * p.guard; p.head = 4 * p.guard;
          if (character === 'ronin') { p.x -= dir * 90 * p.guard; p.body = -12 * p.guard; p.cloth = 18 * p.guard; p.arm = -18 * p.guard; }
          if (turn.move !== 'special' && time >= turn.hitAt) { p.x -= dir * 8 * impact; p.body -= 3 * impact; }
          p.action = 'guard';
        }
        if (impact > 0 && turn.damage > 0 && turn.move !== 'ultimate' && (!turn.defended || turn.move === 'special')) {
          const hit = time - turn.hitAt, recoil = out(hit / 90) * (1 - ease((hit - 90) / 410));
          p.x -= dir * recoil * (turn.move === 'normal' ? 24 : turn.move === 'heavy' ? 48 : 67);
          p.body -= recoil * (turn.move === 'normal' ? 12 : 19); p.head += recoil * 14; p.action = 'hit';
        }
        if (turn.comboHeal && time >= turn.hitAt + COMBO_HEAL.delay - 150 && time < turn.hitAt + COMBO_HEAL.delay + 700) healPose(p, character, (time - turn.hitAt - COMBO_HEAL.delay + 150) / 850 * 1500);
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
    healPose(p, character, age);
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
  // Distinct silhouettes during anticipation. Contact holds for 70 ms, then recovers.
  const prepare = ease(age / Math.max(1, windup - 105)), strike = ease((age - windup + 105) / 105);
  const recover = 1 - ease((hit - 70) / Math.max(1, turnLength(turn) - windup - 70));
  const advance = out((age - windup + 170) / 170) * recover;
  if (character === 'mage') {
    const power = turn.move === 'normal' ? 1 : turn.move === 'heavy' ? 1.4 : 1.8;
    p.arm = (-24 * prepare + 42 * strike) * recover; p.back = -55 * prepare * recover;
    p.body = (-3 * prepare + 7 * strike) * recover; p.wrist = -8 * strike * recover;
    p.y -= (turn.move === 'special' ? 23 : turn.move === 'heavy' ? 7 : 0) * Math.sin(clamp(age / turnLength(turn)) * Math.PI);
    p.glow = prepare * recover * power; p.cloth = -8 * prepare * recover;
  } else if (character === 'knight') {
    const heavy = turn.move !== 'normal';
    p.x += dir * (-14 * prepare + (heavy ? 235 : 215) * advance);
    p.arm = (-(heavy ? 115 : 55) * prepare + (heavy ? 180 : 114) * strike) * recover;
    p.wrist = (12 * prepare - 24 * strike) * recover;
    p.body = (-8 * prepare + (heavy ? 27 : 18) * strike) * recover; p.head = -p.body * .35;
    p.back = (-16 * prepare + 14 * strike) * recover; p.leg = 17 * advance;
    if (turn.move === 'special') {
      const leap = clamp((age - 300) / Math.max(1, windup - 300));
      p.y -= hit < 0 ? Math.sin(leap * Math.PI) * 130 : 0;
      p.body += 5 * (1 - strike) * prepare; p.cloth = -28 * prepare * recover;
    } else p.cloth = -14 * advance;
  } else if (turn.move === 'special') {
    const dash = out((age - windup + 180) / 180), through = ease(hit / 150);
    p.x += dir * (-12 * prepare + 300 * dash + 230 * through);
    p.arm = (65 * prepare - 40 * strike) * recover; p.wrist = -35 * prepare * recover;
    p.body = 15 * prepare * recover; p.head = -6 * prepare; p.cloth = -38 * dash; p.leg = 20 * dash;
    if (hit > 230 && hit < 410) p.opacity = 1 - ease((hit - 230) / 150);
    if (hit >= 410) { p.x = baseX(turn.attacker); p.opacity = ease((hit - 410) / 220); p.body *= recover; }
  } else {
    const heavy = turn.move === 'heavy';
    p.x += dir * (-18 * prepare + (heavy ? 245 : 220) * advance);
    p.arm = (heavy ? 62 * prepare - 96 * strike : -48 * prepare + 105 * strike) * recover;
    p.wrist = (heavy ? -35 * prepare + 26 * strike : 10 * prepare - 20 * strike) * recover;
    p.body = (heavy ? 11 * prepare - 3 * strike : -4 * prepare + 16 * strike) * recover;
    p.head = heavy ? 6 * prepare * recover : -p.body * .35;
    p.back = -20 * prepare * recover; p.leg = 19 * advance; p.cloth = -20 * advance;
  }
}

function healPose(p: VectorPose, character: DuelCharacter, age: number): void {
  const lift = ease(age / 450), settle = 1 - ease((age - 1050) / 450), power = lift * settle;
  p.heal = power; p.glow = power; p.action = 'heal';
  if (character === 'knight') { p.arm = 34 * power; p.wrist = -18 * power; p.head = 13 * power; p.body = 4 * power; p.y += 9 * power; p.leg = 10 * power; }
  if (character === 'ronin') { p.back = 0; p.head = -9 * power; p.arm = 20 * power; p.body = -2 * power; p.potion = ease(age / 130) * (1 - ease((age - 1080) / 250)); }
  if (character === 'mage') { p.arm = -22 * power; p.back = -75 * power; p.y -= 14 * power; p.head = -4 * power; p.cloth = -8 * power; }
}

/** World-space caster tip, including both arm joints, torso, facing and root transform. */
export function staffTip(p: VectorPose, side: DuelSide): { x: number; y: number } {
  const rotate = (x: number, y: number, angle: number, cx: number, cy: number) => {
    const a = angle * Math.PI / 180, dx = x - cx, dy = y - cy;
    return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
  };
  let point = rotate(180, 36, p.wrist, 162, 175);
  point = rotate(point.x, point.y, p.arm, 136, 148);
  point = rotate(point.x, point.y, p.body, 108, 294);
  const x = (point.x - 108) * .9 * (side === 'left' ? 1 : -1), y = (point.y - 300) * .9;
  point = rotate(x, y, p.rotation, 0, 0);
  return { x: p.x + point.x, y: p.y + point.y };
}
