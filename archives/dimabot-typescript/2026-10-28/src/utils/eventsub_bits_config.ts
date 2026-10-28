import type { IEventsub } from '../schemas/eventsub.schema.js';

export type EventsubConfig = Partial<Pick<IEventsub, 'enabled' | 'message' | 'endMessage' | 'endEnabled' | 'clipEnabled' | 'minViewers' | 'delay' | 'cheerTiers'>>;

function resolveBitsEventsubConfigValue<K extends keyof EventsubConfig>(
    canonical: Partial<IEventsub> | null,
    legacyEventsubs: Array<Partial<IEventsub>>,
    key: K
): EventsubConfig[K] | undefined {
    const canonicalValue = canonical?.[key] as EventsubConfig[K] | undefined;

    const isCustomValue = (value: EventsubConfig[K] | undefined): boolean => {
        switch (key) {
            case 'enabled':
                return value === false;
            case 'message':
            case 'endMessage':
                return typeof value === 'string' && value.trim().length > 0;
            case 'endEnabled':
            case 'clipEnabled':
                return value === true;
            case 'minViewers':
                return typeof value === 'number' && Number.isFinite(value) && value !== 2;
            case 'delay':
                return typeof value === 'number' && Number.isFinite(value) && value !== 0;
            case 'cheerTiers':
                return Array.isArray(value) && value.length > 0;
            default:
                return false;
        }
    };

    const legacyCustomValue = legacyEventsubs
        .map((legacy) => legacy[key] as EventsubConfig[K] | undefined)
        .find(isCustomValue);
    const legacyValue = legacyCustomValue ?? legacyEventsubs
        .map((legacy) => legacy[key] as EventsubConfig[K] | undefined)
        .find((value) => typeof value !== 'undefined');

    if (isCustomValue(canonicalValue)) {
        return canonicalValue;
    }
    if (typeof legacyCustomValue !== 'undefined') {
        return legacyCustomValue;
    }
    return canonicalValue ?? legacyValue;
}

export function buildBitsEventsubConfig(
    canonical: Partial<IEventsub> | null,
    legacyEventsubs: Array<Partial<IEventsub>>
): EventsubConfig {
    const config: EventsubConfig = {
        enabled: resolveBitsEventsubConfigValue(canonical, legacyEventsubs, 'enabled'),
        message: resolveBitsEventsubConfigValue(canonical, legacyEventsubs, 'message'),
        endMessage: resolveBitsEventsubConfigValue(canonical, legacyEventsubs, 'endMessage'),
        endEnabled: resolveBitsEventsubConfigValue(canonical, legacyEventsubs, 'endEnabled'),
        clipEnabled: resolveBitsEventsubConfigValue(canonical, legacyEventsubs, 'clipEnabled'),
        minViewers: resolveBitsEventsubConfigValue(canonical, legacyEventsubs, 'minViewers'),
        delay: resolveBitsEventsubConfigValue(canonical, legacyEventsubs, 'delay'),
        cheerTiers: resolveBitsEventsubConfigValue(canonical, legacyEventsubs, 'cheerTiers'),
    };

    return Object.fromEntries(
        Object.entries(config).filter(([, value]) => typeof value !== 'undefined')
    ) as EventsubConfig;
}
