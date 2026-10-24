import UsersSchema from '../../schemas/users.schema.js';
import {
    BlocksError,
    MAX_COMMAND_TEXT,
    compileBlocks,
    storedBlocks,
    type StoredBlocks
} from '../../utils/ast_blocks/index.js';

export type ChannelPlan = 'free' | 'premium' | 'pro';

/** Block commands are a Premium/Pro feature; the channel owner's plan decides. */
export async function channelPlanTier(channelID: string): Promise<ChannelPlan> {
    const owner = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } })
        .select('plan_tier').maxTimeMS(1500).lean();
    return owner?.plan_tier === 'pro' ? 'pro' : owner?.plan_tier === 'premium' ? 'premium' : 'free';
}

export function canEditBlocks(plan: ChannelPlan): boolean {
    return plan === 'premium' || plan === 'pro';
}

interface PresentableCommand {
    authoring?: string | null;
    message?: string;
    blocks?: StoredBlocks | null;
    toObject?: () => Record<string, unknown>;
}

/**
 * Command as sent to any client. Block commands never include their compiled
 * text (`message` is blank); their blocks are included when asked for, so
 * viewers can open the read-only block view.
 */
export function presentCommand<T extends PresentableCommand>(command: T, options: { blocks?: boolean } = {}): Record<string, unknown> {
    const plain = (typeof command.toObject === 'function' ? command.toObject() : { ...command }) as Record<string, unknown>;
    const isBlocks = plain.authoring === 'blocks';
    plain.authoring = isBlocks ? 'blocks' : 'text';
    if (isBlocks) plain.message = '';
    if (!isBlocks || !options.blocks) delete plain.blocks;
    return plain;
}

export class CommandBlocksRequestError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string, public readonly blockId?: string) {
        super(message);
    }
}

/** Body → `{ message, authoring, blocks }` fields to save, checking plan and limits. */
export async function resolveCommandBody(
    channelID: string,
    body: Record<string, unknown>,
    current: { authoring?: string | null; reserved?: boolean } | null
): Promise<Record<string, unknown>> {
    const wantsBlocks = body.authoring === 'blocks';
    const currentlyBlocks = current?.authoring === 'blocks';

    // Settings-only save of a block command: the blocks stay as they are.
    if (wantsBlocks && currentlyBlocks && body.blocks === undefined) return {};

    if (wantsBlocks) {
        if (current?.reserved) throw new CommandBlocksRequestError(400, 'reserved', 'Built-in commands can\'t use blocks');
        if (!canEditBlocks(await channelPlanTier(channelID))) {
            throw new CommandBlocksRequestError(403, 'plan_required', 'Block commands need Premium or Pro');
        }
        try {
            const { root, text } = compileBlocks(body.blocks);
            return { authoring: 'blocks', blocks: storedBlocks(root), message: text };
        } catch (error) {
            if (error instanceof BlocksError) throw new CommandBlocksRequestError(400, 'blocks_invalid', error.message, error.blockId);
            throw error;
        }
    }

    if (body.authoring === 'text' || !currentlyBlocks) {
        if (!('message' in body)) {
            return body.authoring === 'text' && currentlyBlocks
                ? missingText()
                : {};
        }
        const message = typeof body.message === 'string' ? body.message : '';
        if (message.length > MAX_COMMAND_TEXT) {
            throw new CommandBlocksRequestError(400, 'too_long', `The reply is too long (${message.length} of ${MAX_COMMAND_TEXT} characters)`);
        }
        if (currentlyBlocks && !message.trim()) missingText();
        return currentlyBlocks || body.authoring === 'text'
            ? { authoring: 'text', blocks: null, message }
            : { message };
    }

    // A block command edited without new blocks: settings only, the reply stays.
    return {};
}

function missingText(): never {
    throw new CommandBlocksRequestError(400, 'missing_message', 'Type the new reply to switch back to text');
}
