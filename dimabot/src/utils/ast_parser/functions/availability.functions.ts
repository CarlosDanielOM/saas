import { registerFunction } from '../evaluator.js';
import { availabilityAdapters, MAX_AVAILABILITY_SECONDS, setAvailability } from '../../availability/service.js';

export function registerAvailabilityFunctions(): void {
    for (const target of availabilityAdapters) {
        for (const enabled of [true, false]) {
            const name = `${enabled ? 'enable' : 'disable'}.${target.name}`;
            registerFunction(name, async (args, ctx) => {
                if (args.length < 1 || args.length > 2 || !String(args[0] ?? '').trim()) {
                    return `Usage: $(${name} "name" [seconds]) — quote names containing spaces`;
                }
                try {
                    const seconds = args.length === 2 ? Number(args[1]) : undefined;
                    await setAvailability(target.name, ctx.broadcasterId, String(args[0]).trim(), enabled, seconds);
                    return '';
                } catch (error) {
                    return `${name}: ${error instanceof Error ? error.message : String(error)}`;
                }
            }, {
                description: `${enabled ? 'Enables' : 'Disables'} a ${target.name} in this channel. Quote names containing spaces. Optional 1-${MAX_AVAILABILITY_SECONDS} seconds restores the previous state after the duration, including after restarts. Repeating the same timed change extends it; omitting duration cancels any pending restoration.`,
                syntax: `${name} "name" [seconds]`, category: 'availability',
                examples: [target.name === 'command' ? `${name} discord` : `${name} "Hydrate"`,
                    target.name === 'command' ? `${name} discord 300` : `${name} "Hydrate" 300`],
                minUserLevel: 7, destructive: !enabled,
                keywords: [enabled ? 'enable' : 'disable', target.name, 'temporary', 'availability', enabled ? 'activar' : 'desactivar']
            });
        }
    }
}
