// Stub of utils/command_cooldown_write.ts for the paths recorded here: an update that does not
// change the cooldown writes directly, as the real function does.
export class CommandCooldownError extends Error {}
export async function writeCommandWithCooldown(channelID, cooldown, current, write) {
  if (cooldown === undefined) return write();
  throw new Error('record.mts does not record cooldown writes');
}
