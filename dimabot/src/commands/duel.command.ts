import TwitchStreamers from '../classes/twitch_streamers.class.js';
import { error as logError } from '../utils/logger.js';
import { RouletteError } from '../roulette/model.js';
import { challengeDuel, acceptDuel, declineDuel, loadDuel, fightStreamer } from '../duel/service.js';

interface DuelResponse { error: boolean; message: string; status?: number }
/** Chat lines in the channel's duel language. The challenge always explains how to answer:
 * an OBS overlay is often too small for viewers to read the commands. */
const lines = {
  en: {
    challenge: (who: string, target: string) => `@${target}, ${who} has challenged you to a duel! To accept use "!duel accept" or decline with "!duel decline" within 30 seconds.`,
    challenger: (actor: string, enraged: boolean) => enraged ? `the enraged streamer @${actor}` : `@${actor}`,
    declined: (actor: string, challenger: string) => `@${actor} has declined the duel challenge from @${challenger}.`,
    streamer: (actor: string, owner: string) => `@${actor} has challenged the streamer @${owner}! The enraged streamer accepts. FIGHT!`
  },
  es: {
    challenge: (who: string, target: string) => `@${target}, ¡${who} te ha retado a un duelo! Para aceptar usa "!duel accept" o rechaza con "!duel decline" en 30 segundos.`,
    challenger: (actor: string, enraged: boolean) => enraged ? `el streamer enfurecido @${actor}` : `@${actor}`,
    declined: (actor: string, challenger: string) => `@${actor} ha rechazado el duelo de @${challenger}.`,
    streamer: (actor: string, owner: string) => `¡@${actor} ha retado al streamer @${owner}! El streamer enfurecido acepta. ¡A PELEAR!`
  }
};
export async function duelCommand(channelID: string, user: string, _userMod: boolean, argument: string, _modID = '698614112'): Promise<DuelResponse> {
  try {
    const actor = user.trim().toLowerCase(), target = argument.trim().replace(/^@/, '').toLowerCase();
    if (!actor || !target) return { error: true, message: 'You must provide a user to duel.' };
    if (!/^[a-z0-9_]{1,25}$/.test(actor) || !/^[a-z0-9_]{1,25}$/.test(target)) return { error: true, message: 'Use !duel @username, !duel accept or !duel decline.' };
    const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
    if (!streamer) return { error: true, message: 'Streamer not found' };
    const pending = target === 'accept' ? (await loadDuel(channelID)).challenge : null;
    const opponent = target === 'accept' ? pending?.challenger : target === 'decline' ? null : target;
    // The streamer fights enraged (doubled odds). Editors fight normally. Neither is ever timed out.
    const owner = streamer.name.toLowerCase();
    if (opponent === actor) return { error: true, message: 'You cannot duel yourself.' };
    if (target === 'accept') {
      await acceptDuel(channelID, actor);
      // Empty text is deliberate. The supervised worker announces the winner at the finish.
      return { error: false, message: '' };
    }
    if (target === 'decline') {
      const result = await declineDuel(channelID, actor);
      return { error: false, message: result.overlay ? '' : lines[result.language].declined(actor, result.challenger) };
    }
    if (target === owner) {
      // Challenges against the streamer are accepted automatically.
      const run = await fightStreamer(channelID, actor, owner);
      return { error: false, message: run.mode === 'overlay' ? '' : lines[run.language].streamer(actor, owner) };
    }
    const { language } = await challengeDuel(channelID, actor, target, actor === owner ? 'left' : null);
    const text = lines[language];
    return { error: false, message: text.challenge(text.challenger(actor, actor === owner), target) };
  } catch (error) {
    if (error instanceof RouletteError) return { error: true, message: error.message, status: error.status };
    await logError({ function: 'duelCommand', channelID, user, argument, error: String(error) }, { channelId: channelID, destination: 'both' });
    return { error: true, message: 'Internal server error' };
  }
}
