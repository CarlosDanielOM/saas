// Mirrors DUEL_RULES in dimabot/src/duel/model.ts: the defaults, limits and checks
// must match so the page never offers a value the server rejects.
/**
 * Battle rules a streamer can tune. Chances are out of 100, ultimates are per mille
 * per turn, damage and streamerBoost are percentages of the base values.
 */
export interface DuelRules {
  hp: number; damage: number; extraTurnChance: number;
  heavyChance: number; specialChance: number; critChance: number;
  defenseChance: number; healChance: number; healCharges: number; healMin: number; healMax: number; comboHealChance: number;
  streamerBoost: number; streamerUltimate: number; ultimate: number;
}
export type DuelRuleKey = keyof DuelRules;
/** How a value is shown: HP, %, ×multiplier (stored as %), ‰ shown as %, or a plain count. */
export type DuelRuleUnit = 'hp' | 'percent' | 'multiplier' | 'permille' | 'count';
export interface DuelRuleSpec { key: DuelRuleKey; min: number; max: number; step: number; unit: DuelRuleUnit }
export interface DuelRuleGroup { id: 'fighters' | 'attacks' | 'defense' | 'streamer'; rules: DuelRuleSpec[] }

/** Tuned and simulated: viewer duels are 50/50, the enraged streamer wins ~85%, fights last ~13–32 s. */
export const DEFAULT_DUEL_RULES: Readonly<DuelRules> = Object.freeze({
  hp: 100, damage: 100, extraTurnChance: 15,
  heavyChance: 24, specialChance: 8, critChance: 10,
  defenseChance: 15, healChance: 20, healCharges: 5, healMin: 25, healMax: 40, comboHealChance: 35,
  streamerBoost: 200, streamerUltimate: 40, ultimate: 2
});
export const DUEL_RULE_GROUPS: DuelRuleGroup[] = [
  { id: 'fighters', rules: [
    { key: 'hp', min: 50, max: 300, step: 10, unit: 'hp' },
    { key: 'damage', min: 50, max: 200, step: 5, unit: 'percent' },
    { key: 'extraTurnChance', min: 0, max: 50, step: 1, unit: 'percent' }
  ] },
  { id: 'attacks', rules: [
    { key: 'heavyChance', min: 0, max: 60, step: 1, unit: 'percent' },
    { key: 'specialChance', min: 0, max: 40, step: 1, unit: 'percent' },
    { key: 'critChance', min: 0, max: 50, step: 1, unit: 'percent' }
  ] },
  { id: 'defense', rules: [
    { key: 'defenseChance', min: 0, max: 50, step: 1, unit: 'percent' },
    { key: 'healChance', min: 0, max: 60, step: 1, unit: 'percent' },
    { key: 'healCharges', min: 0, max: 10, step: 1, unit: 'count' },
    { key: 'healMin', min: 5, max: 100, step: 1, unit: 'hp' },
    { key: 'healMax', min: 5, max: 100, step: 1, unit: 'hp' },
    { key: 'comboHealChance', min: 0, max: 100, step: 1, unit: 'percent' }
  ] },
  { id: 'streamer', rules: [
    { key: 'streamerBoost', min: 100, max: 300, step: 10, unit: 'multiplier' },
    { key: 'streamerUltimate', min: 0, max: 200, step: 1, unit: 'permille' },
    { key: 'ultimate', min: 0, max: 50, step: 1, unit: 'permille' }
  ] }
];
export const DUEL_RULE_SPECS: DuelRuleSpec[] = DUEL_RULE_GROUPS.flatMap(group => group.rules);
export const DUEL_RULE_KEYS = DUEL_RULE_SPECS.map(spec => spec.key);
export const defaultDuelRules = (): DuelRules => ({ ...DEFAULT_DUEL_RULES });
/** Rules saved before tuning existed (or partially) fall back to the defaults. */
export const normalizeDuelRules = (rules: Partial<DuelRules> | null | undefined): DuelRules => ({ ...DEFAULT_DUEL_RULES, ...(rules ?? {}) });
export const isDefaultDuelRules = (rules: Partial<DuelRules> | null | undefined): boolean => {
  const full = normalizeDuelRules(rules);
  return DUEL_RULE_KEYS.every(key => full[key] === DEFAULT_DUEL_RULES[key]);
};
export const changedDuelRules = (rules: DuelRules): DuelRuleKey[] => DUEL_RULE_KEYS.filter(key => rules[key] !== DEFAULT_DUEL_RULES[key]);
/** The one cross-field rule: heals can't roll a range that runs backwards. */
export const duelRulesValid = (rules: DuelRules): boolean => rules.healMin <= rules.healMax
  && DUEL_RULE_SPECS.every(spec => Number.isInteger(rules[spec.key]) && rules[spec.key] >= spec.min && rules[spec.key] <= spec.max && (rules[spec.key] - spec.min) % spec.step === 0);
