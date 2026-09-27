export interface ChannelAdminPermissionGroup {
  key: string;
  view: readonly string[];
  manage: readonly string[];
}

/** Keep these keys aligned with the backend's assignable permission catalog. */
export const CHANNEL_ADMIN_PERMISSION_GROUPS: readonly ChannelAdminPermissionGroup[] = [
  { key: 'dashboard', view: ['dashboard:view'], manage: [] },
  { key: 'analytics', view: ['analytics:view'], manage: [] },
  { key: 'billing', view: ['billing:view'], manage: [] },
  { key: 'referrals', view: ['referrals:view'], manage: [] },
  { key: 'summaries', view: ['summaries:view'], manage: [] },
  { key: 'clips', view: ['clips:view'], manage: ['clips:manage'] },
  { key: 'commands', view: ['commands:view'], manage: ['commands:manage'] },
  { key: 'triggers', view: ['triggers:view'], manage: ['triggers:upload', 'triggers:attach', 'triggers:edit', 'triggers:delete'] },
  { key: 'settings', view: ['settings:view'], manage: ['settings:manage'] },
  { key: 'moderation', view: ['moderation:view'], manage: ['moderation:manage'] },
  { key: 'eventsubs', view: ['eventsubs:view'], manage: ['eventsubs:manage'] },
  { key: 'rewards', view: ['rewards:view'], manage: ['rewards:manage'] },
  { key: 'ai', view: ['ai:view'], manage: ['ai:manage'] },
  { key: 'memories', view: ['memories:view'], manage: ['memories:manage'] },
  { key: 'dimafx', view: ['dimafx:view'], manage: ['dimafx:edit', 'dimafx:delete'] },
  { key: 'admins', view: ['admins:view'], manage: [] },
  { key: 'chat', view: [], manage: ['chat:admin'] }
];
