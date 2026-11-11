import type { AgentTool, ChangeProposal, ChangeRecordInput, ToolContext, ToolOutcome } from '../../../types.js';

/** A ToolContext for tool tests: owner of channel 100 on Free, English, holding every permission. */
export function makeCtx(overrides: Partial<ToolContext> & { granted?: string[] | '*' } = {}): ToolContext {
    const { granted = '*', ...rest } = overrides;
    return {
        channelId: '100',
        channelLogin: 'chan',
        requester: { id: '100', login: 'chan', displayName: 'Chan' },
        role: 'owner',
        plan: 'free',
        lang: 'en',
        sessionId: 's1',
        turnId: 't1',
        callId: 'c1',
        userMessage: 'please change it',
        page: null,
        signal: new AbortController().signal,
        can: async (permissions) => granted === '*' || permissions.every((permission) => granted.includes(permission)),
        ...rest
    };
}

export async function propose<I>(tool: AgentTool<I>, raw: unknown, ctx: ToolContext): Promise<ChangeProposal> {
    const outcome: ToolOutcome = await tool.run(tool.validate(raw), ctx);
    if (outcome.type !== 'approval') throw new Error(`Expected an approval, got ${JSON.stringify(outcome)}`);
    // Proposals are stored as JSON while the turn waits for approval.
    return JSON.parse(JSON.stringify(outcome.proposal)) as ChangeProposal;
}

export async function applyProposal(tool: AgentTool<any>, proposal: ChangeProposal, ctx: ToolContext): Promise<{ result: unknown; change: ChangeRecordInput | null }> {
    const applied = await tool.apply!(proposal, ctx);
    return JSON.parse(JSON.stringify(applied));
}

export async function undoChange(tool: AgentTool<any>, change: ChangeRecordInput, ctx: ToolContext): Promise<void> {
    const { callId: _callId, ...rest } = ctx;
    await tool.undo!({ undo: change.undo, after: change.after, target: change.target }, rest);
}

/** Fake describeCommandEffects: one effect per $(fn ...) call, a problem for "$(broken". */
export async function fakeEffects(body: string): Promise<{ effects: string[]; problems: string[] }> {
    const calls = [...body.matchAll(/\$\(([a-z.]+)/g)].map((match) => match[1]);
    return { effects: calls.filter((name) => !['user', 'cheer.amount'].includes(name)).map((name) => `Runs ${name}`), problems: body.includes('$(broken') ? ['Parse error'] : [] };
}
