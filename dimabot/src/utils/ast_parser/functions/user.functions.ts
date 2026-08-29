import type { ExecutionContext } from '../types.js';
import { registerFunction, type FunctionHandler } from '../evaluator.js';
import * as ChatFunctions from '../../../functions/chats/index.js';

function sanitizeInput(input: unknown): string {
    if (typeof input !== 'string') return String(input || '');
    return input
        .replace(/\$/g, '\\$')
        .replace(/%/g, '\\%')
        .replace(/\*/g, '\\*');
}

function getUserName(ctx: ExecutionContext): string {
    const eventData = ctx.eventData as Record<string, unknown> | undefined;
    
    if (eventData?.chatter_user_name) {
        return String(eventData.chatter_user_name);
    }
    if (eventData?.chatter_user_login) {
        return String(eventData.chatter_user_login);
    }
    if (ctx.extraContext?.userName) {
        return String(ctx.extraContext.userName);
    }
    if (ctx.extraContext?.userLogin) {
        return String(ctx.extraContext.userLogin);
    }
    return ctx.userDisplayName || ctx.userLogin || '';
}

const userHandler: FunctionHandler = async (_args, ctx) => {
    return getUserName(ctx);
};

const touserHandler: FunctionHandler = async (args, ctx) => {
    const target = args[0] || ctx.argument;
    if (target) {
        return sanitizeInput(target);
    }
    return getUserName(ctx);
};

const randomuserHandler: FunctionHandler = async (_args, ctx) => {
    const chattersResult = await ChatFunctions.getChatters(ctx.broadcasterId, ctx.broadcasterId);
    if (chattersResult.error) {
        return chattersResult.message;
    }
    if (!chattersResult.chatters || chattersResult.chatters.length === 0) {
        return getUserName(ctx) || 'Unknown';
    }
    const randomChatter = chattersResult.chatters[Math.floor(Math.random() * chattersResult.chatters.length)];
    return randomChatter.user_name || randomChatter.user_login || 'Unknown';
};

export function registerUserFunctions(): void {
    registerFunction('user', userHandler, {
        description: 'Returns the username of the caller / current chatter.',
        syntax: 'user',
        category: 'user',
        examples: ['user'],
        keywords: ['caller', 'username', 'who', 'usuario', 'nombre', 'quien']
    });
    registerFunction('touser', touserHandler, {
        description: 'Returns the target username from the first argument; falls back to the caller when no argument is given.',
        syntax: 'touser [target]',
        category: 'user',
        examples: ['touser', 'touser $(randomuser)'],
        keywords: ['target', 'argument', 'objetivo', 'destinatario']
    });
    registerFunction('randomuser', randomuserHandler, {
        description: 'Returns the name of a random active chatter in the channel.',
        syntax: 'randomuser',
        category: 'user',
        examples: ['randomuser'],
        keywords: ['random chatter', 'random viewer', 'usuario aleatorio', 'alguien random']
    });
}
