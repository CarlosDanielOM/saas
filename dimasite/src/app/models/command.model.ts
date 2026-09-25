export interface Command {
  id: string;
  _id?: string;
  channel: string;
  channelID: string;
  cmd: string;
  func: string;
  cooldown: number;
  count?: number;
  createdAt: string;
  date?: {
    day: number;
    month: number;
    year: number;
  };
  description: string | null;
  enabled: boolean;
  message: string;
  name: string;
  paused?: boolean;
  premiumLevelRequired?: number;
  premiumRequired?: boolean;
  reserved: boolean;
  responses?: object[];
  type?: string;
  userLevel: number;
  userLevelName: string;
}

export interface CreateCommandRequest {
  name: string;
  cmd: string;
  func: string;
  message: string;
  description?: string | null;
  cooldown: number;
  userLevel: number;
  userLevelName: string;
  enabled: boolean;
  channel: string;
}

export interface UpdateCommandRequest {
  name?: string;
  cmd?: string;
  func?: string;
  message?: string;
  description?: string | null;
  cooldown?: number;
  userLevel?: number;
  userLevelName?: string;
  enabled?: boolean;
}

/** Canonical names. The number is what the bot checks: 5 is VIP, 6 is founder, 10 is the channel. */
export const USER_LEVELS: Record<number, string> = {
  1: 'everyone',
  2: 'tier1',
  3: 'tier2',
  4: 'tier3',
  5: 'vip',
  6: 'founder',
  7: 'mod',
  8: 'editor',
  9: 'admin',
  10: 'broadcaster'
};

export const USER_LEVEL_NAMES: Record<number, string> = {
  1: 'commands.userLevels.everyone',
  2: 'commands.userLevels.tier1',
  3: 'commands.userLevels.tier2',
  4: 'commands.userLevels.tier3',
  5: 'commands.userLevels.vip',
  6: 'commands.userLevels.founder',
  7: 'commands.userLevels.mod',
  8: 'commands.userLevels.editor',
  9: 'commands.userLevels.admin',
  10: 'commands.userLevels.broadcaster'
};

/** Plain "who can use this" phrase. The number is the source of truth, not a stored legacy name. */
export function whoCanUsePhrase(
  level: number,
  translate: (key: string, params?: Record<string, string | number>) => string
): string {
  if (level <= 1) return translate('commands.whoCanUse.everyone');
  if (level >= 10) return translate('commands.whoCanUse.onlyYou');
  const roleKey = USER_LEVEL_NAMES[level] ?? 'commands.userLevels.everyone';
  return translate('commands.whoCanUse.andAbove', { role: translate(roleKey) });
}
