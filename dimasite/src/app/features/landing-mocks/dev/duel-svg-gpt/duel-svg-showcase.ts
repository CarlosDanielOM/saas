import { DuelBattle, DuelCharacter, DuelSide, DuelTurn, timing, turnLength } from '../../../widgets/duel/duel-battle';

export type SvgPreviewMove = 'normal' | 'heavy' | 'special' | 'heal' | 'defend' | 'break';

/** Local fixtures only: the chosen character attacks, heals, or receives a defended hit. */
export function sampleBattle(character: DuelCharacter, preview: SvgPreviewMove, enraged: DuelSide | null): DuelBattle {
  const defending = preview === 'defend' || preview === 'break';
  const move = preview === 'defend' ? 'heavy' : preview === 'break' ? 'special' : preview;
  const featured: DuelTurn = {
    at: 5550, hitAt: 5550 + timing(move).windup, attacker: defending ? 'right' : 'left', move,
    damage: move === 'heal' ? 0 : preview === 'defend' ? 5 : move === 'normal' ? 14 : move === 'heavy' ? 26 : 36,
    raw: move === 'heavy' ? 26 : 36, bonus: false,
    ...(move === 'heal' ? { heal: 28 } : {}),
    ...(defending ? { defended: true } : {}),
    ...(preview === 'defend' ? { comboHeal: 14 } : {}),
  };
  const finish = featured.at + turnLength(featured) + 350;
  return {
    fighters: { left: character, right: character === 'knight' ? 'ronin' : character === 'ronin' ? 'mage' : 'knight' },
    winner: 'left', maxHp: 100, healCharges: 5, enraged, duration: finish + 850 + 1900,
    turns: [
      { at: 3700, hitAt: 3980, attacker: 'right', move: 'normal', damage: 28, bonus: false },
      { at: 4500, hitAt: 4780, attacker: 'left', move: 'normal', damage: 22, bonus: false },
      featured,
      { at: finish, hitAt: finish + 850, attacker: 'left', move: 'special', damage: 78 - (defending || move === 'heal' ? 0 : featured.damage), bonus: false },
    ],
  };
}
