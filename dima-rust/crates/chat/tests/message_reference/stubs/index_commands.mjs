export * from 'real:commands/index.commands.ts';
import { builtin } from './builtin.mjs';
const names = ['sumimetro', 'ruletarusa', 'amor', 'disableCommand', 'enableCommand', 'commandList', 'followage', 'title', 'game',
  'addModerator', 'removeModerator', 'createClip', 'onlyEmotes', 'vanish', 'duel', 'addVip', 'removeVip', 'poll', 'prediction'];
export const indexCommands = Object.fromEntries(names.map((name) => [name, builtin(name)]));
