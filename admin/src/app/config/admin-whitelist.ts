export const ADMIN_WHITELIST = ['533538623'] as const;

export function isAdmin(twitchUserId: string): boolean {
  return ADMIN_WHITELIST.includes(twitchUserId as typeof ADMIN_WHITELIST[number]);
}