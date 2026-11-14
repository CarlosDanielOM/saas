export interface ChannelAdminPermissionGroup {
  key: string;
  view: readonly string[];
  manage: readonly string[];
}

/** Connect AI apps (MCP) to the channel. Explicit only: full access (`*`) never includes it. */
export const MCP_ADMIN_PERMISSION = 'mcp:admin';

/** Grants with their own switch in the Team editor, not website pages. */
export const SWITCH_PERMISSION_GROUPS: ReadonlySet<string> = new Set(['chat', 'mcp']);

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
  { key: 'tts', view: ['tts:view'], manage: ['tts:manage'] },
  { key: 'moderation', view: ['moderation:view'], manage: ['moderation:manage'] },
  { key: 'eventsubs', view: ['eventsubs:view'], manage: ['eventsubs:manage'] },
  { key: 'rewards', view: ['rewards:view'], manage: ['rewards:manage'] },
  { key: 'ai', view: ['ai:view'], manage: ['ai:manage'] },
  { key: 'memories', view: ['memories:view'], manage: ['memories:manage'] },
  { key: 'dimafx', view: ['dimafx:view'], manage: ['dimafx:edit', 'dimafx:delete'] },
  { key: 'admins', view: ['admins:view'], manage: [] },
  { key: 'chat', view: [], manage: ['chat:admin'] },
  { key: 'mcp', view: [], manage: [MCP_ADMIN_PERMISSION] }
];
