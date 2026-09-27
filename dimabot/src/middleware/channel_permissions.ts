/** Permissions that a broadcaster may assign to a channel admin. */
export const CHANNEL_ADMIN_PERMISSIONS = [
    'dashboard:view',
    'analytics:view',
    'billing:view',
    'referrals:view',
    'summaries:view',
    'clips:view', 'clips:manage',
    'commands:view', 'commands:manage',
    'triggers:view', 'triggers:upload', 'triggers:attach', 'triggers:edit', 'triggers:delete',
    'settings:view', 'settings:manage',
    'moderation:view', 'moderation:manage',
    'eventsubs:view', 'eventsubs:manage',
    'rewards:view', 'rewards:manage',
    'ai:view', 'ai:manage',
    'memories:view', 'memories:manage',
    'dimafx:view', 'dimafx:edit', 'dimafx:delete',
    'admins:view',
    'chat:admin'
] as const;

const assignable = new Set<string>(CHANNEL_ADMIN_PERMISSIONS);
const manageRequiresView: Record<string, string> = {
    'commands:manage': 'commands:view',
    'clips:manage': 'clips:view',
    'admins:view': 'settings:view',
    'triggers:upload': 'triggers:view',
    'triggers:attach': 'triggers:view',
    'triggers:edit': 'triggers:view',
    'triggers:delete': 'triggers:view',
    'settings:manage': 'settings:view',
    'moderation:manage': 'moderation:view',
    'eventsubs:manage': 'eventsubs:view',
    'rewards:manage': 'rewards:view',
    'ai:manage': 'ai:view',
    'memories:manage': 'memories:view',
    'dimafx:edit': 'dimafx:view',
    'dimafx:delete': 'dimafx:view'
};

export function parseChannelAdminPermissions(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.length > CHANNEL_ADMIN_PERMISSIONS.length) return null;
    if (value.length === 1 && value[0] === '*') return ['*'];
    if (value.some((item) => typeof item !== 'string' || !assignable.has(item))) return null;
    const permissions = [...new Set(value as string[])];
    for (const permission of [...permissions]) {
        const requiredView = manageRequiresView[permission];
        if (requiredView && !permissions.includes(requiredView)) permissions.push(requiredView);
    }
    // The authenticated channel shell and admin hub both require dashboard access.
    if (!permissions.includes('dashboard:view')) permissions.unshift('dashboard:view');
    return permissions;
}

export function grantsChatAdminRole(permissions: unknown): boolean {
    return Array.isArray(permissions) && (permissions.includes('*') || permissions.includes('chat:admin'));
}
