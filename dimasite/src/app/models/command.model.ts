import type { PermissionExpression } from './permission.model';

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
  /** Tag-mode permission tree. Null/absent = legacy level mode. */
  permissionExpression?: PermissionExpression | null;
  /** Computed non-localized state from the API: level | tags | invalid. */
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
  /** Valid tag-mode tree, or null to create in legacy level mode. */
  permissionExpression?: PermissionExpression | null;
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
  /** Omitted leaves the mode unchanged; null switches to level mode; a valid tree switches to tag mode. */
  permissionExpression?: PermissionExpression | null;
  enabled?: boolean;
}

/**
 * Legacy numeric levels. 5 = vip, 6 = founder (fixed swap), 10 = broadcaster.
 * Keep USER_LEVEL_NAMES in sync.
 */
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
