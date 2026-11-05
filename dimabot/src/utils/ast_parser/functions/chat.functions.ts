import { registerFunction, type FunctionHandler } from '../evaluator.js';
import type { FunctionMetadata } from '../types.js';
import { TWITCH_BOT_ACCOUNT_ID } from '../../header.js';
import { targetUser } from './shoutout_target.js';
import * as ChatFunctions from '../../../functions/chats/index.js';

const chatSendHandler: FunctionHandler = async (args, ctx) => {
    const message = (args[0] ?? '').toString().trim();
    if (!message) {
        return '';
    }
    const result = await ChatFunctions.sendTwitchChatMessage(ctx.broadcasterId, message);
    if (result.error) {
        return `chat.send: ${result.message}`;
    }
    return '';
};

const announcementColors = new Set(['blue', 'green', 'orange', 'purple', 'primary']);
const announceHandler: FunctionHandler = async (args, ctx) => {
    const raw = args.map(arg => String(arg ?? '')).join(' ').trim();
    const [first = ''] = raw.split(/\s+/);
    const hasColor = announcementColors.has(first.toLowerCase());
    const color = hasColor ? first.toLowerCase() : 'primary';
    const message = hasColor ? raw.slice(first.length).trim() : raw;
    if (!message) return 'Usage: $(announce [blue|green|orange|purple|primary] message)';
    if (message.length > 500) return 'announce: message must be at most 500 characters';
    try {
        const result = await ChatFunctions.sendAnnouncement(ctx.broadcasterId, TWITCH_BOT_ACCOUNT_ID, message, color);
        return result.error ? message : '';
    } catch { return message; }
};

export function registerChatFunctions(): void {
    const announceMetadata: FunctionMetadata = {
        description: 'Sends a Twitch announcement. Optional first word selects blue, green, orange, purple or primary; default primary. Message must be 1-500 characters. Returns the message for normal delivery if the announcement fails.',
        syntax: 'announce [color] message', category: 'chat',
        examples: ['announce Welcome everyone!', 'announce purple Five minutes left!'],
        minUserLevel: 7, keywords: ['announcement', 'announce', 'anuncio']
    };
    registerFunction('announce', announceHandler, announceMetadata);
    registerFunction('announcement', announceHandler, { ...announceMetadata, aliasOf: 'announce' });
    registerFunction('shoutout', async (args, ctx) => {
        const user = await targetUser(ctx, args[0]);
        if (!user) return '';
        try { await ChatFunctions.sendShoutout(ctx.broadcasterId, user.id, TWITCH_BOT_ACCOUNT_ID); } catch { /* best effort */ }
        return '';
    }, { description: 'Sends only a native Twitch shoutout to the target login (optional @). Missing or invalid targets do nothing.', syntax: 'shoutout target', category: 'chat', examples: ['shoutout streamer'], minUserLevel: 7, keywords: ['shoutout', 'twitch shoutout', 'recomendar canal'] });
    registerFunction('chat.announcement', announceHandler, { ...announceMetadata, aliasOf: 'announce' });
    registerFunction('chat.send', chatSendHandler, {
        description: 'Sends a message to chat as the bot.',
        syntax: 'chat.send message',
        category: 'chat',
        examples: ['chat.send Hello everyone!'],
        keywords: ['send message', 'say', 'enviar mensaje', 'decir en chat', 'hablar']
    });
}
