import { registerOverlayFunctions } from './overlay.functions.js';
import { registerAvailabilityFunctions } from './availability.functions.js';
import { registerRouletteFunctions } from './roulette.functions.js';
import { registerUserFunctions } from './user.functions.js';
import { registerRandomFunctions } from './random.functions.js';
import { registerModerationFunctions, startRestoreModeratorWorker } from './moderation.functions.js';
import { registerTwitchFunctions } from './twitch.functions.js';
import { registerCountFunctions } from './count.functions.js';
import { registerChannelFunctions } from './channel.functions.js';
import { registerClipFunctions } from './clip.functions.js';
import { registerFollowageFunctions } from './followage.functions.js';
import { registerEventsubFunctions } from './eventsub.functions.js';
import { registerTtsFunctions } from './tts.functions.js';
import { registerTriggerFunctions } from './trigger.functions.js';
import { registerDelayFunctions } from './delay.functions.js';
import { registerChatFunctions } from './chat.functions.js';
import { registerDefenseFunctions } from './defense.functions.js';
import { registerPinFunctions } from './pin.functions.js';
import { registerStringFunctions } from './string.functions.js';
import { registerGoalFunctions } from './goals.functions.js';
import { registerPetFunctions } from './pet.functions.js';
import { registerWidgetFunctions } from './widget.functions.js';

let registered = false;

/**
 * Registers every AST function. By default this also starts the moderator-restore loop
 * (as the bot needs); pass `{ startWorkers: false }` to only register (e.g. command tests
 * in the API, which must not run bot background work).
 */
export function registerAllFunctions(options: { startWorkers?: boolean } = {}): void {
    const startWorkers = options.startWorkers !== false;
    if (registered) {
        if (startWorkers) startRestoreModeratorWorker();
        return;
    }
    registered = true;
    
    registerOverlayFunctions();
    registerAvailabilityFunctions();
    registerRouletteFunctions();
    registerUserFunctions();
    registerRandomFunctions();
    registerModerationFunctions({ startWorker: startWorkers });
    registerTwitchFunctions();
    registerCountFunctions();
    registerChannelFunctions();
    registerClipFunctions();
    registerFollowageFunctions();
    registerEventsubFunctions();
    registerTtsFunctions();
    registerPetFunctions();
    registerWidgetFunctions();
    registerGoalFunctions();
    registerTriggerFunctions();
    registerDelayFunctions();
    registerChatFunctions();
    registerDefenseFunctions();
    registerPinFunctions();
    registerStringFunctions();
}

export { registerFunction, getFunctionHandler, getFunctionMetadata, getAllRegisteredFunctions, type FunctionHandler, type RegisteredFunctionEntry } from '../evaluator.js';
