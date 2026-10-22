import { registerFunction, type FunctionHandler } from '../evaluator.js';
import { nextPetAction } from '../effects.js';

function petHandler(operation: 'talk' | 'ask'): FunctionHandler {
    return async (args, ctx) => {
        // Metadata is discoverability, not authority. AI, timers and generic renders cannot admit work.
        if (ctx.enforceFunctionPermissions !== false || ctx.authorization?.origin !== 'authored'
            || (ctx.timerDepth ?? 0) > 0 || ctx.platform !== 'twitch') return 'Error: pet_context_required';
        const identity = nextPetAction(ctx.effectContext, ctx.broadcasterId);
        if (!identity) return 'Error: pet_context_required';
        const text = (args.length ? args.map(String).join(' ') : String(ctx.argument || '')).trim();
        if (!text || text.length > 2000) return 'Error: invalid_pet_text';
        try {
            // Admission persists + wakes the API only. Never import/start the provider runtime here.
            const { admitPetAction } = await import('../../../pets/admission.js');
            await admitPetAction({ channelId: ctx.broadcasterId, operation, text, ...identity });
            return '';
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
            return `Error: ${/^[a-z_]{1,80}$/.test(code) ? code : 'pet_admission_failed'}`;
        }
    };
}

export function registerPetFunctions(): void {
    for (const operation of ['talk', 'ask'] as const) registerFunction(`pet.${operation}`, petHandler(operation), {
        description: operation === 'talk'
            ? 'Speaks supplied text through the pet speech queue without an LLM. Requires a configured command or Twitch event action.'
            : 'Asks the pet personality for a reply, then speaks it through the pet speech queue. Requires a configured command or Twitch event action.',
        syntax: `pet.${operation} ${operation === 'talk' ? 'text' : 'prompt'}`,
        category: 'pet', planTier: 'premium', surfaces: ['authoring'],
        examples: [`pet.${operation} ${operation === 'talk' ? 'Hello chat!' : 'Welcome our new follower!'}`],
        keywords: ['pet', 'mascota', 'speech', operation]
    });
}
