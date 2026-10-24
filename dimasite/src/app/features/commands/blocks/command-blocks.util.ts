import type { Command } from '../../../models/command.model';
import { type RootNode, plainText, rootFromStored } from './blocks.model';

/** Built in the block editor: show "AST Blocks" instead of a reply. */
export function isBlockCommand(command: Pick<Command, 'authoring'>): boolean {
  return command.authoring === 'blocks';
}

export function commandBlocksRoot(command: Pick<Command, 'blocks'>): RootNode | null {
  return rootFromStored(command.blocks);
}

/** Text to search and to read `&p1` / `&t` usage from: the reply, or the words inside the blocks. */
export function commandReplyText(command: Pick<Command, 'authoring' | 'blocks' | 'message'>): string {
  if (!isBlockCommand(command)) return command.message || '';
  const root = commandBlocksRoot(command);
  return root ? plainText(root) : '';
}

/** What a repeating timer posts: block commands run themselves by name. */
export function timerMessageFor(command: Pick<Command, 'authoring' | 'cmd'>, message: string): string {
  return isBlockCommand(command) ? `#(${command.cmd})` : String(message || '').slice(0, 350);
}
