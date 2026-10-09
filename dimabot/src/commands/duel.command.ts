import TwitchStreamers from '../classes/twitch_streamers.class.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { isEditorLoginCached } from '../utils/permissions/roles.js';
import { error as logError } from '../utils/logger.js';
import { RouletteError } from '../roulette/model.js';
import { challengeDuel, acceptDuel, declineDuel, loadDuel, fightStreamer } from '../duel/service.js';

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
    // The streamer fights enraged (doubled odds) and is never timed out.
    const owner = streamer.name.toLowerCase();
    if (opponent === actor) return { error: true, message: 'You cannot duel yourself.' };
    if (actor !== owner && await isEditorLoginCached(cache, channelID, actor)) return { error: true, message: 'As an Editor, you cannot duel.' };
    if (opponent && opponent !== owner && await isEditorLoginCached(cache, channelID, opponent)) return { error: true, message: 'You cannot duel an Editor.' };
    if (target === 'accept') {
      await acceptDuel(channelID, actor);
      // Empty text is deliberate. The supervised worker announces the winner at the finish.
      return { error: false, message: '' };
    }
    if (target === 'decline') {
      const result = await declineDuel(channelID, actor);
      return { error: false, message: result.overlay ? '' : `@${actor} has declined the duel challenge from @${result.challenger}.` };
    }
    if (target === owner) {
      // Challenges against the streamer are accepted automatically.
      const run = await fightStreamer(channelID, actor, owner);
      return { error: false, message: run.mode === 'overlay' ? '' : `@${actor} has challenged the streamer @${owner}! The enraged streamer accepts. FIGHT!` };
    }
    const overlay = await challengeDuel(channelID, actor, target, actor === owner ? 'left' : null);
    const who = actor === owner ? `The enraged streamer @${actor}` : `@${actor}`;
    return { error: false, message: overlay ? '' : `${who} has challenged @${target} to a duel! Type "!duel accept" to accept the challenge or "!duel decline" to decline the challenge.` };
  } catch (error) {
    if (error instanceof RouletteError) return { error: true, message: error.message, status: error.status };
    await logError({ function: 'duelCommand', channelID, user, argument, error: String(error) }, { channelId: channelID, destination: 'both' });
    return { error: true, message: 'Internal server error' };
  }
}
