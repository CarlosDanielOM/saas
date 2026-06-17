import { registerFunction, type FunctionHandler } from '../evaluator.js';
import * as ClipFunctions from '../../../functions/clips/index.js';
import { parseClipOptions, type CreateClipOptions } from '../../../commands/create_clip.command.js';

function parseRawArgument(args: unknown[], fallback?: string): string {
    if (args.length > 0) {
        return args.map(arg => String(arg)).join(' ').trim();
    }
    return String(fallback || '').trim();
}

const createClipHandler: FunctionHandler = async (args, ctx) => {
    const rawArgument = parseRawArgument(args, ctx.argument);
    const options: CreateClipOptions = parseClipOptions(rawArgument);
    const result = await ClipFunctions.createClip(ctx.broadcasterId, options);
    if (result.error || !result.clipID) {
        return '';
    }
    return `https://clips.twitch.tv/${result.clipID}`;
};

export function registerClipFunctions(): void {
    registerFunction('create.clip', createClipHandler);
}
