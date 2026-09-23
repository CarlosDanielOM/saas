import type { PermissionExpression } from './permission-expression.model';

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
  /** Stored commands can contain an invalid historical tree; inspect before editing. */
  permissionExpression?: unknown;
  permissionMode?: 'level' | 'tags' | 'invalid';
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
  permissionExpression?: PermissionExpression | null;
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
  permissionExpression?: PermissionExpression | null;
}

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
