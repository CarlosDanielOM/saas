import TwitchStreamers from '../classes/twitch_streamers.class.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { isEditorLoginCached } from '../utils/permissions/roles.js';
import { error as logError } from '../utils/logger.js';
import { RouletteError } from '../roulette/model.js';
import { challengeDuel, acceptDuel, declineDuel, loadDuel } from '../duel/service.js';

interface DuelResponse { error: boolean; message: string; status?: number }
export async function duelCommand(channelID: string, user: string, _userMod: boolean, argument: string, _modID = '698614112'): Promise<DuelResponse> {
  try {
    const actor = user.trim().toLowerCase(), target = argument.trim().replace(/^@/, '').toLowerCase();
    if (!actor || !target) return { error: true, message: 'You must provide a user to duel.' };
    if (!/^[a-z0-9_]{1,25}$/.test(actor) || !/^[a-z0-9_]{1,25}$/.test(target)) return { error: true, message: 'Use !duel @username, !duel accept or !duel decline.' };
    const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
    if (!streamer) return { error: true, message: 'Streamer not found' };
    const cache = await getDragonflyClient('duel-command');
    const pending = target === 'accept' ? (await loadDuel(channelID)).challenge : null;
    const opponent = target === 'accept' ? pending?.challenger : target === 'decline' ? null : target;
    if (actor === streamer.name.toLowerCase() || opponent === streamer.name.toLowerCase()) return { error: true, message: 'You cannot duel the channel owner.' };
    if (opponent === actor) return { error: true, message: 'You cannot duel yourself.' };
    if (await isEditorLoginCached(cache, channelID, actor)) return { error: true, message: 'As an Editor, you cannot duel.' };
    if (opponent && await isEditorLoginCached(cache, channelID, opponent)) return { error: true, message: 'You cannot duel an Editor.' };
    if (target === 'accept') {
      await acceptDuel(channelID, actor);
      // Empty text is deliberate. The supervised worker announces the winner at the finish.
      return { error: false, message: '' };
    }
    if (target === 'decline') {
      const result = await declineDuel(channelID, actor);
      return { error: false, message: result.overlay ? '' : `@${actor} has declined the duel challenge from @${result.challenger}.` };
    }
    const overlay = await challengeDuel(channelID, actor, target);
    return { error: false, message: overlay ? '' : `@${actor} has challenged @${target} to a duel! Type "!duel accept" to accept the challenge or "!duel decline" to decline the challenge.` };
  } catch (error) {
    if (error instanceof RouletteError) return { error: true, message: error.message, status: error.status };
    await logError({ function: 'duelCommand', channelID, user, argument, error: String(error) }, { channelId: channelID, destination: 'both' });
    return { error: true, message: 'Internal server error' };
  }
}
