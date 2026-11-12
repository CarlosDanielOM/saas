// The real send, tracked (the handler does not wait for some of its posts).
export * from 'real:functions/chats/send_message.chat.ts';
import * as real from 'real:functions/chats/send_message.chat.ts';
import { track } from './rec.mjs';
export const sendTwitchChatMessage = (...args) => track(real.sendTwitchChatMessage(...args));
