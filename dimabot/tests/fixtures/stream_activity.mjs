// Deliberately synthetic: no environment, credentials, or production records.
export function streamActivityFixtures(ObjectId) {
    const session = new ObjectId('0123456789abcdef01234567');
    const otherSession = new ObjectId('fedcba987654321001234567');
    const start = Date.parse('2100-01-01T00:00:00Z');
    const expiresAt = new Date('2101-01-01T00:00:00Z');
    const rows = [];
    const add = (kind, extra = {}) => {
        const index = rows.length;
        rows.push({ _id: `fixture-${String(index).padStart(4, '0')}`, channelID: 'fixture-channel',
            session_id: session, occurredAt: new Date(start + index * 1000), expiresAt,
            offset: index * 10, kind, ...extra });
    };
    const emote = { key: 'twitch:é"\\\n🎉', label: 'Kappa "é"\n🎉', count: 2 };
    add('message', { actor: 'alice"\n🎉', actorLabel: 'Álice', emotes: [emote, { ...emote, count: 1 }] });
    add('command', { actor: 'alice"\n🎉', key: '!test"\n🎉', label: 'Unicode "command"\n🎉', outcome: 'error' });
    add('message', { actor: 'bob', emotes: [{ key: 'twitch:2', label: 'Second', count: 0 }] });
    add('redemption', { value: 2.5 });
    add('follow');
    add('sub', { value: 2 });
    add('gift', { value: 3 });
    add('bits', { value: 123.5 });
    add('raid', { value: 999 });
    add('message', { actor: '698614112', emotes: [emote] });
    add('message'); // Mongoose supplies optional defaults and an empty emote array.
    add('command', { actor: 'bob', key: '!ok', outcome: 'ok' });
    add('message', { actor: 'alice"\n🎉', actorLabel: 'Changed label', emotes: [emote] });
    add('message', { actor: 'bob', offset: 301 });
    add('message', { actor: 'alice"\n🎉', session_id: otherSession, offset: -0.5 });
    add('command', { channelID: 'fixture-other', session_id: otherSession, actor: 'carol', key: '!other' });
    add('message', { actor: 'already-processed', processed: true });
    add('message', { actor: 'expired', expiresAt: new Date(0) });
    return rows;
}

export function benchmarkFixtures(ObjectId, count, workload = 'repeated') {
    if (!['repeated', 'diverse'].includes(workload)) throw new Error('unknown benchmark workload');
    const session = new ObjectId('0123456789abcdef01234567');
    const start = Date.parse('2100-01-01T00:00:00Z');
    if (workload === 'diverse') return Array.from({ length: count }, (_, index) => ({
        _id: `bench-${String(index).padStart(8, '0')}`, channelID: `fixture-channel-${index % 24}`,
        session_id: session, occurredAt: new Date(start + index), expiresAt: new Date('2101-01-01T00:00:00Z'),
        offset: Math.floor(index / 500) * 300 + index % 300, kind: index % 5 ? 'message' : 'command',
        actor: `actor-${index % 1200}`, actorLabel: `Actor ${index % 1200}`, key: `command-${index % 80}`,
        outcome: index % 17 ? 'ok' : 'error', emotes: index % 3 ? [] : [
            { key: `twitch:${index % 120}`, label: 'Emote', count: 2 },
            { key: `twitch:${(index + 13) % 120}`, label: 'Other emote', count: 1 }
        ]
    }));
    return Array.from({ length: count }, (_, index) => ({
        _id: `bench-${String(index).padStart(8, '0')}`, channelID: `fixture-channel-${index % 3}`,
        session_id: session, occurredAt: new Date(start + index), expiresAt: new Date('2101-01-01T00:00:00Z'),
        offset: Math.floor(index / 100), kind: index % 5 ? 'message' : 'command',
        actor: `actor-${index % 300}`, actorLabel: `Actor ${index % 300}`, key: `command-${index % 10}`,
        outcome: index % 17 ? 'ok' : 'error', emotes: index % 3 ? [] : [{ key: `twitch:${index % 30}`, label: 'Emote', count: 2 }]
    }));
}
