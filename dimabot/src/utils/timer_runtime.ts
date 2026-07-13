import type {
    ISpecialParserContext,
    ISpecialParserResult
} from '../handlers/special_parser.handler.js';
import type { TimerPlanTier } from './timer_policy.js';

type TimerAstParser = (
    text: string,
    context: ISpecialParserContext
) => Promise<ISpecialParserResult>;

interface RenderTimerMessageOptions {
    channelID: string;
    streamerName: string;
    timerName: string;
    message: string;
    planTier: TimerPlanTier;
    parse: TimerAstParser;
}

export async function renderTimerMessage(options: RenderTimerMessageOptions): Promise<string> {
    const streamerLogin = options.streamerName.toLowerCase();
    const eventData = {
        chatter_user_id: options.channelID,
        chatter_user_login: streamerLogin,
        chatter_user_name: options.streamerName,
        broadcaster_user_id: options.channelID,
        broadcaster_user_login: streamerLogin,
        broadcaster_user_name: options.streamerName,
        badges: []
    };

    const result = await options.parse(options.message, {
        channelID: options.channelID,
        scopeType: 'timer',
        scopeName: options.timerName,
        argument: '',
        userPlan: options.planTier,
        userLevel: 10,
        eventData
    });

    return result.parsedText.trim();
}
