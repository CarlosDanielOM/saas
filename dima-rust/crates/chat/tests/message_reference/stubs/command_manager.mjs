export * from 'real:commands/command_manager.command.ts';
import { builtin } from './builtin.mjs';
export const createCommand = builtin('createCommand');
export const deleteCommand = builtin('deleteCommand');
export const editCommand = builtin('editCommand');
