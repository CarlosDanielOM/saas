export interface LegacyAstVariableDocument {
    channelID: string;
    scopeType: string;
    scopeName: string;
    userId: string;
    userLogin: string;
    variables: Record<string, string>;
    updatedAt?: Date;
    _id?: unknown;
}

export interface GlobalAstVariableDocument {
    channelID: string;
    scopeType: 'global';
    scopeName: 'global';
    userId: string;
    userLogin: string;
    variables: Record<string, string>;
}

/** A document timestamp is the finest historical update time available. */
export function planGlobalAstVariables(rows: LegacyAstVariableDocument[]): GlobalAstVariableDocument[] {
    const grouped = new Map<string, GlobalAstVariableDocument>();
    const sorted = rows
        .filter((row) => row.scopeType !== 'global')
        .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)
            || String(b._id ?? '').localeCompare(String(a._id ?? '')));

    for (const row of sorted) {
        const userId = row.userId || '';
        const userLogin = (row.userLogin || '').toLowerCase();
        const key = `${row.channelID}\0${userId || `login:${userLogin}`}`;
        let target = grouped.get(key);
        if (!target) {
            target = {
                channelID: row.channelID,
                scopeType: 'global', scopeName: 'global',
                userId, userLogin, variables: {}
            };
            grouped.set(key, target);
        }
        for (const [name, value] of Object.entries(row.variables || {})) {
            if (!Object.hasOwn(target.variables, name)) target.variables[name] = value;
        }
    }
    return [...grouped.values()];
}
