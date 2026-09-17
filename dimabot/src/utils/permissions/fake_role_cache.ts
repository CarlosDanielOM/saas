/**
 * In-memory Dragonfly stand-in used by the permission test suites.
 * Implements the structural subset of the client that the role cache
 * helpers rely on (sets, hashes, expiry, key scans, deletes).
 */
export class FakeRoleCache {
    readonly sets = new Map<string, Set<string>>();
    readonly hashes = new Map<string, Map<string, string>>();
    readonly expirations = new Map<string, number>();
    readonly deletedKeys: string[] = [];

    private keyCount(key: string): number {
        const set = this.sets.get(key);
        if (set) return set.size;
        const hash = this.hashes.get(key);
        if (hash) return hash.size;
        return this.expirations.has(key) ? 1 : 0;
    }

    async sIsMember(key: string, member: string): Promise<number> {
        return this.sets.get(key)?.has(member) ? 1 : 0;
    }

    async sAdd(key: string, member: string): Promise<number> {
        let set = this.sets.get(key);
        if (!set) {
            set = new Set<string>();
            this.sets.set(key, set);
        }
        if (set.has(member)) return 0;
        set.add(member);
        return 1;
    }

    async sRem(key: string, member: string): Promise<number> {
        const set = this.sets.get(key);
        if (!set || !set.has(member)) return 0;
        set.delete(member);
        return 1;
    }

    async del(key: string | string[]): Promise<number> {
        const keys = Array.isArray(key) ? key : [key];
        let removed = 0;
        for (const keyToDelete of keys) {
            if (this.keyCount(keyToDelete) === 0 && !this.expirations.has(keyToDelete)) {
                this.deletedKeys.push(keyToDelete);
                continue;
            }
            this.sets.delete(keyToDelete);
            this.hashes.delete(keyToDelete);
            this.expirations.delete(keyToDelete);
            this.deletedKeys.push(keyToDelete);
            removed += 1;
        }
        return removed;
    }

    async expire(key: string, seconds: number): Promise<number> {
        if (this.keyCount(key) === 0) return 0;
        this.expirations.set(key, seconds);
        return 1;
    }

    async keys(pattern: string): Promise<string[]> {
        const regex = new RegExp(
            `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
        );
        const allKeys = new Set<string>([
            ...this.sets.keys(),
            ...this.hashes.keys(),
            ...this.expirations.keys()
        ]);
        return [...allKeys].filter((key) => regex.test(key));
    }

    async hSet(key: string, value: Record<string, string>): Promise<number> {
        let hash = this.hashes.get(key);
        if (!hash) {
            hash = new Map<string, string>();
            this.hashes.set(key, hash);
        }
        let added = 0;
        for (const [field, fieldValue] of Object.entries(value)) {
            if (!hash.has(field)) added += 1;
            hash.set(field, String(fieldValue));
        }
        return added;
    }

    async hGetAll(key: string): Promise<Record<string, string>> {
        const hash = this.hashes.get(key);
        if (!hash) return {};
        return Object.fromEntries(hash);
    }

    setMembers(key: string, members: string[]): void {
        this.sets.set(key, new Set(members));
    }

    members(key: string): string[] {
        return [...(this.sets.get(key) ?? new Set<string>())].sort();
    }
}
