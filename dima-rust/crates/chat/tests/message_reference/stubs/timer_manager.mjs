export * from 'real:commands/timer_manager.command.ts';
import { builtin } from './builtin.mjs';
export const createTimer = builtin('createTimer');
export const editTimer = builtin('editTimer');
export const deleteTimer = builtin('deleteTimer');
export const listTimers = builtin('listTimers');
